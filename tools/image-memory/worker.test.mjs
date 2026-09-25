import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import sharp from 'sharp';

import { createImageMemoryWorker, orderCandidatesForValidation, orderUnconfirmedCandidatesForValidation, queryDeadlineBudget, verifyImageAccessAfterHash } from './worker.mjs';
import { createImageMemoryClient } from '../../image-memory.mjs';
import { rankImageCandidatesForRecallSemantics, rankImageCandidatesForThresholds } from '../../image-memory-core.mjs';
import { REGION_V1 } from '../image-region/detector-spec.mjs';

async function makeImage(path, variant = 0) {
  const width = 256, height = 192, channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 3;
    data[i] = variant ? (x * 7 + y * 3) & 255 : (x ^ y) & 255;
    data[i + 1] = variant ? (x + y * 11) & 255 : (x * 3 + y) & 255;
    data[i + 2] = variant ? (x * 13 - y) & 255 : (x + y * 5) & 255;
  }
  await sharp(data, { raw: { width, height, channels } }).png().toFile(path);
}

test('busy recall reserves deadline for ranked candidate validation without changing the request deadline', () => {
  const plan = queryDeadlineBudget(1000, 2500, 3500);
  assert.deepEqual(plan, { deadlineAt: 3500, visualDeadlineAt: 3000, reserveMs: 500 });
});

test('candidate validation starts with deliverable evidence and skips below-threshold corpus rows', () => {
  const low = Array.from({ length: 57 }, (_, index) => ({
    occurrenceId: `low-${index}`, relativePath: `inbox/low-${index}.png`, sha256: `low-${index}`,
    sourceTs: index + 1, queryIds: ['q'], wholeCosine: 0.5, fixedCosine: 0.6, yoloCosine: null,
  }));
  const expected = {
    occurrenceId: 'expected', relativePath: 'inbox/expected.png', sha256: 'expected',
    sourceTs: 100, queryIds: ['q'], wholeCosine: 0.89, fixedCosine: 0.91, yoloCosine: null,
  };
  const ordered = orderCandidatesForValidation([...low, expected], {
    beforeTs: 200, excludeOccurrenceIds: [], maxHits: 3, pHashMaxDistance: 8,
    visualMinScore: 0.88, wholeVisualMinScore: 0.88, fixedVisualMinScore: 0.88, yoloVisualMinScore: 0.88,
  });
  assert.deepEqual(ordered.map(row => row.occurrenceId), ['expected']);
});

test('angle candidate validation is bounded to each query whole/fixed top-three union', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    occurrenceId: `c-${index}`, relativePath: `inbox/c-${index}.png`, sha256: `sha-${index}`,
    sourceTs: index + 1, queryIds: ['q'], queryId: 'q',
    wholeCosine: 1 - index / 100, fixedCosine: 0.5 + index / 100,
    queryEvidence: [{ queryId: 'q', wholeCosine: 1 - index / 100, fixedCosine: 0.5 + index / 100 }],
  }));
  const ordered = orderUnconfirmedCandidatesForValidation(rows, { beforeTs: 100, excludeOccurrenceIds: [], strictMatches: [] });
  assert.deepEqual(new Set(ordered.map(row => row.sha256)), new Set(['sha-0', 'sha-1', 'sha-2', 'sha-17', 'sha-18', 'sha-19']));
  assert.equal(ordered.length, 6);
});

async function fixture(run, { visual = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath,
    embeddingVersion: visual ? 'fake-v1' : null,
    embedImage: visual ? async relativePath => relativePath.includes('negative') ? new Float32Array([0, 1]) : new Float32Array([1, 0]) : null,
  });
  try { await run({ dir, inboxDir, policyPath, worker }); } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
}

const source = (path, id, ts, text = '') => ({ occurrenceId: id, queryId: id, relativePath: `inbox/${path}`, sourceTs: ts, sourceText: text });
const limits = { maxHits: 3, pHashMaxDistance: 8, visualMinScore: 0.88 };

test('worker indexes idempotently and recalls exact, recompressed, resized, and visual crop matches', async () => {
  await fixture(async ({ inboxDir, worker }) => {
    await makeImage(join(inboxDir, 'old.png'));
    await sharp(join(inboxDir, 'old.png')).jpeg({ quality: 65 }).toFile(join(inboxDir, 'recompressed.jpg'));
    await sharp(join(inboxDir, 'old.png')).resize(128, 96).resize(256, 192).png().toFile(join(inboxDir, 'resized.png'));
    await sharp(join(inboxDir, 'old.png')).extract({ left: 8, top: 6, width: 240, height: 180 }).resize(256, 192).png().toFile(join(inboxDir, 'crop.png'));
    await makeImage(join(inboxDir, 'negative.png'), 1);
    const first = await worker.handle({ id: 'i1', op: 'backfill', sources: [source('old.png', 'old', 100, 'the old image')], deadlineMs: 5000 });
    assert.deepEqual(first, { indexed: 1, unchanged: 0, pendingEmbedding: 0, failed: 0, codes: [] });
    const second = await worker.handle({ id: 'i2', op: 'backfill', sources: [source('old.png', 'old', 100, 'the old image')], deadlineMs: 5000 });
    assert.equal(second.unchanged, 1);

    for (const [file, expected] of [['old.png', ['exact']], ['recompressed.jpg', ['near_duplicate']], ['resized.png', ['exact', 'near_duplicate']], ['crop.png', ['near_duplicate', 'visual']]]) {
      const result = await worker.handle({ id: `r-${file}`, op: 'recall', queries: [{ queryId: file, occurrenceId: `new-${file}`, relativePath: `inbox/${file}` }], beforeTs: 200, excludeOccurrenceIds: [`new-${file}`], deadlineMs: 5000, limits });
      assert.equal(result.matches[0]?.occurrenceId, 'old', file);
      assert.ok(expected.includes(result.matches[0]?.kind), `${file}: ${result.matches[0]?.kind}`);
    }
    const negative = await worker.handle({ id: 'negative', op: 'recall', queries: [{ queryId: 'negative', occurrenceId: 'new-negative', relativePath: 'inbox/negative.png' }], beforeTs: 200, excludeOccurrenceIds: [], deadlineMs: 5000, limits });
    assert.deepEqual(negative.matches, []);
  }, { visual: true });
});

