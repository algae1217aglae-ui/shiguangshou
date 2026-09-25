import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import { hammingDistanceHex } from '../../image-memory-core.mjs';
import { computePhash, computeSha256, PHASH_VERSION } from './phash.mjs';

async function makePattern(path, variant = 0) {
  const width = 320;
  const height = 240;
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * channels;
    data[i] = variant ? (x * 3 + y * 7) % 256 : (x ^ y) % 256;
    data[i + 1] = variant ? (x * 11 + y) % 256 : (x * 2 + y * 5) % 256;
    data[i + 2] = variant ? (x + y * 13) % 256 : ((x - y) & 255);
  }
  await sharp(data, { raw: { width, height, channels } }).png().toFile(path);
}

test('SHA and pHash distinguish bytes from visual near-duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-phash-'));
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox);
  try {
    const original = join(inbox, 'original.png');
    await makePattern(original);
    copyFileSync(original, join(inbox, 'copy.png'));
    await sharp(original).jpeg({ quality: 65 }).toFile(join(inbox, 'recompressed.jpg'));
    await sharp(original).resize(160, 120).resize(320, 240).png().toFile(join(inbox, 'resized.png'));
    await sharp(original).extract({ left: 10, top: 7, width: 300, height: 226 }).resize(320, 240).png().toFile(join(inbox, 'crop.png'));
    await makePattern(join(inbox, 'negative.png'), 1);

    assert.equal(await computeSha256(original), await computeSha256(join(inbox, 'copy.png')));
    assert.notEqual(await computeSha256(original), await computeSha256(join(inbox, 'recompressed.jpg')));
    const base = await computePhash('inbox/original.png', inbox);
    const recompressed = await computePhash('inbox/recompressed.jpg', inbox);
    const resized = await computePhash('inbox/resized.png', inbox);
    const cropped = await computePhash('inbox/crop.png', inbox);
    const negative = await computePhash('inbox/negative.png', inbox);
    assert.equal(base.phashVersion, PHASH_VERSION);
    assert.equal(base.phash.length, 16);
    assert.equal(base.phashUsable, true);
    assert.ok(hammingDistanceHex(base.phash, recompressed.phash) <= 8);
    assert.ok(hammingDistanceHex(base.phash, resized.phash) <= 8);
    assert.ok(hammingDistanceHex(base.phash, negative.phash) > 8);
    assert.ok(Number.isInteger(hammingDistanceHex(base.phash, cropped.phash)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('low-information images disable pHash matching while identical SHA remains exact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-phash-flat-'));
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox);
  try {
    await sharp({ create: { width: 64, height: 64, channels: 3, background: 'black' } }).png().toFile(join(inbox, 'black.png'));
    copyFileSync(join(inbox, 'black.png'), join(inbox, 'black-copy.png'));
    await sharp({ create: { width: 64, height: 64, channels: 3, background: 'white' } }).png().toFile(join(inbox, 'white.png'));
    const black = await computePhash('inbox/black.png', inbox);
    const white = await computePhash('inbox/white.png', inbox);
    assert.equal(black.phashUsable, false);
    assert.equal(white.phashUsable, false);
    assert.equal(await computeSha256(join(inbox, 'black.png')), await computeSha256(join(inbox, 'black-copy.png')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
