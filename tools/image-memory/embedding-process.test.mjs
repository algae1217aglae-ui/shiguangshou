import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createEmbeddingProcessClient } from './embedding-process.mjs';

const workerPath = fileURLToPath(new URL('./test-fixtures/embedding-worker.mjs', import.meta.url));

async function ready(client) {
  const end = Date.now() + 2000;
  while (!client.ready && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(client.ready, true);
}

test('embedding process keeps one inference active and returns versioned vectors', async () => {
  const client = createEmbeddingProcessClient({ workerPath, inboxDir: 'inbox', manifestPath: 'manifest', cacheDir: 'cache', embeddingVersion: 'v1', extraArgs: ['--mode', 'good'], pollMs: 10, inferenceTimeoutMs: 500 });
  try {
    await ready(client);
    const [one, two] = await Promise.all([client.embed('inbox/a.png'), client.embed('inbox/b.png')]);
    assert.deepEqual([...one], [1, 0]);
    assert.deepEqual([...two], [1, 0]);
    assert.equal(client.queued, 0);
  } finally { await client.close(); }
});

test('hung inference is killed and enters cooldown without leaving queued promises', async () => {
  const client = createEmbeddingProcessClient({ workerPath, inboxDir: 'inbox', manifestPath: 'manifest', cacheDir: 'cache', embeddingVersion: 'v1', extraArgs: ['--mode', 'hang'], pollMs: 10, inferenceTimeoutMs: 50, cooldownMs: 500 });
  try {
    await ready(client);
    await assert.rejects(client.embed('inbox/a.png'), error => error.code === 'MODEL_TIMEOUT');
    await assert.rejects(client.embed('inbox/b.png'), error => error.code === 'MODEL_COOLDOWN');
  } finally { await client.close(); }
});

test('missing model and process crash are reported without protocol text leakage', async () => {
  for (const mode of ['missing', 'crash']) {
    const client = createEmbeddingProcessClient({ workerPath, inboxDir: 'inbox', manifestPath: 'manifest', cacheDir: 'cache', embeddingVersion: 'v1', extraArgs: ['--mode', mode], pollMs: 10, inferenceTimeoutMs: 500, cooldownMs: 100 });
    try {
      await ready(client);
      await assert.rejects(client.embed('inbox/private.png'), error => ['MODEL_UNAVAILABLE', 'MODEL_PROCESS_EXITED'].includes(error.code));
    } finally { await client.close(); }
  }
});

test('model warmup has a hard limit and enters cooldown', async () => {
  const client = createEmbeddingProcessClient({ workerPath, inboxDir: 'inbox', manifestPath: 'manifest', cacheDir: 'cache', embeddingVersion: 'v1', extraArgs: ['--mode', 'warming'], pollMs: 10, warmupTimeoutMs: 50, cooldownMs: 500 });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(client.ready, false);
    await assert.rejects(client.embed('inbox/a.png'), error => error.code === 'MODEL_COOLDOWN');
  } finally { await client.close(); }
});

test('an exited embedding generation cannot clear a replacement process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-embedding-generation-'));
  const marker = join(dir, 'hung-once');
  const client = createEmbeddingProcessClient({ workerPath, inboxDir: 'inbox', manifestPath: 'manifest', cacheDir: 'cache', embeddingVersion: 'v1', extraArgs: ['--mode', 'hang-once', '--marker', marker], pollMs: 10, inferenceTimeoutMs: 50, cooldownMs: 0 });
  try {
    await ready(client);
    await assert.rejects(client.embed('inbox/first.png'), error => error.code === 'MODEL_TIMEOUT');
    await assert.rejects(client.embed('inbox/restart.png'), error => error.code === 'MODEL_WARMING');
    await ready(client);
    assert.deepEqual([...(await client.embed('inbox/second.png'))], [1, 0]);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('batched region embedding is bounded and query work jumps ahead of queued background work', async () => {
  const client = createEmbeddingProcessClient({ workerPath, inboxDir: 'inbox', manifestPath: 'manifest', cacheDir: 'cache', embeddingVersion: 'v1', extraArgs: ['--mode', 'slow'], pollMs: 10, inferenceTimeoutMs: 500 });
  const descriptors = [
    { regionId: 'fixed:a', channel: 'fixed', bbox: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    { regionId: 'fixed:b', channel: 'fixed', bbox: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
  ];
  const order = [];
  try {
    await ready(client);
    const active = client.embed('inbox/active.png', { priority: 'background' }).then(() => order.push('active'));
    const background = client.embed('inbox/background.png', { priority: 'background' }).then(() => order.push('background'));
    const query = client.embedRegions('inbox/query.png', descriptors, { expectedSha256: 'a'.repeat(64), priority: 'query' }).then(value => { order.push('query'); return value; });
    const vectors = await query;
    assert.deepEqual(vectors.map(vector => [...vector]), [[1, 0], [0, 1]]);
    await Promise.all([active, background]);
    assert.deepEqual(order, ['active', 'query', 'background']);
    await assert.rejects(client.embedRegions('inbox/query.png', Array(6).fill(descriptors[0]), { expectedSha256: 'a'.repeat(64), priority: 'query' }), error => error.code === 'IMAGE_REGION_INVALID');
  } finally { await client.close(); }
});
