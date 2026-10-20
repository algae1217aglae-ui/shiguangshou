import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import { createImageMemoryClient } from './image-memory.mjs';
import { collectImageMemoryEntries } from './image-memory.mjs';
import { acquireImageRetentionCleanupFence, withImageRetentionClaim } from './image-retention-fence.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const fixtureWorker = fileURLToPath(new URL('./test-fixtures/image-memory-worker.mjs', import.meta.url));
const realWorker = fileURLToPath(new URL('./tools/image-memory/worker.mjs', import.meta.url));
const closeEpipeHarness = fileURLToPath(new URL('./test-fixtures/image-memory-close-epipe-harness.mjs', import.meta.url));

async function until(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('bounded wait exceeded');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child harness timed out')); }, 3000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function makeClient(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-client-'));
  const issues = [];
  const client = createImageMemoryClient({
    enabled: true, workerPath: fixtureWorker, cwd: dir, inboxDir: join(dir, 'inbox'), dbPath: join(dir, 'db.sqlite'),
    policyPath: join(dir, 'policy.json'), manifestPath: join(dir, 'manifest.json'), cacheDir: join(dir, 'cache'),
    timeoutMs: 500, maxHits: 3, pHashMaxDistance: 8, visualMinScore: 0.88, onIssue: issue => issues.push(issue),
    // 舊測試量的是「寫入逾時就砍」：維護期限跟著 timeoutMs、不自動暖機，各自有專門的測試。
    maintenanceTimeoutMs: overrides.timeoutMs ?? 500, prewarmAfterCooldown: false, ...overrides,
  });
  return { dir, issues, client, async cleanup() { await client.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const query = name => ({ queryId: name, occurrenceId: `o-${name}`, relativePath: `inbox/${name}.jpg` });

test('source snapshot commit has a bounded maintenance budget independent of recall', async () => {
  const ctx = makeClient();
  try {
    await ctx.client.stats();
    assert.equal((await ctx.client.syncSourceSnapshot({ status: 'complete', sourceType: 'chat', revision: 'r1', memberships: [], messages: [] })).generation, 1);
    const start = Date.now();
    const recall = await ctx.client.recallBatch({ queries: [query('hang')], beforeTs: 10 });
    assert.equal(recall.channels.hash, 'timeout');
    assert.ok(ctx.issues.some(issue => issue.code === 'IMAGE_WORKER_TIMEOUT' && issue.stage === 'recall'));
    assert.ok(Date.now() - start < 1500, 'recall must not inherit the maintenance timeout');
  } finally { await ctx.cleanup(); }
  const bounded = makeClient({ sourceSyncTimeoutMs: 100 });
  try {
    await bounded.client.stats();
    await assert.rejects(bounded.client.syncSourceSnapshot({ status: 'complete', sourceType: 'chat', revision: 'r1' }), { code: 'IMAGE_WORKER_TIMEOUT' });
  } finally { await bounded.cleanup(); }
});

test('disabled client returns safe values without spawning', async () => {
  const client = createImageMemoryClient({ enabled: false });
  assert.deepEqual(await client.recallBatch({ queries: [query('a')], beforeTs: 10, excludeOccurrenceIds: [] }), { matches: [], warnings: [], channels: { hash: 'unavailable', visual: 'unavailable' }, skippedQueryCount: 0 });
  assert.deepEqual(await client.indexBatch([]), { indexed: 0, unchanged: 0, pendingEmbedding: 0, failed: 0, codes: [] });
  assert.deepEqual(await client.stats(), { images: 0, occurrences: 0, pendingEmbedding: 0 });
  await client.close();
});

test('real client syncs an initial source snapshot and preserves stale CAS rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-client-real-sync-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  writeFileSync(join(inboxDir, 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  const client = createImageMemoryClient({
    enabled: true, workerPath: realWorker, cwd: dir, inboxDir, dbPath: join(dir, 'db.sqlite'),
    policyPath: join(dir, 'policy.json'), timeoutMs: 5000,
  });
  const snapshot = revision => ({
    sourceType: 'album', status: 'complete', revision, memberships: [{
      membershipId: 'album:a:item', sourceType: 'album', sourceId: 'a', relativePath: 'inbox/a.png',
      sourceTs: 100, sourceText: '', sourceRevision: revision, locator: { kind: 'album', confidence: 'exact' }, metadata: {},
    }], messages: [],
  });
  try {
    assert.deepEqual(await client.syncSourceSnapshot(snapshot('r1')), { generation: 1, revision: 'r1', memberships: 1, messages: 0, pendingEmbedding: 0 });
    const stats = await client.stats();
    assert.deepEqual(stats.sourceSnapshots, [{ sourceType: 'album', generation: 1, revision: 'r1' }]);
    const stale = snapshot('stale');
    stale.base = { generation: 0, revision: null };
    await assert.rejects(client.syncSourceSnapshot(stale), error => error.code === 'IMAGE_SOURCE_SNAPSHOT_STALE');
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('client starts lazily and maps concurrent out-of-order replies by id', async () => {
  const ctx = makeClient();
  try {
    assert.equal(ctx.client.running, false);
    const [stats, recall] = await Promise.all([
      ctx.client.stats(),
      ctx.client.recallBatch({ queries: [query('slow')], beforeTs: 10, excludeOccurrenceIds: [] }),
    ]);
    assert.deepEqual(stats, { images: 1, occurrences: 2, pendingEmbedding: 0 });
    assert.equal(recall.matches[0].queryIds[0], 'slow');
    assert.equal(ctx.client.running, true);
  } finally { await ctx.cleanup(); }
});

test('client sends the angle fallback flag only when explicitly enabled', async () => {
  const disabled = makeClient();
  const enabled = makeClient({ angleFallbackEnabled: true });
  try {
    const off = await disabled.client.recallBatch({ queries: [query('limits-off')], beforeTs: 10, excludeOccurrenceIds: [] });
    const on = await enabled.client.recallBatch({ queries: [query('limits-on')], beforeTs: 10, excludeOccurrenceIds: [] });
    const suppressed = await enabled.client.recallBatch({ queries: [query('limits-suppressed')], beforeTs: 10, excludeOccurrenceIds: [], angleFallbackEnabled: false });
    assert.equal(Object.hasOwn(off.diagnosticLimits, 'angleFallbackEnabled'), false);
    assert.equal(on.diagnosticLimits.angleFallbackEnabled, true);
    assert.equal(Object.hasOwn(suppressed.diagnosticLimits, 'angleFallbackEnabled'), false);
    assert.equal(on.diagnosticLimits.visualMinScore, 0.88);
  } finally {
    await disabled.cleanup();
    await enabled.cleanup();
  }
});

test('one shared recall deadline caps eight images and ignores late replies', async () => {
  const ctx = makeClient({ timeoutMs: 60 });
  try {
    const started = Date.now();
    const result = await ctx.client.recallBatch({ queries: Array.from({ length: 10 }, (_, i) => query(i === 0 ? 'hang' : `q${i}`)), beforeTs: 10, excludeOccurrenceIds: [] });
    assert.ok(Date.now() - started < 300);
    assert.deepEqual(result.matches, []);
    assert.equal(result.skippedQueryCount, 2);
    assert.equal(result.channels.hash, 'timeout');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(ctx.issues.some(issue => JSON.stringify(issue).includes(ctx.dir)), false);
  } finally { await ctx.cleanup(); }
});

test('process exit, malformed JSON, and stderr noise are contained and a later request restarts', async () => {
  const ctx = makeClient({ cooldownMs: 40 });
  try {
    const crashed = await ctx.client.recallBatch({ queries: [query('crash')], beforeTs: 10, excludeOccurrenceIds: [] });
    assert.deepEqual(crashed.matches, []);
    await new Promise(resolve => setTimeout(resolve, 60));
    const recovered = await ctx.client.stats();
    assert.equal(recovered.images, 1);
    const malformed = await ctx.client.recallBatch({ queries: [query('bad-json')], beforeTs: 10, excludeOccurrenceIds: [] });
    assert.deepEqual(malformed.matches, []);
    assert.ok(ctx.issues.length >= 1);
  } finally { await ctx.cleanup(); }
});

test('a stale exited generation cannot poison requests sent to the replacement worker', async () => {
  const ctx = makeClient({ cooldownMs: 0 });
  try {
    await Promise.all([
      ctx.client.recallBatch({ queries: [query('bad-json')], beforeTs: 10, excludeOccurrenceIds: [] }),
      ctx.client.recallBatch({ queries: [query('bad-json')], beforeTs: 10, excludeOccurrenceIds: [] }),
    ]);
    const recovered = await ctx.client.stats();
    assert.equal(recovered.images, 1);
  } finally { await ctx.cleanup(); }
});

test('background indexing is bounded, split into batches of four, and close permits a fresh restart', async () => {
  const ctx = makeClient();
  try {
    const sources = Array.from({ length: 9 }, (_, i) => ({ occurrenceId: `o${i}`, queryId: `q${i}`, relativePath: `inbox/${i}.jpg`, sourceTs: i, sourceText: '' }));
    const result = await ctx.client.indexBatch(sources);
    assert.deepEqual(result, { indexed: 9, unchanged: 0, pendingEmbedding: 9, failed: 0, codes: [] });
    await ctx.client.close();
    assert.equal(ctx.client.running, false);
    assert.equal((await ctx.client.stats()).images, 1);
  } finally { await ctx.cleanup(); }
});

test('region-enabled client passes only trusted detector paths and aggregates pending region work', async () => {
  const ctx = makeClient({ regionsEnabled: true, detectorManifestPath: 'C:/tool/runtime/detector-manifest.json', detectorWorkerPath: 'C:/tool/detector-worker.py' });
  try {
    const stats = await ctx.client.stats();
    assert.deepEqual(stats.regionArgs, { manifest: 'C:/tool/runtime/detector-manifest.json', worker: 'C:/tool/detector-worker.py' });
    const sources = Array.from({ length: 5 }, (_, index) => ({ occurrenceId: `r${index}`, relativePath: `inbox/${index}.jpg`, sourceTs: index, sourceText: '' }));
    const result = await ctx.client.backfill(sources);
    assert.equal(result.pendingRegions, 5);
  } finally { await ctx.cleanup(); }
});

test('failed background writes report every unprocessed source and can be retried after worker recovery', async () => {
  const ctx = makeClient({ timeoutMs: 100, cooldownMs: 40 });
  const source = relativePath => ({ occurrenceId: relativePath, queryId: relativePath, relativePath, sourceTs: 1, sourceText: '' });
  try {
    const failed = await ctx.client.backfill([source('inbox/crash.jpg')]);
    assert.deepEqual({ indexed: failed.indexed, unchanged: failed.unchanged, failed: failed.failed }, { indexed: 0, unchanged: 0, failed: 1 });
    await new Promise(resolve => setTimeout(resolve, 60));
    const retried = await ctx.client.backfill([source('inbox/recovered.jpg')]);
    assert.deepEqual({ indexed: retried.indexed, unchanged: retried.unchanged, failed: retried.failed }, { indexed: 1, unchanged: 0, failed: 0 });
  } finally { await ctx.cleanup(); }
});

test('a timed-out mutating request terminates its real worker before the client releases its caller', async () => {
  const ctx = makeClient({ timeoutMs: 40, cooldownMs: 20 });
  const source = { occurrenceId: 'late', queryId: 'late', relativePath: 'inbox/late-commit.jpg', sourceTs: 1, sourceText: '' };
  const marker = join(ctx.dir, 'db.sqlite.late-commit');
  try {
    const result = await ctx.client.indexBatch([source]);
    assert.equal(result.failed, 1);
    // 假 worker 1 秒後才寫：Windows 的 taskkill 本身就要一兩百毫秒，150 毫秒在 Windows 上可能來不及砍（10/14）。
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(existsSync(marker), false);
  } finally { await ctx.cleanup(); }
});

test('an unconfirmed mutating-worker termination keeps its caller blocked until the process really exits', async () => {
  const ctx = makeClient({ timeoutMs: 40, cooldownMs: 0, terminationWarningMs: 20, terminateProcess: async () => {} });
  const source = { occurrenceId: 'late-exit', queryId: 'late-exit', relativePath: 'inbox/late-exit.jpg', sourceTs: 1, sourceText: '' };
  const marker = join(ctx.dir, 'db.sqlite.late-exit');
  try {
    let settled = false;
    const pending = ctx.client.indexBatch([source]).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 85));
    assert.equal(settled, false);
    assert.equal(ctx.issues.some(issue => issue.code === 'IMAGE_WORKER_TERMINATION_UNCONFIRMED'), true);
    const result = await pending;
    assert.equal(existsSync(marker), true);
    assert.equal(result.failed, 1);
  } finally { await ctx.cleanup(); }
});

