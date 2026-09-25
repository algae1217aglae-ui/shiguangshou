import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDetectorProcessClient } from './detector-process.mjs';

const workerPath = fileURLToPath(new URL('./test-fixtures/detector-worker.mjs', import.meta.url));

async function ready(client) {
  const end = Date.now() + 2000;
  while (!client.ready && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(client.ready, true);
}

const makeClient = (mode, overrides = {}) => createDetectorProcessClient({
  command: process.execPath, workerPath, inboxDir: 'inbox', weightPath: 'weight', detectorVersion: 'detector-v1',
  extraArgs: ['--mode', mode], pollMs: 10, detectorTimeoutMs: 200, cooldownMs: 200, ...overrides,
});

test('detector process returns bounded normalized metadata and query priority', async () => {
  const client = makeClient('slow');
  const order = [];
  try {
    await ready(client);
    const active = client.detect('inbox/active.jpg', { expectedSha256: 'a'.repeat(64), priority: 'background' }).then(() => order.push('active'));
    const background = client.detect('inbox/background.jpg', { expectedSha256: 'b'.repeat(64), priority: 'background' }).then(() => order.push('background'));
    const query = client.detect('inbox/query.jpg', { expectedSha256: 'c'.repeat(64), priority: 'query' }).then(value => { order.push('query'); return value; });
    const result = await query;
    assert.equal(result.detectorVersion, 'detector-v1');
    assert.equal(result.detections[0].className, 'cup');
    await Promise.all([active, background]);
    assert.deepEqual(order, ['active', 'query', 'background']);
  } finally { await client.close(); }
});

test('detector process bounds queue and shared absolute deadline', async () => {
  const client = makeClient('slow', { maxQueue: 2, detectorTimeoutMs: 500 });
  try {
    await ready(client);
    const first = client.detect('inbox/a.jpg', { expectedSha256: 'a'.repeat(64), deadlineAt: Date.now() + 500 });
    const second = client.detect('inbox/b.jpg', { expectedSha256: 'b'.repeat(64), deadlineAt: Date.now() + 500 });
    await assert.rejects(client.detect('inbox/c.jpg', { expectedSha256: 'c'.repeat(64), deadlineAt: Date.now() + 500 }), error => error.code === 'DETECTOR_QUEUE_FULL');
    await Promise.all([first, second]);
    await assert.rejects(client.detect('inbox/late.jpg', { expectedSha256: 'd'.repeat(64), deadlineAt: Date.now() - 1 }), error => error.code === 'DETECTOR_TIMEOUT');
  } finally { await client.close(); }
});

test('background detection has a wider hard timeout without weakening the query timeout', async () => {
  const client = makeClient('medium', { detectorTimeoutMs: 80, backgroundTimeoutMs: 300 });
  try {
    await ready(client);
    const background = await client.detect('inbox/background.jpg', { expectedSha256: 'a'.repeat(64), priority: 'background' });
    assert.equal(background.detectorVersion, 'detector-v1');
    await assert.rejects(client.detect('inbox/query.jpg', { expectedSha256: 'b'.repeat(64), priority: 'query' }), error => error.code === 'DETECTOR_TIMEOUT');
  } finally { await client.close(); }
});

test('detector timeout, malformed output, crash, and missing model remain isolated', async () => {
  for (const [mode, code] of [['hang', 'DETECTOR_TIMEOUT'], ['malformed', 'DETECTOR_PROTOCOL_ERROR'], ['crash', 'DETECTOR_PROCESS_EXITED'], ['missing', 'DETECTOR_UNAVAILABLE']]) {
    const client = makeClient(mode, { detectorTimeoutMs: 200 });
    try {
      await ready(client);
      await assert.rejects(client.detect('inbox/private.jpg', { expectedSha256: 'e'.repeat(64), priority: 'query' }), error => error.code === code);
    } finally { await client.close(); }
  }
});

test('detector stats classify an unexpected child exit without exposing stderr or paths', async () => {
  const client = makeClient('crash-resource');
  try {
    await ready(client);
    await assert.rejects(client.detect('inbox/private.jpg', { expectedSha256: 'f'.repeat(64) }), error => error.code === 'DETECTOR_PROCESS_EXITED');
    const stats = client.stats();
    assert.equal(stats.lastExitCode, 23);
    assert.equal(stats.lastExitSignal, null);
    assert.equal(stats.lastStderrCategory, 'resource_exhausted');
    assert.equal(JSON.stringify(stats).includes('private'), false);
    assert.equal(JSON.stringify(stats).includes('photo.jpg'), false);
  } finally { await client.close(); }
});

test('detector stats retain a safe spawn error code without exposing the command', async () => {
  const client = createDetectorProcessClient({
    command: join(tmpdir(), 'missing-private-python.exe'), workerPath,
    inboxDir: 'inbox', weightPath: 'weight', detectorVersion: 'detector-v1', pollMs: 10,
  });
  try {
    const deadline = Date.now() + 2000;
    while (!client.stats().lastSpawnErrorCode && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const stats = client.stats();
    assert.equal(stats.lastSpawnErrorCode, 'ENOENT');
    assert.equal(JSON.stringify(stats).includes('missing-private-python'), false);
  } finally { await client.close(); }
});

test('detector stats retain the fatal timeout when queued jobs later see process exit', async () => {
  const client = makeClient('hang', { maxQueue: 2, detectorTimeoutMs: 80 });
  try {
    await ready(client);
    const first = client.detect('inbox/a.jpg', { expectedSha256: 'a'.repeat(64), priority: 'query' });
    const second = client.detect('inbox/b.jpg', { expectedSha256: 'b'.repeat(64), priority: 'query' });
    await Promise.allSettled([first, second]);
    assert.equal(client.stats().lastFatalErrorCode, 'DETECTOR_TIMEOUT');
  } finally { await client.close(); }
});

test('detector child receives only the offline tool-owned runtime environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'porch-detector-env-'));
  const runtimeDir = join(root, 'runtime');
  const client = makeClient('env-contract', {
    runtimeDir,
    env: {
      ...process.env,
      PIP_INDEX_URL: 'https://private.example/simple',
      PIP_EXTRA_INDEX_URL: 'https://user:secret@private.example/simple',
      PIP_TRUSTED_HOST: 'private.example',
      UV_INDEX_URL: 'https://private.example/simple',
    },
  });
  try {
    await ready(client);
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
