import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

import { createDetectorProcessClient } from '../image-memory/detector-process.mjs';
import { createClipEmbedder } from '../image-memory/embedder.mjs';
import { computeSha256 } from '../image-memory/phash.mjs';
import { cropRegionBlobs, selectOnlineRegions, selectYoloRegions, fixedRegions } from '../image-memory/regions.mjs';
import { decodeImage } from '../image-memory/image-input.mjs';
import { REGION_V1, verifyDetectorManifest } from './detector-spec.mjs';

const enabled = process.env.IMAGE_REGION_MODEL_TEST === '1';
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

async function waitReady(client, deadlineAt) {
  while (!client.ready && Date.now() < deadlineAt) await wait(100);
  assert.equal(client.ready, true, 'detector did not become ready');
}

test('lenient true-model functional smoke feeds bounded YOLO regions into pinned CLIP', { skip: !enabled }, async t => {
  const detectorRoot = dirname(fileURLToPath(new URL(import.meta.url)));
  const runtimeDir = join(detectorRoot, 'runtime');
  const detectorManifestPath = join(runtimeDir, 'detector-manifest.json');
  assert.equal(existsSync(detectorManifestPath), true, 'run prepare-detector before the true-model test');
  const detectorManifest = verifyDetectorManifest(JSON.parse(readFileSync(detectorManifestPath, 'utf8')), { runtimeDir, verifyFiles: true });
  const assetsDir = join(runtimeDir, '.venv', 'Lib', 'site-packages', 'ultralytics', 'assets');
  const busPath = join(assetsDir, 'bus.jpg');
  assert.equal(existsSync(busPath), true, 'wheel-bundled ultralytics/assets/bus.jpg is missing');

  const imageMemoryRoot = resolve(detectorRoot, '..', 'image-memory');
  const clipManifest = JSON.parse(readFileSync(join(imageMemoryRoot, 'model-manifest.json'), 'utf8'));
  const clip = createClipEmbedder({ ...clipManifest, cacheDir: join(imageMemoryRoot, 'model-cache'), localFilesOnly: true });
  const root = mkdtempSync(join(tmpdir(), 'porch-region-model-'));
  const inboxDir = join(root, 'inbox');
  mkdirSync(inboxDir);
  const localBus = join(inboxDir, basename(busPath));
  copyFileSync(busPath, localBus);
  const beforeFiles = readdirSync(inboxDir).sort();
  const client = createDetectorProcessClient({
    command: detectorManifest.pythonPath,
    workerPath: join(detectorRoot, 'detector-worker.py'),
    inboxDir,
    weightPath: detectorManifest.weightPath,
    detectorVersion: REGION_V1.detectorVersion,
    runtimeDir,
    detectorTimeoutMs: Math.max(REGION_V1.detectorTimeoutMs, 5000),
    warmupTimeoutMs: 120000,
    cwd: detectorRoot,
  });
  try {
    const warmStarted = performance.now();
    await Promise.all([clip.warm(), waitReady(client, Date.now() + 120000)]);
    const sha256 = await computeSha256(localBus);
    const detectionStarted = performance.now();
    const detected = await client.detect('inbox/bus.jpg', { expectedSha256: sha256, priority: 'query', deadlineAt: Date.now() + 10000 });
    const detectionMs = performance.now() - detectionStarted;
    assert.ok(detected.detections.every(row => Number.isFinite(row.confidence)));
    assert.ok(detected.detections.some(row => ['bus', 'person'].includes(row.className)));

    const decoded = await decodeImage('inbox/bus.jpg', inboxDir);
    const yolo = selectYoloRegions(detected.detections, decoded, REGION_V1);
    const selected = selectOnlineRegions({ fixed: fixedRegions(decoded), yolo }, REGION_V1);
    assert.ok(selected.length >= 1 && selected.length <= 5);
    assert.ok(selected.filter(item => item.channel === 'yolo').length <= 3);
    const cropStarted = performance.now();
    const crops = await cropRegionBlobs(decoded, selected);
    const vectors = [];
    for (const crop of crops) vectors.push(await clip.embed(new Blob([crop], { type: 'image/png' })));
    const firstCombinedMs = performance.now() - cropStarted;
    const warmStartedAt = performance.now();
    for (const crop of crops) await clip.embed(new Blob([crop], { type: 'image/png' }));
    const warmCombinedMs = performance.now() - warmStartedAt;
    assert.equal(vectors.length, selected.length);
    assert.ok(vectors.every(vector => vector.length === 512));
    assert.deepEqual(readdirSync(inboxDir).sort(), beforeFiles, 'detector or crop pipeline persisted an output image');
    t.diagnostic(JSON.stringify({
      scope: 'lenient-functional-smoke-not-production-latency-or-socket-audit',
      warmupMs: Math.round((performance.now() - warmStarted) * 10) / 10,
      detectionMs: Math.round(detectionMs * 10) / 10,
      firstCombinedMs: Math.round(firstCombinedMs * 10) / 10,
      warmCombinedMs: Math.round(warmCombinedMs * 10) / 10,
      rawDetections: detected.rawDetectionCount,
      selectedChannels: selected.map(item => item.channel),
      rssBytes: process.memoryUsage().rss,
    }));
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