test('a termination command failure still waits for the mutating worker exit', async () => {
  const ctx = makeClient({ timeoutMs: 40, cooldownMs: 0, terminationWarningMs: 20, terminateProcess: async () => { throw new Error('synthetic kill failure'); } });
  const source = { occurrenceId: 'late-exit-kill-error', queryId: 'late-exit-kill-error', relativePath: 'inbox/late-exit.jpg', sourceTs: 1, sourceText: '' };
  try {
    let settled = false;
    const pending = ctx.client.indexBatch([source]).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 85));
    assert.equal(settled, false);
    assert.equal((await pending).failed, 1);
  } finally { await ctx.cleanup(); }
});

test('an unconfirmed worker exit keeps the cross-process cleanup fence blocked', async () => {
  const ctx = makeClient({ timeoutMs: 40, cooldownMs: 0, terminationWarningMs: 20, terminateProcess: async () => {} });
  const runtimeRoot = join(ctx.dir, 'data', 'image-retention');
  const source = { occurrenceId: 'late-exit-fence', queryId: 'late-exit-fence', relativePath: 'inbox/late-exit.jpg', sourceTs: 1, sourceText: '' };
  try {
    const writer = withImageRetentionClaim({ runtimeRoot, relativePath: '__index__', kind: 'image-index', timeoutMs: 500 }, () => ctx.client.indexBatch([source]));
    while (!ctx.issues.some(issue => issue.code === 'IMAGE_WORKER_TERMINATION_UNCONFIRMED')) await new Promise(resolve => setTimeout(resolve, 5));
    await assert.rejects(
      () => acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 30, pollMs: 5 }),
      error => error.code === 'RETENTION_FENCE_TIMEOUT',
    );
    await writer;
    const cleanup = await acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 100 });
    await cleanup.release();
  } finally { await ctx.cleanup(); }
});