test('worker keeps strict 0.88 unchanged and emits production-channel angle candidates only when enabled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-angle-'));
  const inboxDir = join(dir, 'inbox');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'old.png'));
  await makeImage(join(inboxDir, 'query.png'), 1);
  let queryScore = 0.82;
  const vector = relativePath => {
    const value = new Float32Array(512);
    value[0] = relativePath.endsWith('old.png') ? 1 : queryScore;
    value[1] = relativePath.endsWith('old.png') ? 0 : Math.sqrt(1 - queryScore * queryScore);
    return value;
  };
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'fake-angle-v1',
    embedImage: async relativePath => vector(relativePath),
    regionConfig: { ...REGION_V1, yoloEnabled: false, fixedFeatureVersion: 'fixed-angle-v1', yoloFeatureVersion: 'yolo-angle-v1' },
    embedRegions: async (relativePath, descriptors) => descriptors.map(() => vector(relativePath)),
  });
  const request = {
    op: 'recall', queries: [{ queryId: 'q', occurrenceId: 'query', relativePath: 'inbox/query.png' }],
    beforeTs: 200, excludeOccurrenceIds: ['query'], deadlineMs: 2500,
  };
  try {
    const seeded = await worker.handle({ id: 'seed-angle', op: 'backfill', sources: [source('old.png', 'old', 100)], deadlineMs: 5000 });
    assert.equal(seeded.pendingRegions, 0, JSON.stringify(seeded));
    assert.equal((await worker.handle({ id: 'angle-stats', op: 'stats' })).fixedSets, 1);
    const off = await worker.handle({ id: 'angle-off', ...request, limits: { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88 } });
    assert.deepEqual(off.matches, []);
    assert.equal(Object.hasOwn(off, 'unconfirmedCandidates'), false);

    const diagnostic = await worker.handle({ id: 'angle-raw', ...request, op: 'evaluate', topK: 10, applyThresholds: false, regionMode: 'combined', limits: { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88 } });
    const raw = diagnostic.candidates.find(row => row.occurrenceId === 'old');
    assert.equal(Number(raw.wholeCosine.toFixed(6)), 0.82);
    assert.equal(Number(raw.fixedCosine.toFixed(6)), 0.82);

    const on = await worker.handle({ id: 'angle-on', ...request, limits: { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88, angleFallbackEnabled: true } });
    assert.deepEqual(on.matches, []);
    assert.equal(on.unconfirmedCandidates.length, 1, JSON.stringify(on));
    assert.equal(on.unconfirmedCandidates[0].candidateType, 'unconfirmed_angle');
    assert.equal(on.unconfirmedCandidates[0].confidence, 'unconfirmed');
    assert.equal(on.unconfirmedCandidatePool.length, 1);
    assert.equal(on.unconfirmedCandidatePool[0].queryEvidence[0].queryRelativePath, 'inbox/query.png');
    assert.equal(Number(on.unconfirmedCandidates[0].queryEvidence[0].whole.score.toFixed(6)), 0.82);
    assert.equal(Number(on.unconfirmedCandidates[0].queryEvidence[0].fixed.score.toFixed(6)), 0.82);
    assert.equal(on.unconfirmedCandidates[0].sources.length, 1);
    queryScore = 0.79;
    const below = await worker.handle({ id: 'angle-below-minimum', ...request, limits: { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88, angleFallbackEnabled: true } });
    assert.deepEqual(below.matches, []);
    assert.deepEqual(below.unconfirmedCandidates, []);
    assert.equal(below.unconfirmedCandidatePool.length, 1, 'raw diagnostics remain available without becoming attachments');
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('angle selector failure is isolated and preserves already validated strict results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-angle-selector-failure-'));
  const inboxDir = join(dir, 'inbox');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'same.png'));
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath,
    angleCandidateRanker: () => { throw Object.assign(new Error('synthetic selector fault'), { code: 'ANGLE_SELECTOR_FAULT' }); },
  });
  try {
    await worker.handle({ id: 'seed', op: 'index', sources: [source('same.png', 'old', 100)], deadlineMs: 5000 });
    const result = await worker.handle({
      id: 'recall', op: 'recall', queries: [{ queryId: 'q', occurrenceId: 'new', relativePath: 'inbox/same.png' }],
      beforeTs: 200, excludeOccurrenceIds: ['new'], deadlineMs: 2500,
      limits: { maxHits: 3, pHashMaxDistance: 8, visualMinScore: 0.88, angleFallbackEnabled: true },
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].kind, 'exact');
    assert.deepEqual(result.unconfirmedCandidates, []);
    assert.ok(result.warnings.includes('ANGLE_SELECTOR_FAULT'));
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('worker rehashes a strict source after angle validation changes its bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-angle-strict-rehash-'));
  const inboxDir = join(dir, 'inbox');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'strict.png'));
  copyFileSync(join(inboxDir, 'strict.png'), join(inboxDir, 'strict-query.png'));
  await makeImage(join(inboxDir, 'angle-old.png'), 1);
  await sharp({ create: { width: 256, height: 192, channels: 3, background: { r: 10, g: 90, b: 210 } } }).png().toFile(join(inboxDir, 'angle-query.png'));
  const vector = relativePath => {
    const value = new Float32Array(512);
    if (relativePath.includes('angle-old')) { value[0] = 1; return value; }
    if (relativePath.includes('angle-query')) { value[0] = 0.8; value[1] = 0.6; return value; }
    value[2] = 1; return value;
  };
  let replaced = false;
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'strict-rehash-v1',
    embedImage: async relativePath => vector(relativePath),
    regionConfig: { ...REGION_V1, yoloEnabled: false, fixedFeatureVersion: 'strict-rehash-fixed-v1', yoloFeatureVersion: 'strict-rehash-yolo-v1' },
    embedRegions: async (relativePath, descriptors) => descriptors.map(() => vector(relativePath)),
    onImageRead: async ({ stage, relativePath }) => {
      if (!replaced && stage === 'candidate-hash' && relativePath === 'inbox/angle-old.png') {
        replaced = true;
        await makeImage(join(inboxDir, 'strict.png'), 1);
      }
    },
  });
  try {
    await worker.handle({ id: 'seed', op: 'backfill', sources: [source('strict.png', 'strict-old', 100), source('angle-old.png', 'angle-old', 101)], deadlineMs: 5000 });
    const result = await worker.handle({
      id: 'recall', op: 'recall',
      queries: [
        { queryId: 'strict-q', occurrenceId: 'strict-new', relativePath: 'inbox/strict-query.png' },
        { queryId: 'angle-q', occurrenceId: 'angle-new', relativePath: 'inbox/angle-query.png' },
      ],
      beforeTs: 200, excludeOccurrenceIds: ['strict-new', 'angle-new'], deadlineMs: 2500,
      limits: { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88, angleFallbackEnabled: true },
    });
    assert.equal(replaced, true);
    assert.equal(result.matches.some(row => row.occurrenceId === 'strict-old'), false, JSON.stringify(result));
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('worker excludes self and future records and read-only evaluate does not mutate stats', async () => {
  await fixture(async ({ inboxDir, worker }) => {
    await makeImage(join(inboxDir, 'a.png'));
    await worker.handle({ id: 'i', op: 'index', sources: [source('a.png', 'old', 100), source('a.png', 'self', 200)], deadlineMs: 5000 });
    const before = await worker.handle({ id: 's1', op: 'stats' });
    const result = await worker.handle({ id: 'e', op: 'evaluate', queries: [{ queryId: 'q', occurrenceId: 'self', relativePath: 'inbox/a.png' }], beforeTs: 200, excludeOccurrenceIds: ['self'], topK: 10, applyThresholds: false, deadlineMs: 5000, limits });
    assert.deepEqual(result.matches.map(row => row.occurrenceId), ['old']);
    assert.deepEqual(await worker.handle({ id: 's2', op: 'stats' }), before);
  });
});

test('worker stats expose anonymous detector readiness for background diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-detector-stats-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  const detectorClient = {
    ready: false,
    stats: () => ({
      ready: false, queued: 0, cooldownUntil: 1234, lastErrorCode: 'DETECTOR_WARMING',
      lastExitCode: 23, lastExitSignal: null, lastStderrCategory: 'resource_exhausted', lastSpawnErrorCode: 'ENOMEM',
      lastFatalErrorCode: 'DETECTOR_PROCESS_EXITED',
    }),
    close: async () => {},
  };
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'fake-v1',
    embeddingClient: { ready: false, queued: 3, close: async () => {} }, regionConfig: REGION_V1, detectorClient,
  });
  try {
    const stats = await worker.handle({ id: 'stats', op: 'stats' });
    assert.deepEqual(stats.detector, {
      configured: true, ready: false, queued: 0, cooldownUntil: 1234, lastErrorCode: 'DETECTOR_WARMING',
      lastExitCode: 23, lastExitSignal: null, lastStderrCategory: 'resource_exhausted', lastSpawnErrorCode: 'ENOMEM',
      lastFatalErrorCode: 'DETECTOR_PROCESS_EXITED',
    });
    assert.deepEqual(stats.embedding, { configured: true, ready: false, queued: 3 });
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('worker source snapshots commit atomically with CAS and remove only missing memberships', async () => {
  await fixture(async ({ inboxDir, worker }) => {
    await makeImage(join(inboxDir, 'a.png'));
    await worker.handle({ id: 'seed', op: 'index', sources: [source('a.png', 'legacy', 1)], deadlineMs: 5000 });
    await worker.handle({ id: 'begin', op: 'source_sync_begin', snapshotId: 'album-1', sourceType: 'album', revision: 'r1', baseGeneration: 0, baseRevision: null, mode: 'complete' });
    await worker.handle({ id: 'batch', op: 'source_sync_batch', snapshotId: 'album-1', memberships: [
      { membershipId: 'album:a:i1', sourceType: 'album', sourceId: 'a', relativePath: 'inbox/a.png', sourceTs: 10, sourceText: 'one', sourceRevision: 'r1', metadata: { albumName: 'A' } },
      { membershipId: 'album:b:i2', sourceType: 'album', sourceId: 'b', relativePath: 'inbox/a.png', sourceTs: 11, sourceText: 'two', sourceRevision: 'r1', metadata: { albumName: 'B' } },
    ], messages: [] });
    assert.equal((await worker.handle({ id: 'commit', op: 'source_sync_commit', snapshotId: 'album-1' })).generation, 1);
    await worker.handle({ id: 'begin2', op: 'source_sync_begin', snapshotId: 'album-2', sourceType: 'album', revision: 'r2', baseGeneration: 1, baseRevision: 'r1', mode: 'complete' });
    await worker.handle({ id: 'batch2', op: 'source_sync_batch', snapshotId: 'album-2', memberships: [
      { membershipId: 'album:b:i2', sourceType: 'album', sourceId: 'b', relativePath: 'inbox/a.png', sourceTs: 11, sourceText: 'new', sourceRevision: 'r2', metadata: { albumName: 'B2' } },
    ], messages: [] });
    assert.equal((await worker.handle({ id: 'commit2', op: 'source_sync_commit', snapshotId: 'album-2' })).generation, 2);
    await assert.rejects(worker.handle({ id: 'stale', op: 'source_sync_begin', snapshotId: 'stale', sourceType: 'album', revision: 'old', baseGeneration: 0, baseRevision: null, mode: 'complete' }), error => error.code === 'IMAGE_SOURCE_SNAPSHOT_STALE');
  });
});

test('evaluate exposes independent raw channel scores before threshold-specific fusion', async () => {
  await fixture(async ({ inboxDir, worker }) => {
    await makeImage(join(inboxDir, 'old.png'));
    await sharp(join(inboxDir, 'old.png')).jpeg({ quality: 65 }).toFile(join(inboxDir, 'query.jpg'));
    await worker.handle({ id: 'i', op: 'index', sources: [source('old.png', 'old', 100)], deadlineMs: 5000 });
    const result = await worker.handle({
      id: 'e-raw', op: 'evaluate', queries: [{ queryId: 'q', occurrenceId: 'query', relativePath: 'inbox/query.jpg' }],
      beforeTs: 200, excludeOccurrenceIds: ['query'], topK: 10, applyThresholds: false, deadlineMs: 5000, limits,
    });
    const candidate = result.candidates.find(row => row.occurrenceId === 'old');
    assert.equal(candidate.exact, false);
    assert.equal(Number.isInteger(candidate.hammingDistance), true);
    assert.equal(Number.isFinite(candidate.cosine), true);
  }, { visual: true });
});

test('evaluate keeps the full DB score corpus while candidate file reads obey a 32-path allowlist', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-bounded-evaluate-'));
  const inboxDir = join(dir, 'inbox');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'seed.png'));
  const historicalPaths = Array.from({ length: 40 }, (_, index) => `old-${index}.png`);
  for (const name of historicalPaths) copyFileSync(join(inboxDir, 'seed.png'), join(inboxDir, name));
  await makeImage(join(inboxDir, 'query.png'), 1);
  const reads = [];
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'bounded-evaluate-v1',
    embedImage: async relativePath => relativePath.endsWith('query.png') ? new Float32Array([0.8, 0.6]) : new Float32Array([1, 0]),
    onImageRead: event => { if (event.stage === 'candidate-hash') reads.push(event.relativePath); },
  });
  const request = {
    op: 'evaluate', queries: [{ queryId: 'q', occurrenceId: 'query', relativePath: 'inbox/query.png' }],
    beforeTs: 1000, excludeOccurrenceIds: ['query'], deadlineMs: 5000, topK: 100, applyThresholds: false, regionMode: 'whole', limits,
  };
  try {
    await worker.handle({
      id: 'seed', op: 'backfill', deadlineMs: 5000,
      sources: historicalPaths.map((name, index) => source(name, `old-${index}`, index + 1)),
    });
    const raw = await worker.handle({ id: 'raw', ...request, candidateValidationPaths: [] });
    assert.equal(raw.candidates.length, 40);
    assert.deepEqual(raw.validatedCandidates, []);
    assert.deepEqual(reads, []);

    const allowlist = historicalPaths.slice(0, 32).map(name => `inbox/${name}`);
    const bounded = await worker.handle({ id: 'bounded', ...request, candidateValidationPaths: allowlist });
    assert.equal(bounded.candidates.length, 40);
    assert.equal(bounded.validatedCandidates.length, 32);
    assert.ok(reads.length <= 32, reads.length);
    assert.ok(reads.every(path => allowlist.includes(path)));
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('raw evaluator candidates reproduce actual recall hash-fast-path delivery', async () => {
  await fixture(async ({ inboxDir, worker }) => {
    await makeImage(join(inboxDir, 'exact.png'));
    await makeImage(join(inboxDir, 'visual.png'), 1);
    await worker.handle({ id: 'i', op: 'backfill', sources: [source('exact.png', 'exact', 100), source('visual.png', 'visual', 101)], deadlineMs: 5000 });
    await new Promise(resolveWait => setTimeout(resolveWait, 10));
    await worker.handle({ id: 'i2', op: 'backfill', sources: [source('exact.png', 'exact', 100), source('visual.png', 'visual', 101)], deadlineMs: 5000 });
    const strict = { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88 };
    const request = { queries: [{ queryId: 'q', occurrenceId: 'query', relativePath: 'inbox/exact.png' }], beforeTs: 200, excludeOccurrenceIds: ['query'], deadlineMs: 5000, limits: strict };
    const actual = await worker.handle({ id: 'r-fast', op: 'recall', ...request });
    const diagnostic = await worker.handle({ id: 'e-fast', op: 'evaluate', ...request, topK: 10, applyThresholds: false });
    assert.deepEqual(actual.matches.map(match => match.occurrenceId), ['exact']);
    assert.equal(diagnostic.candidates.some(match => match.occurrenceId === 'visual' && match.cosine === 1), true);
    const simulated = rankImageCandidatesForRecallSemantics(diagnostic.candidates, {
      beforeTs: 200, excludeOccurrenceIds: ['query'], ...strict,
    });
    assert.deepEqual(simulated.map(match => match.occurrenceId), actual.matches.map(match => match.occurrenceId));
  }, { visual: true });
});

test('worker indexes fixed and YOLO history, keeps five online query regions, and separates raw route scores from combined delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-regions-'));
  const inboxDir = join(dir, 'inbox');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'old.png'));
  await makeImage(join(inboxDir, 'query.png'), 1);
  const regionCalls = [];
  const embedRegions = async (relativePath, descriptors) => {
    regionCalls.push({ relativePath, channels: descriptors.map(item => item.channel) });
    return descriptors.map(item => {
      const vector = new Float32Array(512);
      vector[item.channel === 'yolo' ? 1 : 0] = 1;
      return vector;
    });
  };
  let detectorFails = false;
  const detectImage = async () => {
    if (detectorFails) throw Object.assign(new Error('detector unavailable'), { code: 'DETECTOR_UNAVAILABLE' });
    return {
      detectorVersion: REGION_V1.detectorVersion, rawDetectionCount: 5, orientedWidth: 256, orientedHeight: 192,
      detections: Array.from({ length: 5 }, (_, index) => ({
        bbox: { x: index * 0.16, y: 0.1, width: 0.15, height: 0.3 }, classId: 41, className: 'cup', confidence: 0.95 - index * 0.05,
      })),
    };
  };
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath,
    embeddingVersion: 'fake-v1', embedImage: async () => { const vector = new Float32Array(512); vector[2] = 1; return vector; },
    regionConfig: { ...REGION_V1, fixedFeatureVersion: 'fixed-test-v1', yoloFeatureVersion: 'yolo-test-v1' },
    embedRegions, detectImage,
  });
  try {
    const indexed = await worker.handle({ id: 'i', op: 'backfill', sources: [source('old.png', 'old', 100)], deadlineMs: 5000 });
    assert.equal(indexed.pendingRegions, 0);
    const stats = await worker.handle({ id: 's', op: 'stats' });
    assert.equal(stats.fixedSets, 1);
    assert.equal(stats.yoloSets, 1);
    assert.equal(stats.regions, 10);

    const request = {
      queries: [{ queryId: 'q', occurrenceId: 'query', relativePath: 'inbox/query.png' }], beforeTs: 200,
      excludeOccurrenceIds: ['query'], deadlineMs: 2500, limits: { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88 },
    };
    const fixed = await worker.handle({ id: 'fixed', op: 'evaluate', ...request, topK: 10, applyThresholds: false, regionMode: 'fixed' });
    const yolo = await worker.handle({ id: 'yolo', op: 'evaluate', ...request, topK: 10, applyThresholds: false, regionMode: 'yolo' });
    const combined = await worker.handle({ id: 'combined', op: 'recall', ...request });
    const fixedCandidate = fixed.candidates.find(item => item.occurrenceId === 'old');
    const yoloCandidate = yolo.candidates.find(item => item.occurrenceId === 'old');
    assert.equal(fixedCandidate.fixedCosine, 1);
    assert.equal(yoloCandidate.yoloCosine, 1);
    assert.deepEqual(fixed.regionDiagnostics.selectedChannels, ['fixed', 'fixed', 'fixed', 'fixed', 'fixed']);
    assert.equal(yolo.regionDiagnostics.rawDetectionCount, 5);
    assert.equal(yolo.regionDiagnostics.acceptedDetectionCount, 5);
    assert.equal(combined.matches[0].occurrenceId, 'old');
    assert.equal(combined.matches[0].rawBestCosine, 1);
    const combinedCall = regionCalls.at(-1);
    assert.equal(combinedCall.channels.length, 5);
    assert.deepEqual(combinedCall.channels, ['yolo', 'yolo', 'yolo', 'fixed', 'fixed']);
    detectorFails = true;
    const fallback = await worker.handle({ id: 'detector-fallback', op: 'recall', ...request });
    assert.equal(fallback.matches[0]?.occurrenceId, 'old');
    assert.deepEqual(fallback.channels, { hash: 'ready', visual: 'ready', fixed: 'ready', yolo: 'unavailable' });
    assert.ok(fallback.warnings.includes('DETECTOR_UNAVAILABLE'));
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('worker maps region ids and boxes from the admitted winning channel and clears them when whole wins', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-region-winner-'));
  const inboxDir = join(dir, 'inbox');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'old.png'));
  await makeImage(join(inboxDir, 'query-region.png'), 1);
  await sharp(join(inboxDir, 'query-region.png')).flop().png().toFile(join(inboxDir, 'query-whole.png'));
  const vector = score => {
    const value = new Float32Array(512);
    value[0] = score;
    value[1] = Math.sqrt(1 - score * score);
    return value;
  };
  const embedImage = async relativePath => relativePath.includes('old') ? vector(1) : vector(relativePath.includes('whole') ? 0.99 : 0.8);
  const embedRegions = async (relativePath, descriptors) => descriptors.map(item => relativePath.includes('old')
    ? vector(1)
    : vector(item.channel === 'fixed' ? 0.96 : 0.9));
  const detectImage = async () => ({
    detectorVersion: REGION_V1.detectorVersion, rawDetectionCount: 1, orientedWidth: 256, orientedHeight: 192,
    detections: [{ bbox: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, classId: 41, className: 'cup', confidence: 0.95 }],
  });
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'fake-v1', embedImage,
    regionConfig: { ...REGION_V1, fixedFeatureVersion: 'fixed-winner-v1', yoloFeatureVersion: 'yolo-winner-v1', regionVisualMinScore: 0.88 },
    embedRegions, detectImage,
  });
  try {
    await worker.handle({ id: 'seed', op: 'backfill', sources: [source('old.png', 'old', 100)], deadlineMs: 5000 });
    const request = relativePath => ({
      queries: [{ queryId: relativePath, occurrenceId: `new-${relativePath}`, relativePath: `inbox/${relativePath}` }],
      beforeTs: 200, excludeOccurrenceIds: [`new-${relativePath}`], deadlineMs: 2500,
      limits: { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88 },
    });
    const fixedWinner = await worker.handle({ id: 'fixed-winner', op: 'recall', ...request('query-region.png') });
    const fixed = fixedWinner.matches[0];
    assert.equal(fixed.visualChannel, 'fixed');
    assert.ok(Math.abs(fixed.cosine - 0.96) < 1e-6);
    assert.match(fixed.queryRegionId, /^fixed:/);
    assert.match(fixed.candidateRegionId, /^fixed:/);
    assert.match(fixed.queryRegionId, new RegExp(fixed.queryRegionBbox.x.toFixed(6).replace('.', '\\.')));
    assert.match(fixed.candidateRegionId, new RegExp(fixed.candidateRegionBbox.x.toFixed(6).replace('.', '\\.')));
    assert.match(fixed.yoloQueryRegionId, /^yolo:/);
    assert.deepEqual(fixed.yoloQueryRegionBbox, { x: 0.14, y: 0.14, width: 0.52, height: 0.52 });

    const evaluated = await worker.handle({ id: 'raw-grid', op: 'evaluate', ...request('query-region.png'), topK: 10, applyThresholds: false });
    const rawCandidate = evaluated.candidates.find(item => item.occurrenceId === 'old');
    assert.ok(Math.abs(rawCandidate.fixedCosine - 0.96) < 1e-6);
    assert.deepEqual(rankImageCandidatesForThresholds([rawCandidate], {
      beforeTs: 200, maxHits: 10, pHashMaxDistance: 0, allowEvaluationTopK: true,
      wholeVisualMinScore: 0.99, fixedVisualMinScore: 0.97, yoloVisualMinScore: 0.97,
    }), []);
    assert.equal(rankImageCandidatesForThresholds([rawCandidate], {
      beforeTs: 200, maxHits: 10, pHashMaxDistance: 0, allowEvaluationTopK: true,
      wholeVisualMinScore: 0.99, fixedVisualMinScore: 0.95, yoloVisualMinScore: 0.97,
    })[0]?.visualChannel, 'fixed');

    const wholeWinner = await worker.handle({ id: 'whole-winner', op: 'recall', ...request('query-whole.png') });
    const whole = wholeWinner.matches[0];
    assert.equal(whole.visualChannel, 'whole');
    assert.ok(Math.abs(whole.cosine - 0.99) < 1e-6);
    assert.equal(whole.queryRegionId, null);
    assert.equal(whole.candidateRegionId, null);
    assert.equal(whole.queryRegionBbox, null);
    assert.equal(whole.candidateRegionBbox, null);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('disabled YOLO is complete after fixed indexing while enabled detector failures remain retryable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-region-progress-'));
  const inboxDir = join(dir, 'inbox');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'old.png'));
  const vectors = descriptors => descriptors.map(() => { const value = new Float32Array(512); value[0] = 1; return value; });
  let detectorCalls = 0;
  const disabled = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'disabled.sqlite'), policyPath, embeddingVersion: 'fake-v1',
    regionConfig: { ...REGION_V1, fixedFeatureVersion: 'fixed-disabled-v1', yoloFeatureVersion: 'yolo-disabled-v1', yoloEnabled: false },
    embedRegions: async (_path, descriptors) => vectors(descriptors),
    detectImage: async () => { detectorCalls++; throw new Error('must not detect'); },
  });
  try {
    const result = await disabled.handle({ id: 'disabled', op: 'backfill', sources: [source('old.png', 'old-disabled', 100)], deadlineMs: 5000 });
    assert.equal(result.pendingRegions, 0);
    assert.equal(detectorCalls, 0);
    const stats = await disabled.handle({ id: 'stats-disabled', op: 'stats' });
    assert.deepEqual({ fixed: stats.fixedSets, yolo: stats.yoloSets, pending: stats.pendingRegions }, { fixed: 1, yolo: 0, pending: 0 });
  } finally { await disabled.close(); }

  let fail = true;
  const enabled = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'enabled.sqlite'), policyPath, embeddingVersion: 'fake-v1',
    regionConfig: { ...REGION_V1, fixedFeatureVersion: 'fixed-enabled-v1', yoloFeatureVersion: 'yolo-enabled-v1' },
    embedRegions: async (_path, descriptors) => vectors(descriptors),
    detectImage: async () => {
      if (fail) throw Object.assign(new Error('warming'), { code: 'DETECTOR_WARMING' });
      return { detectorVersion: REGION_V1.detectorVersion, rawDetectionCount: 0, orientedWidth: 256, orientedHeight: 192, detections: [] };
    },
  });
  try {
    const first = await enabled.handle({ id: 'enabled-1', op: 'backfill', sources: [source('old.png', 'old-enabled', 100)], deadlineMs: 5000 });
    assert.equal(first.pendingRegions, 1);
    assert.ok(first.codes.includes('DETECTOR_WARMING'));
    fail = false;
    const second = await enabled.handle({ id: 'enabled-2', op: 'backfill', sources: [source('old.png', 'old-enabled', 100)], deadlineMs: 5000 });
    assert.equal(second.pendingRegions, 0);
    const stats = await enabled.handle({ id: 'stats-enabled', op: 'stats' });
    assert.deepEqual({ fixed: stats.fixedSets, yolo: stats.yoloSets, zero: stats.zeroDetectionYoloSets, pending: stats.pendingRegions }, { fixed: 1, yolo: 1, zero: 1, pending: 0 });
  } finally { await enabled.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('multi-query combined recall gives each query an original and keeps evidence scoped to its query', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-region-fairness-'));
  const inboxDir = join(dir, 'inbox');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'old-a.png'));
  await makeImage(join(inboxDir, 'old-b.png'), 1);
  await sharp(join(inboxDir, 'old-b.png')).flop().modulate({ brightness: 0.9 }).png().toFile(join(inboxDir, 'query-a.png'));
  await sharp(join(inboxDir, 'old-a.png')).flip().modulate({ brightness: 1.1 }).png().toFile(join(inboxDir, 'query-b.png'));
  const vectorFor = relativePath => {
    const vector = new Float32Array(512);
    vector[relativePath.includes('-b') ? 1 : 0] = 1;
    return vector;
  };
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'fake-v1',
    embedImage: async relativePath => vectorFor(relativePath),
    regionConfig: { ...REGION_V1, fixedFeatureVersion: 'fixed-fair-v1', yoloFeatureVersion: 'yolo-fair-v1' },
    embedRegions: async (relativePath, descriptors) => descriptors.map(() => vectorFor(relativePath)),
    detectImage: async () => ({
      detectorVersion: REGION_V1.detectorVersion, rawDetectionCount: 1, orientedWidth: 256, orientedHeight: 192,
      detections: [{ bbox: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, classId: 41, className: 'cup', confidence: 0.9 }],
    }),
  });
  try {
    await worker.handle({ id: 'seed-fair', op: 'backfill', sources: [source('old-a.png', 'old-a', 100), source('old-b.png', 'old-b', 101)], deadlineMs: 5000 });
    const result = await worker.handle({
      id: 'recall-fair', op: 'recall',
      queries: [
        { queryId: 'query-a', occurrenceId: 'new-a', relativePath: 'inbox/query-a.png' },
        { queryId: 'query-b', occurrenceId: 'new-b', relativePath: 'inbox/query-b.png' },
      ],
      beforeTs: 200, excludeOccurrenceIds: ['new-a', 'new-b'], deadlineMs: 2500,
      limits: { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88 },
    });
    assert.deepEqual(new Set(result.matches.map(item => item.occurrenceId)), new Set(['old-a', 'old-b']));
    assert.deepEqual(result.matches.find(item => item.occurrenceId === 'old-a').queryIds, ['query-a']);
    assert.deepEqual(result.matches.find(item => item.occurrenceId === 'old-b').queryIds, ['query-b']);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const revokeAt of ['whole-path', 'detector-sha', 'region-path']) {
  test(`query ${revokeAt} revocation during inference removes all evidence from that query`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `porch-image-query-revoke-${revokeAt}-`));
    const inboxDir = join(dir, 'inbox');
    const policyPath = join(dir, 'policy.json');
    mkdirSync(inboxDir);
    writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
    await makeImage(join(inboxDir, 'old.png'));
    await makeImage(join(inboxDir, 'query.png'), 1);
    const querySha = createHash('sha256').update(readFileSync(join(inboxDir, 'query.png'))).digest('hex');
    let recalling = false;
    const revoke = () => writeFileSync(policyPath, JSON.stringify({
      version: 1, revision: 1,
      paths: revokeAt.endsWith('path') ? { 'inbox/query.png': 150 } : {},
      shas: revokeAt.endsWith('sha') ? { [querySha]: 150 } : {},
    }));
    const vectors = descriptors => descriptors.map(() => { const value = new Float32Array(512); value[0] = 1; return value; });
    const worker = createImageMemoryWorker({
      inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'fake-v1',
      embedImage: async relativePath => {
        if (recalling && relativePath === 'inbox/query.png' && revokeAt === 'whole-path') revoke();
        const value = new Float32Array(512); value[0] = 1; return value;
      },
      regionConfig: { ...REGION_V1, fixedFeatureVersion: `fixed-query-${revokeAt}`, yoloFeatureVersion: `yolo-query-${revokeAt}` },
      embedRegions: async (relativePath, descriptors) => {
        if (recalling && relativePath === 'inbox/query.png' && revokeAt === 'region-path') revoke();
        return vectors(descriptors);
      },
      detectImage: async relativePath => {
        if (recalling && relativePath === 'inbox/query.png' && revokeAt === 'detector-sha') revoke();
        return {
          detectorVersion: REGION_V1.detectorVersion, rawDetectionCount: 1, orientedWidth: 256, orientedHeight: 192,
          detections: [{ bbox: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, classId: 41, className: 'cup', confidence: 0.95 }],
        };
      },
    });
    try {
      await worker.handle({ id: 'seed', op: 'backfill', sources: [source('old.png', 'old', 100)], deadlineMs: 5000 });
      recalling = true;
      const result = await worker.handle({
        id: 'recall', op: 'recall', queries: [{ queryId: 'query', occurrenceId: 'new', relativePath: 'inbox/query.png' }],
        beforeTs: 200, excludeOccurrenceIds: ['new'], deadlineMs: 2500,
        limits: { maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88 },
      });
      assert.deepEqual(result.matches, []);
    } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('invalid policy short-circuits before a missing candidate hash promise can reject', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-lazy-hash-'));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, '{invalid');
  let hashStarted = false;
  try {
    await assert.rejects(verifyImageAccessAfterHash({
      policyPath,
      relativePath: 'inbox/missing.png',
      expectedSha: 'a'.repeat(64),
      hashCurrent: () => {
        hashStarted = true;
        return Promise.reject(Object.assign(new Error('missing'), { code: 'IMAGE_NOT_FOUND' }));
      },
    }), error => error?.code === 'IMAGE_MEMORY_POLICY_INVALID');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hashStarted, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const revokeAt of ['fixed-embedding', 'detector', 'yolo-embedding']) {
  test(`policy revocation during ${revokeAt} prevents the in-flight region channel from persisting`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `porch-image-worker-region-race-${revokeAt}-`));
    const inboxDir = join(dir, 'inbox');
    const policyPath = join(dir, 'policy.json');
    mkdirSync(inboxDir);
    writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
    await makeImage(join(inboxDir, 'old.png'));
    let regionEmbeddingCalls = 0;
    const revoke = () => writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 1, paths: { 'inbox/old.png': 150 }, shas: {} }));
    const worker = createImageMemoryWorker({
      inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'fake-v1',
      regionConfig: { ...REGION_V1, fixedFeatureVersion: `fixed-${revokeAt}-v1`, yoloFeatureVersion: `yolo-${revokeAt}-v1` },
      embedRegions: async (_path, descriptors) => {
        regionEmbeddingCalls++;
        if ((revokeAt === 'fixed-embedding' && regionEmbeddingCalls === 1) || (revokeAt === 'yolo-embedding' && regionEmbeddingCalls === 2)) revoke();
        return descriptors.map(() => { const vector = new Float32Array(512); vector[0] = 1; return vector; });
      },
      detectImage: async () => {
        if (revokeAt === 'detector') revoke();
        return {
          detectorVersion: REGION_V1.detectorVersion, rawDetectionCount: 1, orientedWidth: 256, orientedHeight: 192,
          detections: [{ bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, classId: 41, className: 'cup', confidence: 0.9 }],
        };
      },
    });
    try {
      const result = await worker.handle({ id: revokeAt, op: 'backfill', sources: [source('old.png', `old-${revokeAt}`, 100)], deadlineMs: 5000 });
      assert.ok(result.pendingRegions >= 1);
      const stats = await worker.handle({ id: `stats-${revokeAt}`, op: 'stats' });
      if (revokeAt === 'fixed-embedding') assert.equal(stats.regionSets, 0);
      else assert.deepEqual({ fixed: stats.fixedSets, yolo: stats.yoloSets }, { fixed: 1, yolo: 0 });
      const recalled = await worker.handle({ id: `recall-${revokeAt}`, op: 'recall', queries: [{ queryId: 'q', occurrenceId: 'new', relativePath: 'inbox/old.png' }], beforeTs: 200, excludeOccurrenceIds: [], deadlineMs: 5000, limits });
      assert.deepEqual(recalled.matches, []);
    } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('source replacement during region embedding cannot commit old and new pixels into one image set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-region-replace-'));
  const inboxDir = join(dir, 'inbox');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  const imagePath = join(inboxDir, 'old.png');
  await makeImage(imagePath);
  let replaced = false;
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'fake-v1',
    regionConfig: { ...REGION_V1, fixedFeatureVersion: 'fixed-replace-v1', yoloFeatureVersion: 'yolo-replace-v1' },
    embedRegions: async (_path, descriptors) => {
      if (!replaced) {
        replaced = true;
        await makeImage(imagePath, 1);
      }
      return descriptors.map(() => { const vector = new Float32Array(512); vector[0] = 1; return vector; });
    },
    detectImage: async () => ({
      detectorVersion: REGION_V1.detectorVersion, rawDetectionCount: 1, orientedWidth: 256, orientedHeight: 192,
      detections: [{ bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, classId: 41, className: 'cup', confidence: 0.9 }],
    }),
  });
  try {
    const result = await worker.handle({ id: 'replace', op: 'backfill', sources: [source('old.png', 'old-replace', 100)], deadlineMs: 5000 });
    assert.equal(result.pendingRegions, 2);
    const stats = await worker.handle({ id: 'stats-replace', op: 'stats' });
    assert.equal(stats.regionSets, 0);
    const recalled = await worker.handle({ id: 'recall-replace', op: 'recall', queries: [{ queryId: 'q', occurrenceId: 'new', relativePath: 'inbox/old.png' }], beforeTs: 200, excludeOccurrenceIds: [], deadlineMs: 5000, limits });
    assert.deepEqual(recalled.matches, []);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('read-only worker rejects revoke before mutating policy or database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-readonly-revoke-'));
  const inboxDir = join(dir, 'inbox');
  const dbPath = join(dir, 'index.sqlite');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  const writable = createImageMemoryWorker({ inboxDir, dbPath, policyPath });
  await writable.close();
  const policyBefore = readFileSync(policyPath);
  const databaseBefore = readFileSync(dbPath);
  const readOnly = createImageMemoryWorker({ inboxDir, dbPath, policyPath, readOnly: true });
  try {
    const statsBefore = await readOnly.handle({ id: 's1', op: 'stats' });
    await assert.rejects(
      readOnly.handle({ id: 'r1', op: 'revoke', relativePaths: ['inbox/nope.png'] }),
      error => error?.code === 'IMAGE_STORE_READ_ONLY',
    );
    assert.deepEqual(await readOnly.handle({ id: 's2', op: 'stats' }), statsBefore);
  } finally {
    await readOnly.close();
  }
  assert.deepEqual(readFileSync(policyPath), policyBefore);
  assert.deepEqual(readFileSync(dbPath), databaseBefore);
  rmSync(dir, { recursive: true, force: true });
});

