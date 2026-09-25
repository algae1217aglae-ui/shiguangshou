import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import { decodeImage, decodeImageMemoryImage } from './image-input.mjs';

export const PHASH_VERSION = 'phash-dct32-ac63-v1';

export function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function dctCoefficient(values, u, v) {
  const cu = u === 0 ? Math.SQRT1_2 : 1;
  const cv = v === 0 ? Math.SQRT1_2 : 1;
  let sum = 0;
  for (let y = 0; y < 32; y++) {
    const cy = Math.cos(((2 * y + 1) * v * Math.PI) / 64);
    for (let x = 0; x < 32; x++) {
      sum += values[y * 32 + x] * Math.cos(((2 * x + 1) * u * Math.PI) / 64) * cy;
    }
  }
  return 0.0625 * cu * cv * sum;
}

function bitsToHex(bits) {
  let value = 0n;
  for (const bit of bits) value = (value << 1n) | (bit ? 1n : 0n);
  return value.toString(16).padStart(16, '0');
}

export async function computePhash(relativePath, rootsOrInboxDir) {
  const decoded = typeof rootsOrInboxDir === 'string'
    ? await decodeImage(relativePath, rootsOrInboxDir)
    : await decodeImageMemoryImage(relativePath, rootsOrInboxDir);
  const { default: sharp } = await import('sharp');
  const grey = await sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: decoded.channels } })
    .greyscale()
    .resize(32, 32, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .raw()
    .toBuffer();
  let mean = 0;
  for (const value of grey) mean += value;
  mean /= grey.length;
  let variance = 0;
  for (const value of grey) variance += (value - mean) ** 2;
  const standardDeviation = Math.sqrt(variance / grey.length);

  const coefficients = [];
  for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) coefficients.push(dctCoefficient(grey, u, v));
  const ac = coefficients.slice(1).sort((a, b) => a - b);
  const median = ac[Math.floor(ac.length / 2)];
  const bits = coefficients.map((value, index) => index === 0 ? false : value > median);
  return {
    phash: bitsToHex(bits),
    phashVersion: PHASH_VERSION,
    phashUsable: standardDeviation >= 5,
    standardDeviation,
  };
}
