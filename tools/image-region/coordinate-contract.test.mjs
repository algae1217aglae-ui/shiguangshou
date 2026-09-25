import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { decodeImage } from '../image-memory/image-input.mjs';
import { cropRegionBlobs } from '../image-memory/regions.mjs';

const requireImageMemory = createRequire(new URL('../image-memory/package.json', import.meta.url));
const sharp = requireImageMemory('sharp');
const python = process.env.IMAGE_REGION_PYTHON;
const helper = fileURLToPath(new URL('./test-fixtures/coordinate_fixture.py', import.meta.url));

test('Python auto-oriented detector coordinates crop the same pixels in Sharp', { skip: !python }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'porch-coordinate-contract-'));
  const inboxDir = join(root, 'inbox');
  mkdirSync(inboxDir);
  try {
    const width = 20;
    const height = 10;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const red = x < 5 && y < 5;
      pixels[offset] = red ? 255 : 0;
      pixels[offset + 1] = 0;
      pixels[offset + 2] = red ? 0 : 255;
    }
    const path = join(inboxDir, 'oriented.jpg');
    await sharp(pixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .withMetadata({ orientation: 6 })
      .toFile(path);
    const beforeFiles = readdirSync(inboxDir).sort();
    const result = JSON.parse(execFileSync(python, [helper, inboxDir, 'inbox/oriented.jpg'], { encoding: 'utf8', windowsHide: true }));
    assert.deepEqual([result.orientedWidth, result.orientedHeight], [10, 20]);
    assert.equal(result.detections.length, 1);
    const decoded = await decodeImage('inbox/oriented.jpg', inboxDir);
    assert.deepEqual([decoded.width, decoded.height], [result.orientedWidth, result.orientedHeight]);
    const [crop] = await cropRegionBlobs(decoded, [{
      regionId: 'python-box', channel: 'yolo', bbox: result.detections[0].bbox,
      classId: 41, className: 'cup', detectorConfidence: 0.99,
    }]);
    const stats = await sharp(crop).stats();
    assert.ok(stats.channels[0].mean > stats.channels[2].mean + 100, 'the Python box should retain the red target after the Sharp crop');
    assert.deepEqual(readdirSync(inboxDir).sort(), beforeFiles, 'the coordinate contract must not persist crop files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