test('read-only snapshot keeps one database view while a separate writer advances WAL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-readonly-snapshot-'));
  const inboxDir = join(dir, 'inbox');
  const dbPath = join(dir, 'index.sqlite');
  const policyPath = join(dir, 'policy.json');
  mkdirSync(inboxDir);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'a.png'));
  await makeImage(join(inboxDir, 'b.png'), 1);
  const writer = createImageMemoryWorker({ inboxDir, dbPath, policyPath });
  let snapshot;
  try {
    await writer.handle({ id: 'i1', op: 'index', sources: [source('a.png', 'a', 100)], deadlineMs: 5000 });
    snapshot = createImageMemoryWorker({ inboxDir, dbPath, policyPath, readOnly: true, readSnapshot: true });
    const before = await snapshot.handle({ id: 's1', op: 'stats' });
    assert.equal(before.images, 1);
    await writer.handle({ id: 'i2', op: 'index', sources: [source('b.png', 'b', 110)], deadlineMs: 5000 });
    assert.equal((await writer.handle({ id: 's2', op: 'stats' })).images, 2);
    assert.equal((await snapshot.handle({ id: 's3', op: 'stats' })).images, 1);
  } finally {
    await snapshot?.close();
    await writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policy denial removes results immediately without waiting for reconcile', async () => {
  await fixture(async ({ inboxDir, policyPath, worker }) => {
    await makeImage(join(inboxDir, 'a.png'));
    await worker.handle({ id: 'i', op: 'index', sources: [source('a.png', 'old', 100)], deadlineMs: 5000 });
    writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 1, paths: { 'inbox/a.png': 150 }, shas: {} }));
    const result = await worker.handle({ id: 'r', op: 'recall', queries: [{ queryId: 'q', occurrenceId: 'new', relativePath: 'inbox/a.png' }], beforeTs: 200, excludeOccurrenceIds: [], deadlineMs: 5000, limits });
    assert.deepEqual(result.matches, []);
  });
});

