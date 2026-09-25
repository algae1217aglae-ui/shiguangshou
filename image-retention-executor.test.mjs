import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeImageRetention, inspectPendingImageRetention, repairPendingImageRetention } from './image-retention-executor.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-09-25T00:00:00.000Z');
const OLD = new Date(NOW - 120 * DAY).toISOString();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-exec-'));
  mkdirSync(join(root, 'inbox')); mkdirSync(join(root, 'works')); mkdirSync(join(root, 'data', 'image-retention'), { recursive: true });
  writeFileSync(join(root, 'state.json'), JSON.stringify({ log: [{ role: 'user', images: ['inbox/old.jpg'], ts: OLD }] }));
  writeFileSync(join(root, 'chat-history.jsonl'), ''); writeFileSync(join(root, 'life.json'), '[]');
  writeFileSync(join(root, 'albums.json'), '{"albums":[]}'); writeFileSync(join(root, 'works.json'), '[]');
  const image = join(root, 'inbox', 'old.jpg'); writeFileSync(image, 'old bytes');
  const oldDate = new Date(NOW - 200 * DAY); utimesSync(image, oldDate, oldDate);
  return { root, image, runtimeRoot: join(root, 'data', 'image-retention') };
}

test('execute rechecks post-preview collection, reshare, and replacement', async t => {
  for (const mode of ['collect', 'reshare', 'replace']) {
    const f = fixture();
    const result = await executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true, beforeCandidate: async () => {
      if (mode === 'collect') writeFileSync(join(f.root, 'life.json'), JSON.stringify([{ kind: 'photo', photo: '/inbox/old.jpg' }]));
      if (mode === 'reshare') writeFileSync(join(f.root, 'state.json'), JSON.stringify({ log: [{ role: 'user', images: ['inbox/old.jpg'], ts: new Date(NOW - DAY).toISOString() }] }));
      if (mode === 'replace') writeFileSync(f.image, 'replacement');
    }, reconcile: async () => ({ removed: 1 }) });
    assert.equal(result.deletedCount, 0, mode);
    assert.equal(existsSync(f.image), true, mode);
    rmSync(f.root, { recursive: true, force: true });
  }
  t.after(() => {});
});

test('successful unlink reconciles, reports separate totals, and clears pending marker', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  let calls = 0;
  const result = await executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true, reconcile: async () => { calls++; return { removed: 1, paused: false }; } });
  assert.equal(existsSync(f.image), false);
  assert.equal(calls, 1);
  assert.deepEqual({ deleted: result.deletedCount, synchronized: result.synchronizedCount, pending: result.pendingRepairCount }, { deleted: 1, synchronized: 1, pending: 0 });
  assert.equal(existsSync(join(f.runtimeRoot, 'reconcile-pending.json')), false);
});

test('unlink failure is truthful and does not reconcile', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  let reconciled = false;
  const result = await executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true,
    unlinkFile: () => { const e = new Error('locked'); e.code = 'EPERM'; throw e; }, reconcile: async () => { reconciled = true; return { removed: 1 }; } });
  assert.equal(result.deletedCount, 0); assert.equal(result.failedCount, 1); assert.equal(reconciled, false); assert.equal(existsSync(f.image), true);
});

test('reconcile failure or paused policy leaves anonymous pending repair for disabled-startup recovery', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const failed = await executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true, reconcile: async () => { throw new Error('db down'); } });
  const marker = join(f.runtimeRoot, 'reconcile-pending.json');
  assert.equal(failed.pendingRepairCount, 1); assert.equal(existsSync(marker), true);
  assert.equal(readFileSync(marker, 'utf8').includes('old.jpg'), false);
  const paused = await repairPendingImageRetention({ runtimeRoot: f.runtimeRoot, enabled: false, reconcile: async () => ({ removed: 0, paused: true }) });
  assert.equal(paused.repaired, false); assert.equal(existsSync(marker), true);
  const repaired = await repairPendingImageRetention({ runtimeRoot: f.runtimeRoot, enabled: false, reconcile: async () => ({ removed: 1, paused: false }) });
  assert.equal(repaired.repaired, true); assert.equal(existsSync(marker), false);
});

test('a corrupt pending marker remains pending and forces a full reconcile', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  const marker = join(f.runtimeRoot, 'reconcile-pending.json');
  writeFileSync(marker, '{broken');
  let calls = 0;
  const repaired = await repairPendingImageRetention({ runtimeRoot: f.runtimeRoot, reconcile: async () => { calls++; return { removed: 1, paused: false }; } });
  assert.equal(calls, 1);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.wasCorrupt, true);
  assert.equal(existsSync(marker), false);
});

test('pending marker inspection and repair reject a data junction before reading outside', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-marker-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'porch-retention-marker-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  writeFileSync(join(outside, 'reconcile-pending.json'), JSON.stringify({ pending: true }));
  symlinkSync(outside, join(root, 'data'), 'junction');
  assert.throws(
    () => inspectPendingImageRetention({ runtimeRoot: join(root, 'data', 'image-retention') }),
    error => error.code === 'RETENTION_RUNTIME_UNSAFE',
  );
  await assert.rejects(
    () => repairPendingImageRetention({ runtimeRoot: join(root, 'data', 'image-retention'), reconcile: async () => ({ removed: 1 }) }),
    error => error.code === 'RETENTION_RUNTIME_UNSAFE',
  );
});

test('execute requires explicit enabled and exactly 90 days', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  await assert.rejects(() => executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: false, reconcile: async () => ({ removed: 0 }) }), /RETENTION_DISABLED/);
  await assert.rejects(() => executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true, days: 30, reconcile: async () => ({ removed: 0 }) }), /RETENTION_DAYS_INVALID/);
});

test('two executors cannot enter the destructive section together', async t => {
  const f = fixture(); t.after(() => rmSync(f.root, { recursive: true, force: true }));
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  let releaseResolve;
  const release = new Promise(resolve => { releaseResolve = resolve; });
  const first = executeImageRetention({
    root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true,
    beforeCandidate: async () => { enteredResolve(); await release; },
    reconcile: async () => ({ removed: 1, paused: false }),
  });
  await entered;
  await assert.rejects(
    () => executeImageRetention({ root: f.root, runtimeRoot: f.runtimeRoot, now: NOW, enabled: true, reconcile: async () => ({ removed: 1 }) }),
    error => error?.code === 'RETENTION_CLEANUP_BUSY',
  );
  releaseResolve();
  const result = await first;
  assert.equal(result.deletedCount, 1);
});