test('a mutating protocol circuit keeps its claim until the corrupt worker really exits', async () => {
  const ctx = makeClient({ timeoutMs: 2000, cooldownMs: 0, terminationWarningMs: 20, terminateProcess: async () => {} });
  const runtimeRoot = join(ctx.dir, 'data', 'image-retention');
  const source = { occurrenceId: 'protocol-late-commit', queryId: 'protocol-late-commit', relativePath: 'inbox/protocol-late-commit.jpg', sourceTs: 1, sourceText: '' };
  const marker = join(ctx.dir, 'db.sqlite.protocol-late-commit');
  try {
    let settled = false;
    const writer = withImageRetentionClaim({ runtimeRoot, relativePath: '__index__', kind: 'image-index', timeoutMs: 1000 }, () => ctx.client.indexBatch([source]))
      .then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false);
    await assert.rejects(
      () => acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 30, pollMs: 5 }),
      error => error.code === 'RETENTION_FENCE_TIMEOUT',
    );
    const result = await writer;
    assert.equal(result.failed, 1);
    assert.equal(existsSync(marker), true);
    const cleanup = await acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 100 });
    await cleanup.release();
  } finally { await ctx.cleanup(); }
});

test('a read-timeout circuit cannot release a mutating claim from the same worker generation', async () => {
  const ctx = makeClient({ timeoutMs: 2000, cooldownMs: 0, terminationWarningMs: 20, terminateProcess: async () => {} });
  const runtimeRoot = join(ctx.dir, 'data', 'image-retention');
  const source = { occurrenceId: 'read-circuit', queryId: 'read-circuit', relativePath: 'inbox/read-circuit-late-commit.jpg', sourceTs: 1, sourceText: '' };
  const marker = join(ctx.dir, 'db.sqlite.read-circuit-late-commit');
  try {
    let settled = false;
    const writer = withImageRetentionClaim({ runtimeRoot, relativePath: '__index__', kind: 'image-index' }, () => ctx.client.indexBatch([source]))
      .then(result => { settled = true; return result; });
    const recalls = Promise.all([
      ctx.client.recallBatch({ queries: [query('hang')], beforeTs: 10, excludeOccurrenceIds: [], deadlineAt: Date.now() + 40 }),
      ctx.client.recallBatch({ queries: [query('hang')], beforeTs: 10, excludeOccurrenceIds: [], deadlineAt: Date.now() + 40 }),
    ]);
    await recalls;
    assert.equal(settled, false);
    await assert.rejects(() => acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 30, pollMs: 5 }), error => error.code === 'RETENTION_FENCE_TIMEOUT');
    assert.equal((await writer).failed, 1);
    assert.equal(existsSync(marker), true);
  } finally { await ctx.cleanup(); }
});