test('embedding failure cannot hide exact or near-duplicate hash matches', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-hash-fallback-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'old.png'));
  await sharp(join(inboxDir, 'old.png')).jpeg({ quality: 65 }).toFile(join(inboxDir, 'copy.jpg'));
  let modelCalls = 0;
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'fake-v1',
    embeddingClient: { ready: true, async embed() { modelCalls++; throw Object.assign(new Error('timeout'), { code: 'MODEL_TIMEOUT' }); }, async close() {} },
  });
  try {
    const indexed = await worker.handle({ id: 'i', op: 'index', sources: [source('old.png', 'old', 100)], deadlineMs: 5000 });
    assert.equal(indexed.pendingEmbedding, 1);
    const exact = await worker.handle({ id: 'e', op: 'recall', queries: [{ queryId: 'e', occurrenceId: 'new-e', relativePath: 'inbox/old.png' }], beforeTs: 200, excludeOccurrenceIds: [], deadlineMs: 5000, limits });
    const near = await worker.handle({ id: 'n', op: 'recall', queries: [{ queryId: 'n', occurrenceId: 'new-n', relativePath: 'inbox/copy.jpg' }], beforeTs: 200, excludeOccurrenceIds: [], deadlineMs: 5000, limits });
    assert.equal(exact.matches[0]?.kind, 'exact');
    assert.equal(near.matches[0]?.kind, 'near_duplicate');
    assert.equal(modelCalls, 1, 'only background indexing attempted the unavailable model');
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a hung visual query returns earlier hash matches before the request deadline', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-partial-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  await makeImage(join(inboxDir, 'old.png'));
  await makeImage(join(inboxDir, 'negative.png'), 1);
  let hang = false;
  const worker = createImageMemoryWorker({
    inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, embeddingVersion: 'fake-v1',
    embeddingClient: { ready: true, async embed() { if (hang) return new Promise(() => {}); return new Float32Array([1, 0]); }, async close() {} },
  });
  try {
    await worker.handle({ id: 'i', op: 'index', sources: [source('old.png', 'old', 100)], deadlineMs: 5000 });
    hang = true;
    const start = Date.now();
    const result = await worker.handle({ id: 'r', op: 'recall', queries: [
      { queryId: 'exact', occurrenceId: 'new-e', relativePath: 'inbox/old.png' },
      { queryId: 'visual-hang', occurrenceId: 'new-v', relativePath: 'inbox/negative.png' },
    ], beforeTs: 200, excludeOccurrenceIds: [], deadlineMs: 60, limits });
    assert.ok(Date.now() - start < 300);
    assert.equal(result.matches[0]?.kind, 'exact');
    assert.ok(result.warnings.includes('MODEL_DEADLINE'));
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('revocation after recall but before indexing is rechecked by the write path', async () => {
  await fixture(async ({ inboxDir, policyPath, worker }) => {
    await makeImage(join(inboxDir, 'a.png'));
    const query = source('a.png', 'new', 200);
    const before = await worker.handle({ id: 's1', op: 'stats' });
    writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 1, paths: { 'inbox/a.png': 201 }, shas: {} }));
    const indexed = await worker.handle({ id: 'i', op: 'index', sources: [query], deadlineMs: 5000 });
    assert.equal(indexed.failed, 1);
    assert.ok(indexed.codes.includes('IMAGE_POLICY_DENIED'));
    assert.deepEqual(await worker.handle({ id: 's2', op: 'stats' }), before);
  });
});

