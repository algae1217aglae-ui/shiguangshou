import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

import { createEmbeddingWorker } from './embedding-worker.mjs';

const manifest = {
  modelId: 'test/model', revision: '0123456789abcdef0123456789abcdef01234567', dtype: 'fp32',
  libraryVersion: '4.3.0', preprocessVersion: 'clip-center224-v1', embeddingVersion: 'clip-test-v1',
};

test('embedding worker validates inbox paths and returns only normalized arrays for its version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-embedding-worker-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  writeFileSync(join(inboxDir, 'a.png'), 'fixture');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  let inputPath = null;
  const worker = createEmbeddingWorker({
    inboxDir, manifestPath: join(dir, 'manifest.json'), cacheDir: join(dir, 'cache'),
    embedderFactory: () => ({ loaded: true, async embed(path) { inputPath = path; return new Float32Array([0.6, 0.8]); } }),
  });
  try {
    const result = await worker.handle({ id: '1', op: 'embed', relativePath: 'inbox/a.png', embeddingVersion: 'clip-test-v1' });
    assert.deepEqual(result, { embedding: [0.6000000238418579, 0.800000011920929], embeddingVersion: 'clip-test-v1' });
    assert.equal(inputPath, realpathSync(join(inboxDir, 'a.png')));
    await assert.rejects(worker.handle({ id: '2', op: 'embed', relativePath: '../a.png', embeddingVersion: 'clip-test-v1' }), error => error.code === 'IMAGE_PATH_INVALID');
    await assert.rejects(worker.handle({ id: '3', op: 'embed', relativePath: 'inbox/a.png', embeddingVersion: 'old' }), error => error.code === 'MODEL_VERSION_MISMATCH');
    assert.deepEqual(await worker.handle({ id: '4', op: 'stats' }), { loaded: true, embeddingVersion: 'clip-test-v1' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing or mutable manifest fails closed without constructing a model', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-embedding-manifest-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  let made = 0;
  try {
    assert.throws(() => createEmbeddingWorker({ inboxDir, manifestPath: join(dir, 'missing.json'), cacheDir: join(dir, 'cache'), embedderFactory: () => { made++; } }), error => error.code === 'MODEL_UNAVAILABLE');
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ ...manifest, revision: 'main' }));
    assert.throws(() => createEmbeddingWorker({ inboxDir, manifestPath: join(dir, 'bad.json'), cacheDir: join(dir, 'cache'), embedderFactory: () => { made++; } }), error => error.code === 'MODEL_UNAVAILABLE');
    assert.equal(made, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('embedding worker decodes once and returns at most five in-memory region embeddings for the expected SHA', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-embedding-regions-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  const imagePath = join(inboxDir, 'regions.jpg');
  await sharp({ create: { width: 80, height: 60, channels: 3, background: 'red' } }).jpeg().toFile(imagePath);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const expectedSha256 = createHash('sha256').update(readFileSync(imagePath)).digest('hex');
  const inputs = [];
  const worker = createEmbeddingWorker({
    inboxDir, manifestPath: join(dir, 'manifest.json'), cacheDir: join(dir, 'cache'),
    embedderFactory: () => ({
      async embed(input) {
        inputs.push(input);
        assert.ok(input instanceof Blob);
        assert.equal(input.type, 'image/png');
        return new Float32Array([inputs.length === 1 ? 1 : 0, inputs.length === 2 ? 1 : 0]);
      },
    }),
  });
  const descriptors = [
    { regionId: 'fixed:a', channel: 'fixed', bbox: { x: 0, y: 0, width: 0.5, height: 0.5 }, classId: null, className: null, detectorConfidence: null },
    { regionId: 'yolo:b', channel: 'yolo', bbox: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, classId: 41, className: 'cup', detectorConfidence: 0.8 },
  ];
  try {
    const result = await worker.handle({
      id: 'r1', op: 'embed_regions', relativePath: 'inbox/regions.jpg', descriptors,
      expectedSha256, embeddingVersion: manifest.embeddingVersion,
    });
    assert.equal(inputs.length, 2);
    assert.deepEqual(result.embeddings, [[1, 0], [0, 1]]);
    assert.equal(result.sourceSha256, expectedSha256);
    await assert.rejects(worker.handle({
      id: 'r2', op: 'embed_regions', relativePath: 'inbox/regions.jpg', descriptors,
      expectedSha256: '0'.repeat(64), embeddingVersion: manifest.embeddingVersion,
    }), error => error.code === 'IMAGE_CHANGED_DURING_READ');
    await assert.rejects(worker.handle({
      id: 'r3', op: 'embed_regions', relativePath: 'inbox/regions.jpg', descriptors: Array(6).fill(descriptors[0]),
      expectedSha256, embeddingVersion: manifest.embeddingVersion,
    }), error => error.code === 'IMAGE_REGION_INVALID');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
