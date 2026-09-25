import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

import { createDetectorProcessClient } from '../image-memory/detector-process.mjs';
import { createClipEmbedder } from '../image-memory/embedder.mjs';
import { computeSha256 } from '../image-memory/phash.mjs';
import { cropRegionBlobs, fixedRegions, selectOnlineRegions, selectYoloRegions } from '../image-memory/regions.mjs';
import { decodeImage } from '../image-memory/image-input.mjs';
import { REGION_V1, verifyDetectorManifest } from './detector-spec.mjs';

const enabled = process.env.IMAGE_REGION_MODEL_TEST === '1';
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

async function waitReady(client, deadlineAt) {
  while (!client.ready && Date.now() < deadlineAt) await wait(25);
  assert.equal(client.ready, true, 'detector did not become ready after its real forward warmup');
}

function snapshotTree(root) {
  if (!root || !existsSync(root)) return null;
  const rows = [];
  const visit = (path, relative = '') => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) { rows.push(['link', relative]); return; }
    if (!info.isDirectory()) { rows.push(['file', relative, info.size, info.mtimeMs]); return; }
    rows.push(['dir', relative]);
    for (const name of readdirSync(path).sort()) visit(join(path, name), relative ? `${relative}/${name}` : name);
  };
  visit(root);
  return rows;
}