test('candidate validation happens before sha deduplication so a valid later occurrence survives', async () => {
  await fixture(async ({ inboxDir, worker }) => {
    await makeImage(join(inboxDir, 'first.png'));
    copyFileSync(join(inboxDir, 'first.png'), join(inboxDir, 'second.png'));
    await worker.handle({ id: 'i', op: 'index', sources: [source('first.png', 'first', 100), source('second.png', 'second', 110)], deadlineMs: 5000 });
    unlinkSync(join(inboxDir, 'first.png'));
    const result = await worker.handle({ id: 'r', op: 'recall', queries: [{ queryId: 'q', occurrenceId: 'new', relativePath: 'inbox/second.png' }], beforeTs: 200, excludeOccurrenceIds: [], deadlineMs: 5000, limits });
    assert.equal(result.matches[0]?.occurrenceId, 'second');
    assert.equal(result.matches[0]?.relativePath, 'inbox/second.png');
  });
});

test('candidate validation can promote a valid fourth visual result after three stale paths', async () => {
  await fixture(async ({ inboxDir, worker }) => {
    for (let index = 1; index <= 4; index++) {
      await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: index * 30, g: index * 20, b: index * 10 } } }).png().toFile(join(inboxDir, `old-${index}.png`));
    }
    await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 230, g: 210, b: 190 } } }).png().toFile(join(inboxDir, 'query.png'));
    await worker.handle({ id: 'i', op: 'index', sources: [1, 2, 3, 4].map(index => source(`old-${index}.png`, `old-${index}`, index * 10)), deadlineMs: 5000 });
    for (let index = 1; index <= 3; index++) unlinkSync(join(inboxDir, `old-${index}.png`));
    const result = await worker.handle({ id: 'r', op: 'recall', queries: [{ queryId: 'q', occurrenceId: 'new', relativePath: 'inbox/query.png' }], beforeTs: 100, excludeOccurrenceIds: [], deadlineMs: 5000, limits });
    assert.equal(result.matches[0]?.occurrenceId, 'old-4');
  }, { visual: true });
});

