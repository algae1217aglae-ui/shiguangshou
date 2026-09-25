import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireImageRetentionClaims, acquireImageRetentionCleanupFence, withImageRetentionClaim } from './image-retention-fence.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-fence-'));
  const runtimeRoot = join(root, 'data', 'image-retention');
  mkdirSync(runtimeRoot, { recursive: true });
  return { root, runtimeRoot };
}

test('cleanup waits for a pre-existing writer and writer waits for cleanup', async t => {
  const { root, runtimeRoot } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  let releaseWriter;
  const writer = withImageRetentionClaim({ runtimeRoot, relativePath: 'inbox/private.jpg', timeoutMs: 1000 }, async () => {
    await new Promise(resolve => { releaseWriter = resolve; });
  });
  while (!releaseWriter) await new Promise(resolve => setTimeout(resolve, 1));
  let cleanupReady = false;
  const cleanupPromise = acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 1000 }).then(fence => { cleanupReady = true; return fence; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cleanupReady, false);
  releaseWriter(); await writer;
  const cleanup = await cleanupPromise;
  let writerDuringCleanup = false;
  const waitingWriter = withImageRetentionClaim({ runtimeRoot, relativePath: 'inbox/other.jpg', timeoutMs: 1000 }, async () => { writerDuringCleanup = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(writerDuringCleanup, false);
  await cleanup.release(); await waitingWriter;
  assert.equal(writerDuringCleanup, true);
});

test('only one cleanup executor owns the lock and only its token can release', async t => {
  const { root, runtimeRoot } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = await acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 100 });
  await assert.rejects(() => acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 30 }), /RETENTION_CLEANUP_BUSY/);
  assert.equal(await first.release('wrong-token'), false);
  await assert.rejects(() => acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 30 }), /RETENTION_CLEANUP_BUSY/);
  assert.equal(await first.release(), true);
  const second = await acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 100 });
  await second.release();
});

test('claim files and contents are anonymous and waits are bounded', async t => {
  const { root, runtimeRoot } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  let inspect;
  await withImageRetentionClaim({ runtimeRoot, relativePath: 'inbox/secret-name.jpg', timeoutMs: 100 }, async () => {
    const dir = join(runtimeRoot, 'claims');
    inspect = readdirSync(dir).map(name => name + readFileSync(join(dir, name), 'utf8')).join('\n');
  });
  assert.equal(inspect.includes('secret-name'), false);
  const cleanup = await acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 100 });
  await assert.rejects(() => withImageRetentionClaim({ runtimeRoot, relativePath: 'inbox/a.jpg', timeoutMs: 20 }, async () => {}), /RETENTION_FENCE_TIMEOUT/);
  await cleanup.release();
});

test('a multi-path writer acquires one atomic group claim without deadlocking cleanup', async t => {
  const { root, runtimeRoot } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const groupPromise = acquireImageRetentionClaims({ runtimeRoot, relativePaths: ['inbox/a.jpg', 'inbox/b.jpg'], timeoutMs: 200 });
  const cleanupPromise = acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 500, pollMs: 5 });
  const group = await groupPromise;
  assert.equal(group.claims.length, 1);
  let cleanupReady = false;
  const cleanup = cleanupPromise.then(value => { cleanupReady = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(cleanupReady, false);
  await group.release();
  await (await cleanup).release();
});

test('an empty claim group never waits behind cleanup', async t => {
  const { root, runtimeRoot } = fixture(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cleanup = await acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 100 });
  const started = Date.now();
  const group = await acquireImageRetentionClaims({ runtimeRoot, relativePaths: [], timeoutMs: 20 });
  assert.ok(Date.now() - started < 100);
  assert.equal(group.claims.length, 0);
  await group.release(); await cleanup.release();
});

test('runtime validation rejects a data junction before creating anything outside', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'porch-retention-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  symlinkSync(outside, join(root, 'data'), 'junction');
  await assert.rejects(
    () => acquireImageRetentionCleanupFence({ runtimeRoot: join(root, 'data', 'image-retention') }),
    error => error.code === 'RETENTION_FENCE_ROOT_UNSAFE',
  );
  assert.equal(existsSync(join(outside, 'image-retention')), false);
});
