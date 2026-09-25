import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { cosineSimilarityFloat32 } from '../../image-memory-core.mjs';
import { createClipEmbedder } from './embedder.mjs';
import { createImageMemoryClient } from '../../image-memory.mjs';

function directoryBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
  }
  return total;
}

test('real pinned CLIP model ranks a recompressed copy above an unrelated image', { skip: process.env.IMAGE_MEMORY_MODEL_TEST !== '1' }, async t => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const cacheDir = join(root, 'model-cache');
  const manifest = JSON.parse(readFileSync(join(root, 'model-manifest.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'porch-model-integration-'));
  const original = join(dir, 'original.png');
  const copy = join(dir, 'copy.jpg');
  const negative = join(dir, 'negative.png');
  const width = 256, height = 256, channels = 3;
  const one = Buffer.alloc(width * height * channels);
  const two = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    one[i] = (x * 5 + y) & 255; one[i + 1] = (y * 7) & 255; one[i + 2] = ((x ^ y) * 3) & 255;
    two[i] = ((x >> 4) % 2) * 255; two[i + 1] = ((y >> 4) % 2) * 255; two[i + 2] = 32;
  }
  try {
    await sharp(one, { raw: { width, height, channels } }).png().toFile(original);
    await sharp(original).jpeg({ quality: 55 }).toFile(copy);
    await sharp(two, { raw: { width, height, channels } }).png().toFile(negative);
    const embedder = createClipEmbedder({ ...manifest, cacheDir, localFilesOnly: true });
    const rssBefore = process.memoryUsage().rss;
    const coldStart = performance.now();
    const originalEmbedding = await embedder.embed(original);
    const coldMs = performance.now() - coldStart;
    const warmStart = performance.now();
    const copyEmbedding = await embedder.embed(copy);
    const negativeEmbedding = await embedder.embed(negative);
    const warmPairMs = performance.now() - warmStart;
    const sameScore = cosineSimilarityFloat32(originalEmbedding, copyEmbedding);
    const negativeScore = cosineSimilarityFloat32(originalEmbedding, negativeEmbedding);
    const warmEightStart = performance.now();
    for (let index = 0; index < 8; index++) await embedder.embed(index % 2 === 0 ? copy : negative);
    const warmEightMs = performance.now() - warmEightStart;
    assert.equal(originalEmbedding.length, 512);
    assert.ok(sameScore > negativeScore, `same=${sameScore} negative=${negativeScore}`);
    t.diagnostic(JSON.stringify({ revision: manifest.revision, dtype: manifest.dtype, embeddingVersion: manifest.embeddingVersion, cacheBytes: directoryBytes(cacheDir), coldMs: Math.round(coldMs), warmPairMs: Math.round(warmPairMs), warmEightMs: Math.round(warmEightMs), rssDeltaBytes: process.memoryUsage().rss - rssBefore, sameScore, negativeScore }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real hash worker and embedding sidecar exchange JSON-lines and persist a 512d vector', { skip: process.env.IMAGE_MEMORY_MODEL_TEST !== '1' }, async () => {
  const toolRoot = fileURLToPath(new URL('.', import.meta.url));
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'porch-model-sidecar-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  const imagePath = join(inboxDir, 'one.png');
  const pixels = Buffer.alloc(224 * 224 * 3);
  for (let i = 0; i < pixels.length; i += 3) { pixels[i] = (i / 3) & 255; pixels[i + 1] = ((i / 3) >> 4) & 255; pixels[i + 2] = 160; }
  await sharp(pixels, { raw: { width: 224, height: 224, channels: 3 } }).png().toFile(imagePath);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  const client = createImageMemoryClient({
    enabled: true, cwd: projectRoot, inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath,
    workerPath: join(toolRoot, 'worker.mjs'), embeddingWorkerPath: join(toolRoot, 'embedding-worker.mjs'),
    manifestPath: join(toolRoot, 'model-manifest.json'), cacheDir: join(toolRoot, 'model-cache'), timeoutMs: 5000,
  });
  try {
    await client.stats();
    const warmDeadline = Date.now() + 120000;
    let indexed;
    do {
      indexed = await client.backfill([{ occurrenceId: 'old', relativePath: 'inbox/one.png', sourceTs: 100, sourceText: 'fixture' }]);
      if (indexed.pendingEmbedding === 0 || Date.now() >= warmDeadline) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    } while (true);
    assert.equal(indexed.failed, 0);
    assert.equal(indexed.pendingEmbedding, 0);
    const stats = await client.stats();
    assert.equal(stats.pendingEmbedding, 0);
    assert.equal(stats.images, 1);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