test('a mutating stdin error keeps its claim until the still-live worker exits', async () => {
  const ctx = makeClient({ timeoutMs: 2000, cooldownMs: 0, terminationWarningMs: 20, terminateProcess: async () => {} });
  const runtimeRoot = join(ctx.dir, 'data', 'image-retention');
  const marker = join(ctx.dir, 'db.sqlite.stdin-late-commit');
  try {
    await ctx.client.recallBatch({ queries: [query('close-input')], beforeTs: 10, excludeOccurrenceIds: [] });
    let settled = false;
    const writer = withImageRetentionClaim({ runtimeRoot, relativePath: '__index__', kind: 'image-index' }, () => ctx.client.indexBatch([
      { occurrenceId: 'stdin', queryId: 'stdin', relativePath: 'inbox/stdin.jpg', sourceTs: 1, sourceText: '' },
    ])).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false);
    await assert.rejects(() => acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 30, pollMs: 5 }), error => error.code === 'RETENTION_FENCE_TIMEOUT');
    assert.equal((await writer).failed, 1);
    assert.equal(existsSync(marker), true);
  } finally { await ctx.cleanup(); }
});

test('close keeps a mutating claim blocked when termination remains unconfirmed', async () => {
  const ctx = makeClient({ timeoutMs: 2000, cooldownMs: 0, closeGraceMs: 20, terminationWarningMs: 20, terminateProcess: async () => {} });
  const runtimeRoot = join(ctx.dir, 'data', 'image-retention');
  const marker = join(ctx.dir, 'db.sqlite.close-late-commit');
  try {
    let settled = false;
    const writer = withImageRetentionClaim({ runtimeRoot, relativePath: '__index__', kind: 'image-index' }, () => ctx.client.indexBatch([
      { occurrenceId: 'close', queryId: 'close', relativePath: 'inbox/close-late-commit.jpg', sourceTs: 1, sourceText: '' },
    ])).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 50));
    const closing = ctx.client.close();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(settled, false);
    assert.equal(ctx.issues.some(issue => issue.code === 'IMAGE_WORKER_TERMINATION_UNCONFIRMED' && issue.stage === 'close'), true);
    await assert.rejects(() => acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 30, pollMs: 5 }), error => error.code === 'RETENTION_FENCE_TIMEOUT');
    await closing;
    assert.equal((await writer).failed, 1);
    assert.equal(existsSync(marker), true);
  } finally { await ctx.cleanup(); }
});

