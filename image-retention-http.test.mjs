import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createImageRetentionHttpHandler, createImageRetentionRepairScheduler, createImageRetentionScheduler, initializeImageRetentionOperatorToken } from './image-retention-http.mjs';

function request(port, { token = '', host, headers = {}, body = { mode: 'preview' } } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/image-retention', method: 'POST', headers: {
      host: host || `127.0.0.1:${port}`, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
    } }, res => { let raw = ''; res.on('data', d => { raw += d; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') })); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
}

test('real temporary HTTP handler rejects unauthenticated, forwarded, hostile host/origin requests', async t => {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-http-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'data', 'image-retention'); mkdirSync(runtimeRoot, { recursive: true });
  const token = initializeImageRetentionOperatorToken(runtimeRoot);
  let port;
  const handler = createImageRetentionHttpHandler({ root, runtimeRoot, getConfig: () => ({ imageRetentionEnabled: false, imageRetentionDays: 90 }),
    allowedHosts: () => [`127.0.0.1:${port}`], preview: async () => ({ candidateCount: 0 }), execute: async () => ({ deletedCount: 0 }) });
  const server = http.createServer((req, res) => handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port; t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, { token, headers: { 'x-forwarded-for': '100.64.0.1' } })).status, 403);
  assert.equal((await request(port, { token, host: 'porch.example.test' })).status, 403);
  assert.equal((await request(port, { token, headers: { origin: 'https://porch.example.test' } })).status, 403);
  assert.equal((await request(port, { token })).status, 200);
});

test('execute is server-owned, exact-90, default-off, and busy-aware', async t => {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-http-exec-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'data', 'image-retention'); mkdirSync(runtimeRoot, { recursive: true });
  const token = initializeImageRetentionOperatorToken(runtimeRoot);
  let port, cfg = { imageRetentionEnabled: false, imageRetentionDays: 90 }, busy = false, executions = 0;
  const handler = createImageRetentionHttpHandler({ root, runtimeRoot, getConfig: () => cfg, isImageBusy: () => busy,
    allowedHosts: () => [`127.0.0.1:${port}`], preview: async () => ({ candidateCount: 0 }), execute: async () => { executions++; return { deletedCount: 1 }; } });
  const server = http.createServer((req, res) => handler(req, res)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port; t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await request(port, { token, body: { mode: 'execute' } })).status, 409);
  cfg = { imageRetentionEnabled: true, imageRetentionDays: 30 };
  assert.equal((await request(port, { token, body: { mode: 'execute' } })).status, 409);
  cfg = { imageRetentionEnabled: true, imageRetentionDays: 90 }; busy = true;
  assert.equal((await request(port, { token, body: { mode: 'execute' } })).status, 409);
  busy = false;
  const ok = await request(port, { token, body: { mode: 'execute' } });
  assert.equal(ok.status, 200); assert.equal(executions, 1);
});

test('cleanup scheduler records anonymous success and visible failure status', async t => {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-scheduler-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'data', 'image-retention');
  const issues = [];
  let fail = false;
  const scheduler = createImageRetentionScheduler({
    runtimeRoot,
    getConfig: () => ({ imageRetentionEnabled: true, imageRetentionDays: 90 }),
    run: async () => {
      if (fail) throw Object.assign(new Error('private path must not persist'), { code: 'RETENTION_SYNTHETIC_FAILURE' });
      return { deletedCount: 2, synchronizedCount: 1, pendingRepairCount: 1, failedCount: 0 };
    },
    onIssue: issue => issues.push(issue),
    now: () => Date.parse('2026-09-25T12:00:00Z'),
  });
  await scheduler.tick();
  let status = JSON.parse(readFileSync(join(runtimeRoot, 'last-run.json'), 'utf8'));
  assert.deepEqual({ operation: status.operation, status: status.status, deleted: status.deletedCount }, { operation: 'cleanup', status: 'attention', deleted: 2 });
  fail = true;
  const failed = await scheduler.tick();
  status = JSON.parse(readFileSync(join(runtimeRoot, 'last-run.json'), 'utf8'));
  assert.equal(failed.failed, true);
  assert.deepEqual({ status: status.status, code: status.code }, { status: 'error', code: 'RETENTION_SYNTHETIC_FAILURE' });
  assert.equal(JSON.stringify(status).includes('private path'), false);
  assert.deepEqual(issues, [{ operation: 'cleanup', code: 'RETENTION_SYNTHETIC_FAILURE' }]);
});