function snapshotKnownHomeSideEffects() {
  const targets = [...new Set([
    join(homedir(), '.config', 'Ultralytics'),
    join(homedir(), '.cache', 'Ultralytics'),
    join(homedir(), '.cache', 'torch'),
    process.env.APPDATA && join(process.env.APPDATA, 'Ultralytics'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Ultralytics'),
  ].filter(Boolean).map(value => resolve(value)))];
  return Object.fromEntries(targets.map(path => [path, snapshotTree(path)]));
}

test('true model meets direct production budgets with guarded Python sockets and unchanged known home cache locations', { skip: !enabled }, async t => {
  const detectorRoot = dirname(fileURLToPath(new URL(import.meta.url)));
  const runtimeDir = join(detectorRoot, 'runtime');
  const manifestPath = join(runtimeDir, 'detector-manifest.json');
  const manifest = verifyDetectorManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), { runtimeDir, verifyFiles: true });
  const busPath = join(runtimeDir, '.venv', 'Lib', 'site-packages', 'ultralytics', 'assets', 'bus.jpg');
  assert.equal(existsSync(busPath), true);

  const imageMemoryRoot = resolve(detectorRoot, '..', 'image-memory');
  const clipManifest = JSON.parse(readFileSync(join(imageMemoryRoot, 'model-manifest.json'), 'utf8'));
  const clip = createClipEmbedder({ ...clipManifest, cacheDir: join(imageMemoryRoot, 'model-cache'), localFilesOnly: true });
  const root = mkdtempSync(join(tmpdir(), 'porch-region-production-'));
  const inboxDir = join(root, 'inbox');
  mkdirSync(inboxDir);
  for (const name of ['first.jpg', 'active.jpg', 'queued.jpg', 'query.jpg']) copyFileSync(busPath, join(inboxDir, name));
  const beforeFiles = readdirSync(inboxDir).sort();
  const homeBefore = snapshotKnownHomeSideEffects();
  const client = createDetectorProcessClient({
    command: manifest.pythonPath,
    workerPath: join(detectorRoot, 'detector-worker.py'),
    inboxDir,
    weightPath: manifest.weightPath,
    detectorVersion: REGION_V1.detectorVersion,
    runtimeDir,
    detectorTimeoutMs: REGION_V1.detectorTimeoutMs,
    warmupTimeoutMs: 120000,
    cwd: detectorRoot,
  });
  try {
    const warmStartedAt = performance.now();
    await Promise.all([clip.warm(), waitReady(client, Date.now() + 120000)]);
    const readyAfterMs = performance.now() - warmStartedAt;
    const sha256 = await computeSha256(join(inboxDir, 'first.jpg'));
    const firstBlob = new Blob([readFileSync(join(inboxDir, 'first.jpg'))], { type: 'image/jpeg' });

    const fullQueryStartedAt = performance.now();
    const detectionStartedAt = performance.now();
    const [detected, wholeVector] = await Promise.all([
      client.detect('inbox/first.jpg', { expectedSha256: sha256, priority: 'query', deadlineAt: Date.now() + 2500 }),
      clip.embed(firstBlob),
    ]);
    const firstDetectionMs = performance.now() - detectionStartedAt;
    assert.ok(firstDetectionMs < REGION_V1.detectorTimeoutMs, `first detection ${firstDetectionMs}ms exceeded ${REGION_V1.detectorTimeoutMs}ms`);
    assert.equal(detected.networkAttemptCount, 0);
    assert.equal(wholeVector.length, 512);

    const decoded = await decodeImage('inbox/first.jpg', inboxDir);
    const yolo = selectYoloRegions(detected.detections, decoded, REGION_V1);
    const selected = selectOnlineRegions({ fixed: fixedRegions(decoded), yolo }, REGION_V1);
    const crops = await cropRegionBlobs(decoded, selected);
    const vectors = [];
    for (const crop of crops) vectors.push(await clip.embed(new Blob([crop], { type: 'image/png' })));
    const firstFullQueryMs = performance.now() - fullQueryStartedAt;
    assert.ok(firstFullQueryMs < 2500, `full query ${firstFullQueryMs}ms exceeded 2500ms`);
    assert.ok(vectors.length >= 1 && vectors.length <= 5);
    assert.ok(vectors.every(vector => vector.length === 512));

    const warmDetectionMs = [];
    for (let index = 0; index < 5; index++) {
      const startedAt = performance.now();
      const result = await client.detect('inbox/first.jpg', { expectedSha256: sha256, priority: 'query', deadlineAt: Date.now() + 2500 });
      warmDetectionMs.push(performance.now() - startedAt);
      assert.equal(result.networkAttemptCount, 0);
    }
    assert.ok(Math.max(...warmDetectionMs) < REGION_V1.detectorTimeoutMs);

    const order = [];
    const active = client.detect('inbox/active.jpg', { expectedSha256: sha256, priority: 'background', deadlineAt: Date.now() + 2500 }).then(result => { order.push('active'); return result; });
    const queued = client.detect('inbox/queued.jpg', { expectedSha256: sha256, priority: 'background', deadlineAt: Date.now() + 2500 }).then(result => { order.push('queued'); return result; });
    const busyQueryStartedAt = performance.now();
    const query = client.detect('inbox/query.jpg', { expectedSha256: sha256, priority: 'query', deadlineAt: Date.now() + 2500 }).then(result => { order.push('query'); return result; });
    const queryResult = await query;
    const busyQueryMs = performance.now() - busyQueryStartedAt;
    const [activeResult, queuedResult] = await Promise.all([active, queued]);
    assert.deepEqual(order, ['active', 'query', 'queued']);
    assert.ok(busyQueryMs < 2500, `busy query ${busyQueryMs}ms exceeded 2500ms`);
    assert.equal(queryResult.networkAttemptCount, 0);
    assert.equal(activeResult.networkAttemptCount, 0);
    assert.equal(queuedResult.networkAttemptCount, 0);

    assert.deepEqual(readdirSync(inboxDir).sort(), beforeFiles, 'production audit persisted a derived image');
    t.diagnostic(JSON.stringify({
      scope: 'production-900ms-detector-and-2500ms-shared-query-audit',
      readyAfterRealForwardMs: Math.round(readyAfterMs * 10) / 10,
      firstDetectionMs: Math.round(firstDetectionMs * 10) / 10,
      firstFullQueryMs: Math.round(firstFullQueryMs * 10) / 10,
      warmDetectionMs: warmDetectionMs.map(value => Math.round(value * 10) / 10),
      busyQueryMs: Math.round(busyQueryMs * 10) / 10,
      networkAttemptCount: queryResult.networkAttemptCount,
      rawDetections: detected.rawDetectionCount,
      selectedChannels: selected.map(item => item.channel),
    }));
  } finally {
    await client.close();
    assert.deepEqual(snapshotKnownHomeSideEffects(), homeBefore, 'detector inference changed a known user-home cache/config location');
    rmSync(root, { recursive: true, force: true });
  }
});