test('close settles only its original generation while a replacement mutation stays fenced', async () => {
  const ctx = makeClient({ timeoutMs: 3000, cooldownMs: 0, closeGraceMs: 10, terminationWarningMs: 10, terminateProcess: async () => {} });
  const runtimeRoot = join(ctx.dir, 'data', 'image-retention');
  const source = name => ({ occurrenceId: name, queryId: name, relativePath: `inbox/${name}.jpg`, sourceTs: 1, sourceText: '' });
  const oldReady = join(ctx.dir, 'db.sqlite.close-generation-old-ready');
  const newReady = join(ctx.dir, 'db.sqlite.close-generation-new-ready');
  const newCommit = join(ctx.dir, 'db.sqlite.close-generation-new-commit');
  try {
    const oldWriter = withImageRetentionClaim({ runtimeRoot, relativePath: '__index__', kind: 'image-index' }, () => ctx.client.indexBatch([source('close-generation-old')]));
    await until(() => existsSync(oldReady));
    const closing = ctx.client.close();
    await until(() => ctx.issues.some(issue => issue.code === 'IMAGE_WORKER_TERMINATION_UNCONFIRMED' && issue.stage === 'close'));

    let replacementSettled = false;
    const replacementWriter = withImageRetentionClaim({ runtimeRoot, relativePath: '__index__', kind: 'image-index' }, () => ctx.client.indexBatch([source('close-generation-new')]))
      .then(result => { replacementSettled = true; return result; });
    await until(() => existsSync(newReady));

    await closing;
    await oldWriter;
    assert.equal(replacementSettled, false);
    assert.equal(existsSync(newCommit), false);
    await assert.rejects(() => acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 40, pollMs: 5 }), error => error.code === 'RETENTION_FENCE_TIMEOUT');

    assert.equal((await replacementWriter).failed, 1);
    assert.equal(existsSync(newCommit), true);
    const cleanup = await acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 100 });
    await cleanup.release();
  } finally { await ctx.cleanup(); }
});

test('close contains an asynchronous shutdown EPIPE from an already closed worker stdin', async () => {
  const result = await runNode(closeEpipeHarness);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { closed: true });
});