async function cliFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-cli-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  const policyPath = join(dir, 'policy.json');
  const manifestPath = join(dir, 'manifest.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  writeFileSync(manifestPath, JSON.stringify({ revision: 'fixture-revision', embeddingVersion: 'fake-v1' }));
  const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const embeddingWorkerPath = fileURLToPath(new URL('./test-fixtures/embedding-worker-path-modes.mjs', import.meta.url));
  const client = createImageMemoryClient({ enabled: true, workerPath, embeddingWorkerPath, cwd: dir, inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, manifestPath, cacheDir: join(dir, 'cache'), timeoutMs: 500, cooldownMs: 50 });
  try {
    await client.stats();
    await new Promise(resolve => setTimeout(resolve, 350));
    await run({ client, inboxDir });
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
}

async function backfillUntilEmbedded(client, sources) {
  const deadline = Date.now() + 3000;
  let result;
  do {
    result = await client.backfill(sources);
    if (result.pendingEmbedding === 0 || Date.now() >= deadline) return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (true);
}

test('real client recall overtakes a background index whose visual embedding hangs', async () => {
  await cliFixture(async ({ client, inboxDir }) => {
    await makeImage(join(inboxDir, 'old.png'));
    await makeImage(join(inboxDir, 'hang.png'), 1);
    const seeded = await backfillUntilEmbedded(client, [source('old.png', 'old', 100)]);
    assert.equal(seeded.pendingEmbedding, 0);
    const background = client.indexBatch([source('hang.png', 'hang', 110)]);
    await new Promise(resolve => setTimeout(resolve, 30));
    const started = Date.now();
    const recalled = await client.recallBatch({ queries: [{ queryId: 'q', occurrenceId: 'new', relativePath: 'inbox/old.png' }], beforeTs: 200, excludeOccurrenceIds: [] });
    assert.equal(recalled.matches[0]?.kind, 'exact');
    assert.ok(Date.now() - started < 480);
    await background;
  });
});

test('real client keeps an earlier exact match when a later query exhausts its visual budget', async () => {
  await cliFixture(async ({ client, inboxDir }) => {
    await makeImage(join(inboxDir, 'old.png'));
    await makeImage(join(inboxDir, 'visual-hang.png'), 1);
    const seeded = await backfillUntilEmbedded(client, [source('old.png', 'old', 100)]);
    assert.equal(seeded.pendingEmbedding, 0);
    const started = Date.now();
    const recalled = await client.recallBatch({ queries: [
      { queryId: 'exact', occurrenceId: 'new-exact', relativePath: 'inbox/old.png' },
      { queryId: 'visual', occurrenceId: 'new-visual', relativePath: 'inbox/visual-hang.png' },
    ], beforeTs: 200, excludeOccurrenceIds: [] });
    assert.equal(recalled.matches[0]?.kind, 'exact');
    assert.ok(Date.now() - started < 480);
  });
});

test('real hash worker and embedding sidecar leave no live handles after idempotent close', async () => {
  const fixturePath = fileURLToPath(new URL('./test-fixtures/client-close-real.mjs', import.meta.url));
  const child = spawn(process.execPath, [fixturePath], { cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let timeout;
  const result = await Promise.race([
    exit,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('real client close left the process alive')), 5000); }),
  ]);
  clearTimeout(timeout);
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.match(stdout, /closed/);
});