test('pending repair keeps retrying at a bounded interval while cleanup is disabled', async t => {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-repair-scheduler-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'data', 'image-retention');
  const timers = [];
  const issues = [];
  let attempt = 0;
  const scheduler = createImageRetentionRepairScheduler({
    runtimeRoot,
    retryMs: 1234,
    repair: async () => {
      attempt++;
      if (attempt === 1) throw Object.assign(new Error('temporary'), { code: 'RETENTION_REPAIR_TEMPORARY' });
      if (attempt === 2) return { pending: true, repaired: false, reason: 'policy_paused' };
      return { pending: false, repaired: true, removed: 3 };
    },
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
    onIssue: issue => issues.push(issue),
    now: () => Date.parse('2026-09-25T12:00:00Z'),
  });
  const first = await scheduler.tick();
  assert.equal(first.pending, true);
  assert.equal(timers.at(-1).ms, 1234);
  const second = await scheduler.tick();
  assert.equal(second.pending, true);
  assert.equal(timers.at(-1).ms, 1234);
  const third = await scheduler.tick();
  assert.equal(third.repaired, true);
  assert.equal(timers.length, 3);
  const status = JSON.parse(readFileSync(join(runtimeRoot, 'last-run.json'), 'utf8'));
  assert.deepEqual({ operation: status.operation, status: status.status, removed: status.removed }, { operation: 'repair', status: 'ok', removed: 3 });
  assert.deepEqual(issues, [
    { operation: 'repair', code: 'RETENTION_REPAIR_TEMPORARY' },
    { operation: 'repair', code: 'RETENTION_REPAIR_POLICY_PAUSED' },
  ]);
});

test('repair scheduler keeps a low-frequency watch after an idle startup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-idle-repair-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const timers = [];
  let pending = false;
  const scheduler = createImageRetentionRepairScheduler({
    runtimeRoot: join(root, 'data', 'image-retention'), retryMs: 1234,
    repair: async () => ({ pending, repaired: false }),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  });
  scheduler.start();
  assert.equal(timers.length, 1);
  timers.shift();
  await scheduler.tick();
  pending = true;
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1234);
});

test('last-run persistence failure cannot suppress repair health or the next retry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-last-run-failure-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeRoot = join(root, 'data', 'image-retention');
  mkdirSync(join(runtimeRoot, 'last-run.json'), { recursive: true });
  const issues = []; const timers = [];
  const scheduler = createImageRetentionRepairScheduler({
    runtimeRoot, retryMs: 1234, repair: async () => ({ pending: true, repaired: false, reason: 'policy_paused' }),
    onIssue: issue => issues.push(issue),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
  });
  const result = await scheduler.tick();
  assert.equal(result.pending, true);
  assert.equal(issues.some(issue => issue.code === 'RETENTION_LAST_RUN_WRITE_FAILED'), true);
  assert.equal(issues.some(issue => issue.code === 'RETENTION_REPAIR_POLICY_PAUSED'), true);
  assert.equal(timers.length, 1);
});

test('operator token initialization refuses a data junction before writing outside', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'porch-retention-token-junction-'));
  const outside = mkdtempSync(join(tmpdir(), 'porch-retention-token-outside-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });
  symlinkSync(outside, join(root, 'data'), 'junction');
  assert.throws(
    () => initializeImageRetentionOperatorToken(join(root, 'data', 'image-retention')),
    error => error.code === 'RETENTION_RUNTIME_UNSAFE',
  );
  assert.equal(existsSync(join(outside, 'image-retention', 'operator-token')), false);
});