test('a late exit from an old worker generation cannot settle a replacement request', async () => {
  const ctx = makeClient({ timeoutMs: 250, cooldownMs: 0, terminationWarningMs: 20, terminateProcess: async () => {} });
  const source = { occurrenceId: 'late-generation', queryId: 'late-generation', relativePath: 'inbox/late-generation.jpg', sourceTs: 1, sourceText: '' };
  try {
    let oldSettled = false;
    const old = ctx.client.indexBatch([source]).then(result => { oldSettled = true; return result; });
    while (!ctx.issues.some(issue => issue.code === 'IMAGE_WORKER_TERMINATION_UNCONFIRMED')) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 140));
    assert.equal(oldSettled, false);
    const replacement = ctx.client.stats();
    const [oldResult, stats] = await Promise.all([old, replacement]);
    assert.equal(oldResult.failed, 1);
    assert.deepEqual(stats, { images: 1, occurrences: 2, pendingEmbedding: 0 });
  } finally { await ctx.cleanup(); }
});

test('collectImageMemoryEntries merges archive and state, preserves occurrences, and lets current denials win', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-collect-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  writeFileSync(join(inboxDir, 'a.jpg'), 'a');
  writeFileSync(join(inboxDir, 'b.jpg'), 'b');
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  writeFileSync(historyPath, [
    JSON.stringify({ role: 'user', ts: 100, images: ['inbox/a.jpg'], text: 'old' }),
    JSON.stringify({ role: 'user', ts: 200, images: ['inbox/a.jpg'], text: 'later' }),
    JSON.stringify({ role: 'user', ts: 300, images: ['../escape.jpg'], text: '' }),
    '{bad}',
  ].join('\n'));
  writeFileSync(statePath, JSON.stringify({ log: [
    { role: 'user', ts: 100, images: ['inbox/a.jpg'], text: 'richer current text' },
    { role: 'user', ts: 400, images: ['inbox/a.jpg'], text: '不要存' },
    { role: 'user', ts: 500, images: ['inbox/b.jpg'], text: 'safe' },
    { role: 'user', ts: 600, images: ['inbox/missing.jpg'], text: 'gone' },
  ] }));
  try {
    const result = await collectImageMemoryEntries({ historyPath, statePath, inboxDir, policyPath });
    assert.deepEqual(result.sources.map(row => row.relativePath), ['inbox/b.jpg']);
    assert.deepEqual(result.denied, ['inbox/a.jpg']);
    assert.ok(result.issues.some(issue => issue.code === 'HISTORY_BAD_JSON'));
    assert.ok(result.issues.some(issue => issue.code === 'IMAGE_NOT_FOUND'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('maintenance writes get their own budget instead of the 2.5-second chat recall budget', async () => {
  // 10/14：以前回填跟建索引用聊天那 2.5 秒，連排隊都算，一超時整個 worker 被砍、冷卻一分鐘。
  const ctx = makeClient({ timeoutMs: 40, maintenanceTimeoutMs: 5000 });
  const source = { occurrenceId: 'slow-index', queryId: 'slow-index', relativePath: 'inbox/late-commit.jpg', sourceTs: 1, sourceText: '' };
  try {
    const result = await ctx.client.indexBatch([source]);
    assert.deepEqual({ indexed: result.indexed, failed: result.failed }, { indexed: 1, failed: 0 });
    assert.equal(ctx.issues.some(issue => issue.code === 'IMAGE_WORKER_TIMEOUT'), false);
    assert.equal(ctx.client.running, true);
  } finally { await ctx.cleanup(); }
});

test('after a worker dies the client wakes a fresh one once the cooldown ends, without waiting for the next query', async () => {
  const ctx = makeClient({ cooldownMs: 60, prewarmAfterCooldown: true });
  try {
    await ctx.client.backfill([{ occurrenceId: 'crash', queryId: 'crash', relativePath: 'inbox/crash.jpg', sourceTs: 1, sourceText: '' }]);
    assert.equal(ctx.client.running, false);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(ctx.client.running, true);
  } finally { await ctx.cleanup(); }
});

test('closing the client cancels a pending warm-up so no worker is left behind', async () => {
  const ctx = makeClient({ cooldownMs: 150, prewarmAfterCooldown: true });
  try {
    await ctx.client.backfill([{ occurrenceId: 'crash', queryId: 'crash', relativePath: 'inbox/crash.jpg', sourceTs: 1, sourceText: '' }]);
    await ctx.client.close();
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(ctx.client.running, false);
  } finally { await ctx.cleanup(); }
});