test('model integration is explicit and never pretends to pass without its environment switch', { skip: process.env.IMAGE_MEMORY_MODEL_TEST !== '1' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-worker-model-roots-'));
  const inboxDir = join(dir, 'inbox');
  const lifePhotosDir = join(dir, 'life-photos');
  const galleryDir = join(dir, 'gallery');
  for (const root of [inboxDir, lifePhotosDir, galleryDir]) mkdirSync(root);
  await makeImage(join(inboxDir, 'a.png'), 0);
  await makeImage(join(lifePhotosDir, 'b.png'), 1);
  await sharp({ create: { width: 256, height: 192, channels: 3, background: { r: 30, g: 160, b: 220 } } }).png().toFile(join(galleryDir, 'c.png'));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  const projectRoot = process.cwd();
  const client = createImageMemoryClient({
    enabled: true, cwd: projectRoot, inboxDir, lifePhotosDir, galleryDir,
    dbPath: join(dir, 'index.sqlite'), policyPath,
    workerPath: join(projectRoot, 'tools/image-memory/worker.mjs'),
    embeddingWorkerPath: join(projectRoot, 'tools/image-memory/embedding-worker.mjs'),
    manifestPath: join(projectRoot, 'tools/image-memory/model-manifest.json'),
    cacheDir: join(projectRoot, 'tools/image-memory/model-cache'),
    regionsEnabled: true,
    detectorManifestPath: join(projectRoot, 'tools/image-region/runtime/detector-manifest.json'),
    detectorWorkerPath: join(projectRoot, 'tools/image-region/detector-worker.py'),
    timeoutMs: 120000,
  });
  const sources = [
    { occurrenceId: 'inbox-source', relativePath: 'inbox/a.png', sourceTs: 10, sourceText: '' },
    { occurrenceId: 'life-source', relativePath: 'life-photos/b.png', sourceTs: 20, sourceText: '' },
    { occurrenceId: 'gallery-source', relativePath: 'gallery/c.png', sourceTs: 30, sourceText: '' },
  ];
  try {
    let indexed;
    for (let attempt = 0; attempt < 8; attempt++) {
      indexed = await client.backfill(sources);
      if (!indexed.pendingEmbedding && !indexed.pendingRegions) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 1000));
    }
    assert.equal(indexed.failed, 0);
    assert.equal(indexed.pendingEmbedding, 0);
    assert.equal(indexed.pendingRegions, 0);
    for (const [index, row] of sources.entries()) {
      const recalled = await client.recallBatch({
        queries: [{ queryId: `q${index}`, occurrenceId: `query-${index}`, relativePath: row.relativePath }],
        beforeTs: 100, excludeOccurrenceIds: [`query-${index}`], deadlineAt: Date.now() + 120000,
      });
      assert.equal(recalled.matches[0]?.kind, 'exact', row.relativePath);
    }
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
