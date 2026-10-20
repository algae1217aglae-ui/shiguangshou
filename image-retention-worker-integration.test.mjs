import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createImageMemoryWorker } from './tools/image-memory/worker.mjs';
import { executeImageRetention } from './image-retention-executor.mjs';
import { withImageRetentionClaim } from './image-retention-fence.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-09-25T00:00:00.000Z');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function source(file, id, ts) { return { occurrenceId: id, queryId: id, relativePath: `inbox/${file}`, sourceTs: ts, sourceText: '' }; }

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-worker-'));
  const inboxDir = join(root, 'inbox'); mkdirSync(inboxDir); mkdirSync(join(root, 'works')); mkdirSync(join(root, 'data', 'image-retention'), { recursive: true });
  writeFileSync(join(root, 'chat-history.jsonl'), ''); writeFileSync(join(root, 'life.json'), '[]'); writeFileSync(join(root, 'albums.json'), '{"albums":[]}'); writeFileSync(join(root, 'works.json'), '[]');
  const policyPath = join(root, 'policy.json'); writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  const worker = createImageMemoryWorker({ inboxDir, dbPath: join(root, 'index.sqlite'), policyPath });
  return { root, inboxDir, policyPath, worker, runtimeRoot: join(root, 'data', 'image-retention') };
}

function oldFile(path) { writeFileSync(path, PNG); const date = new Date(NOW - 200 * DAY); utimesSync(path, date, date); }

test('real worker preserves a live same-SHA alias, removes the final alias, and allows future reupload recall', async t => {
  const f = setup(); t.after(async () => { await f.worker.close(); rmSync(f.root, { recursive: true, force: true }); });
  oldFile(join(f.inboxDir, 'old.png')); oldFile(join(f.inboxDir, 'keep.png'));
  writeFileSync(join(f.root, 'state.json'), JSON.stringify({ log: [
    { role: 'user', images: ['inbox/old.png'], ts: new Date(NOW - 120 * DAY).toISOString() },
    { role: 'user', images: ['inbox/keep.png'], ts: new Date(NOW - DAY).toISOString() },
  ] }));
  await f.worker.handle({ id: 'seed', op: 'index', sources: [source('old.png', 'old', 10), source('keep.png', 'keep', 20)], deadlineMs: 5000 });
  const first = await executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true,
    reconcile: () => f.worker.handle({ id: 'reconcile-1', op: 'reconcile' }) });
  assert.equal(first.deletedCount, 1);
  const keepRecall = await f.worker.handle({ id: 'recall-keep', op: 'recall', queries: [source('keep.png', 'query', 30)], beforeTs: 100, excludeOccurrenceIds: ['query'], deadlineMs: 5000, limits: { maxHits: 3, pHashMaxDistance: 8, visualMinScore: 0.88 } });
  assert.equal(keepRecall.matches.length > 0, true);

  writeFileSync(join(f.root, 'state.json'), JSON.stringify({ log: [{ role: 'user', images: ['inbox/keep.png'], ts: new Date(NOW - 120 * DAY).toISOString() }] }));
  const second = await executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true,
    reconcile: () => f.worker.handle({ id: 'reconcile-2', op: 'reconcile' }) });
  assert.equal(second.deletedCount, 1);
  assert.equal((await f.worker.handle({ id: 'stats-empty', op: 'stats' })).images, 0);

  oldFile(join(f.inboxDir, 'future.png'));
  writeFileSync(join(f.root, 'state.json'), JSON.stringify({ log: [{ role: 'user', images: ['inbox/future.png'], ts: new Date(NOW + DAY).toISOString() }] }));
  const indexed = await f.worker.handle({ id: 'future-index', op: 'index', sources: [source('future.png', 'future', NOW + DAY)], deadlineMs: 5000 });
  assert.equal(indexed.indexed, 1);
  const futureRecall = await f.worker.handle({ id: 'future-recall', op: 'recall', queries: [source('future.png', 'future-query', NOW + 2 * DAY)], beforeTs: NOW + 3 * DAY, excludeOccurrenceIds: ['future-query'], deadlineMs: 5000, limits: { maxHits: 3, pHashMaxDistance: 8, visualMinScore: 0.88 } });
  assert.equal(futureRecall.matches[0]?.occurrenceId, 'future');
  assert.deepEqual(JSON.parse((await import('node:fs')).readFileSync(f.policyPath, 'utf8')).shas, {});
});

test('global index claim makes a late real-worker commit run only after unlink/reconcile and fail closed', async t => {
  const f = setup(); t.after(async () => { await f.worker.close(); rmSync(f.root, { recursive: true, force: true }); });
  oldFile(join(f.inboxDir, 'old.png'));
  writeFileSync(join(f.root, 'state.json'), JSON.stringify({ log: [{ role: 'user', images: ['inbox/old.png'], ts: new Date(NOW - 120 * DAY).toISOString() }] }));
  await f.worker.handle({ id: 'seed', op: 'index', sources: [source('old.png', 'old', 10)], deadlineMs: 5000 });
  let cleanupPausedResolve, cleanupPaused = new Promise(resolve => { cleanupPausedResolve = resolve; });
  let continueCleanupResolve, continueCleanup = new Promise(resolve => { continueCleanupResolve = resolve; });
  const cleanup = executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true,
    beforeCandidate: async () => { cleanupPausedResolve(); await continueCleanup; },
    reconcile: () => f.worker.handle({ id: 'reconcile', op: 'reconcile' }) });
  await cleanupPaused;
  let lateResult;
  const late = withImageRetentionClaim({ runtimeRoot: f.runtimeRoot, kind: 'index', relativePath: '__index__', timeoutMs: 2000 }, async () => {
    lateResult = await f.worker.handle({ id: 'late', op: 'index', sources: [source('old.png', 'late', 20)], deadlineMs: 5000 });
  });
  continueCleanupResolve();
  await cleanup; await late;
  // 10/20 起，檔案已被清掉的那張算「建不了索引」而不是「失敗」；要守的是它沒被寫回去。
  assert.equal(lateResult.indexed, 0);
  assert.equal((lateResult.failed || 0) + (lateResult.unindexable || 0), 1);
  assert.ok(lateResult.codes.includes('IMAGE_NOT_FOUND'));
  assert.equal((await f.worker.handle({ id: 'stats', op: 'stats' })).images, 0);
});

test('paused real worker marks reconcile result as paused', async t => {
  const f = setup(); t.after(async () => { await f.worker.close(); rmSync(f.root, { recursive: true, force: true }); });
  mkdirSync(f.policyPath + '.pending');
  writeFileSync(join(f.policyPath + '.pending', 'pending.json'), JSON.stringify({ version: 1, paths: [], shas: [], revokedAt: NOW }));
  assert.deepEqual(await f.worker.handle({ id: 'paused', op: 'reconcile' }), { removed: 0, paused: true });
});
