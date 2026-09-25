import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import { createImageMemoryBackfillRunner } from './image-memory-backfill.mjs';
import { initializeImageMemoryPolicy, readImageMemoryPolicy } from './image-memory-policy.mjs';
import { revalidateImageRecallForBridge } from './image-memory-chat.mjs';
import { createImageMemoryClient } from './image-memory.mjs';
import { createImageMemoryWorker } from './tools/image-memory/worker.mjs';
import { openImageStore } from './tools/image-memory/store.mjs';

const realWorkerPath = fileURLToPath(new URL('./tools/image-memory/worker.mjs', import.meta.url));
const sourceFeatureWorkerPath = fileURLToPath(new URL('./tools/image-memory/test-fixtures/source-feature-worker.mjs', import.meta.url));
const embeddingFixturePath = fileURLToPath(new URL('./tools/image-memory/test-fixtures/embedding-worker.mjs', import.meta.url));

test('background backfill starts full, advances a durable cursor, then scans only appended history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-backfill-cursor-'));
  const historyPath = join(dir, 'history.jsonl');
  const cursorPath = join(dir, 'data', 'cursor.json');
  writeFileSync(historyPath, '{"one":1}\n');
  const calls = [];
  const runner = createImageMemoryBackfillRunner({
    historyPath, statePath: join(dir, 'state.json'), inboxDir: join(dir, 'inbox'), policyPath: join(dir, 'policy.json'), cursorPath,
    collect: async options => { calls.push(options); return { sources: [{ occurrenceId: String(calls.length) }], denied: [], issues: [], cursor: { historyBytes: options.historyStart + 10, latestSourceTs: calls.length * 100 } }; },
    client: { async backfill() { return { indexed: 1, unchanged: 0, pendingEmbedding: 0, failed: 0, codes: [] }; }, async reconcile() { return { removed: 0 }; } },
    now: (() => { let value = 1000; return () => value++; })(),
  });
  try {
    const first = await runner.run();
    assert.equal(first.full, true);
    assert.equal(calls[0].historyStart, 0);
    appendFileSync(historyPath, '{"two":2}\n');
    const second = await runner.run();
    assert.equal(second.full, false);
    assert.equal(calls[1].historyStart, 10);
    assert.equal(calls[1].stateAfterTs, 100);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('history truncation forces a full rescan and failed batches do not advance the cursor', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-backfill-truncate-'));
  const historyPath = join(dir, 'history.jsonl');
  const cursorPath = join(dir, 'data', 'cursor.json');
  writeFileSync(historyPath, '01234567890123456789');
  let failed = false;
  const starts = [];
  const runner = createImageMemoryBackfillRunner({
    historyPath, statePath: '', inboxDir: '', policyPath: '', cursorPath,
    collect: async options => { starts.push(options.historyStart); return { sources: [{ occurrenceId: 'x' }], denied: [], issues: [], cursor: { historyBytes: 20, latestSourceTs: 100 } }; },
    client: { async backfill() { return { indexed: 0, unchanged: 0, pendingEmbedding: 0, failed: failed ? 1 : 0, codes: [] }; }, async reconcile() { return { removed: 0 }; } },
    now: () => 1000,
  });
  try {
    await runner.run();
    truncateSync(historyPath, 5);
    failed = true;
    const result = await runner.run();
    assert.equal(result.full, true);
    assert.deepEqual(starts, [0, 0]);
    assert.equal(result.cursorAdvanced, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pending embeddings and source read issues keep the cursor retryable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-backfill-retry-'));
  const historyPath = join(dir, 'history.jsonl');
  const cursorPath = join(dir, 'data', 'cursor.json');
  writeFileSync(historyPath, '{"one":1}\n');
  let attempt = 0;
  let issues = [];
  const runner = createImageMemoryBackfillRunner({
    historyPath, statePath: '', inboxDir: '', policyPath: '', cursorPath,
    collect: async options => ({ sources: [{ occurrenceId: 'x' }], denied: [], issues, cursor: { historyBytes: options.historyStart + 10, latestSourceTs: 100 } }),
    client: {
      async backfill() { attempt++; return attempt === 1 ? { indexed: 1, unchanged: 0, pendingEmbedding: 1, failed: 0, codes: [] } : { indexed: 0, unchanged: 1, pendingEmbedding: 0, failed: 0, codes: [] }; },
      async reconcile() { return { removed: 0 }; },
    },
    now: () => 1000,
  });
  try {
    const pending = await runner.run();
    assert.equal(pending.cursorAdvanced, false);
    assert.equal(pending.retryAfterMs, 60000);
    const completed = await runner.run();
    assert.equal(completed.cursorAdvanced, true);
    issues = [{ code: 'HISTORY_READ_FAILED' }];
    const withIssue = await runner.run();
    assert.equal(withIssue.cursorAdvanced, false);
    assert.equal(withIssue.retryAfterMs, 60000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pending region channels keep the cursor retryable until fixed and detector sets are durable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-backfill-regions-'));
  const historyPath = join(dir, 'history.jsonl');
  const cursorPath = join(dir, 'data', 'cursor.json');
  writeFileSync(historyPath, '{"one":1}\n');
  let attempt = 0;
  const runner = createImageMemoryBackfillRunner({
    historyPath, statePath: '', inboxDir: '', policyPath: '', cursorPath,
    collect: async options => ({
      sources: [{ occurrenceId: 'x' }], denied: [], issues: [],
      cursor: { historyBytes: options.historyStart + 10, latestSourceTs: 100 },
    }),
    client: {
      async backfill() {
        attempt++;
        return attempt === 1
          ? { indexed: 1, unchanged: 0, pendingEmbedding: 0, pendingRegions: 1, failed: 0, codes: ['DETECTOR_WARMING'] }
          : { indexed: 0, unchanged: 1, pendingEmbedding: 0, pendingRegions: 0, failed: 0, codes: [] };
      },
      async reconcile() { return { removed: 0 }; },
    },
    now: () => 1000,
  });
  try {
    const pending = await runner.run();
    assert.equal(pending.pendingRegions, 1);
    assert.equal(pending.cursorAdvanced, false);
    assert.equal(pending.retryAfterMs, 60000);
    const completed = await runner.run();
    assert.equal(completed.pendingRegions, 0);
    assert.equal(completed.cursorAdvanced, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cached runner asks for the current client on every run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-backfill-client-'));
  const historyPath = join(dir, 'history.jsonl');
  writeFileSync(historyPath, '{"one":1}\n');
  const calls = [];
  let current = 'first';
  const clients = Object.fromEntries(['first', 'second'].map(name => [name, {
    async backfill() { calls.push(name); return { indexed: 0, unchanged: 1, pendingEmbedding: 0, failed: 0, codes: [] }; },
    async reconcile() { return { removed: 0 }; },
  }]));
  const runner = createImageMemoryBackfillRunner({
    historyPath, cursorPath: join(dir, 'cursor.json'),
    collect: async () => ({ sources: [{ occurrenceId: 'x' }], denied: [], issues: [], cursor: { historyBytes: 10, latestSourceTs: 1 } }),
    getClient: () => clients[current],
    now: (() => { let value = 1000; return () => value++; })(),
  });
  try {
    await runner.run();
    current = 'second';
    await runner.run();
    assert.deepEqual(calls, ['first', 'second']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a region or feature fingerprint change forces an immediate full rescan and reconcile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-backfill-feature-'));
  const historyPath = join(dir, 'history.jsonl');
  const cursorPath = join(dir, 'cursor.json');
  writeFileSync(historyPath, '{"one":1}\n');
  let featureFingerprint = 'whole-only-v1';
  const starts = [];
  let reconciles = 0;
  const runner = createImageMemoryBackfillRunner({
    historyPath, cursorPath,
    getFeatureFingerprint: () => featureFingerprint,
    collect: async options => {
      starts.push(options.historyStart);
      return { sources: [{ occurrenceId: 'x' }], denied: [], issues: [], cursor: { historyBytes: 10, latestSourceTs: 100 } };
    },
    client: {
      async backfill() { return { indexed: 0, unchanged: 1, pendingEmbedding: 0, pendingRegions: 0, failed: 0, codes: [] }; },
      async reconcile() { reconciles++; return { removed: 0 }; },
    },
    now: (() => { let value = 1000; return () => value++; })(),
  });
  try {
    assert.equal((await runner.run()).full, true);
    assert.equal((await runner.run()).full, false);
    featureFingerprint = 'regions-fixed-v2-yolo-v2';
    assert.equal((await runner.run()).full, true);
    assert.deepEqual(starts, [0, 10, 0]);
    assert.equal(reconciles, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('background backfill syncs strict chat, life, and album snapshots and never submits unreadable JSON as empty complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-backfill-sources-'));
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const lifePath = join(dir, 'life.json');
  const albumsPath = join(dir, 'albums.json');
  writeFileSync(historyPath, `${JSON.stringify({ role: 'user', messageId: 'm1', conversationId: 'c1', text: 'photo', images: ['inbox/a.png'], ts: '2026-09-20T01:00:00Z' })}\n`);
  writeFileSync(statePath, JSON.stringify({ log: [] }));
  writeFileSync(lifePath, JSON.stringify([]));
  writeFileSync(albumsPath, JSON.stringify({ albums: [] }));
  const synced = [];
  const client = {
    async stats() { return { sourceSnapshots: [
      { sourceType: 'chat', generation: 4, revision: 'chat-old' },
      { sourceType: 'life', generation: 2, revision: 'life-old' },
      { sourceType: 'album', generation: 7, revision: 'album-old' },
    ] }; },
    async syncSourceSnapshot(snapshot) { synced.push({ sourceType: snapshot.sourceType, status: snapshot.status, count: snapshot.memberships.length, base: snapshot.base }); return {}; },
    async backfill() { return { indexed: 0, unchanged: 0, pendingEmbedding: 0, pendingRegions: 0, failed: 0, codes: [] }; },
    async reconcile() { return { removed: 0 }; },
  };
  const runner = createImageMemoryBackfillRunner({
    historyPath, statePath, lifePath, albumsPath, cursorPath: join(dir, 'cursor.json'), client,
    collect: async () => ({ sources: [], denied: [], issues: [], cursor: { historyBytes: 1, latestSourceTs: 1 } }),
    now: (() => { let value = 1000; return () => value++; })(),
  });
  try {
    assert.equal((await runner.run()).sourceSynced, 3);
    assert.deepEqual(synced.map(row => row.sourceType).sort(), ['album', 'chat', 'life']);
    assert.deepEqual(Object.fromEntries(synced.map(row => [row.sourceType, row.base])), {
      chat: { generation: 4, revision: 'chat-old' },
      life: { generation: 2, revision: 'life-old' },
      album: { generation: 7, revision: 'album-old' },
    });
    writeFileSync(lifePath, '{');
    synced.length = 0;
    const unreadable = await runner.run();
    assert.equal(unreadable.sourceSynced, 2);
    assert.ok(unreadable.issues.some(issue => issue.sourceType === 'life'));
    assert.deepEqual(synced.map(row => row.sourceType).sort(), ['album', 'chat']);
    writeFileSync(lifePath, JSON.stringify([]));
    writeFileSync(historyPath, [
      JSON.stringify({ role: 'user', messageId: 'm1', conversationId: 'c1', text: 'photo', images: ['inbox/a.png'], ts: '2026-09-20T01:00:00Z' }),
      '{invalid}',
      JSON.stringify({ role: 'resident', messageId: 'm2', conversationId: 'c1', text: 'after', ts: '2026-09-20T01:01:00Z' }),
    ].join('\n') + '\n');
    synced.length = 0;
    const incompleteChat = await runner.run();
    assert.equal(incompleteChat.sourceSynced, 2);
    assert.ok(incompleteChat.issues.some(issue => issue.sourceType === 'chat' && issue.code === 'IMAGE_SOURCE_UNREADABLE'));
    assert.deepEqual(synced.map(row => row.sourceType).sort(), ['album', 'life']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real runner binds all three snapshots through the child parser, database, recall, and bridge', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-backfill-real-flow-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  writeFileSync(join(inboxDir, 'a.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const base = Date.parse('2026-09-20T01:00:00Z');
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const lifePath = join(dir, 'life.json');
  const albumsPath = join(dir, 'albums.json');
  const policyPath = join(dir, 'policy.json');
  writeFileSync(historyPath, `${JSON.stringify({ role: 'user', messageId: 'photo', conversationId: 'c1', text: 'photo', images: ['inbox/a.png'], ts: new Date(base).toISOString() })}\n`);
  writeFileSync(statePath, JSON.stringify({ log: [] }));
  writeFileSync(lifePath, JSON.stringify([{ id: 'life-1', kind: 'photo', photo: 'inbox/a.png', text: 'life', ts: new Date(base + 1).toISOString() }]));
  writeFileSync(albumsPath, JSON.stringify({ albums: [{ id: 'album-1', name: 'album', items: [{ id: 'item-1', src: 'inbox/a.png', at: new Date(base + 2).toISOString() }] }] }));
  initializeImageMemoryPolicy(policyPath);
  const client = createImageMemoryClient({ enabled: true, workerPath: realWorkerPath, cwd: dir, inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, timeoutMs: 5000 });
  const runner = createImageMemoryBackfillRunner({
    historyPath, statePath, lifePath, albumsPath, inboxDir, policyPath, cursorPath: join(dir, 'cursor.json'), client,
    collect: async () => ({ sources: [], denied: [], issues: [], cursor: { historyBytes: 1, latestSourceTs: base } }),
    now: () => base + 10000,
  });
  try {
    assert.equal((await runner.run()).sourceSynced, 3);
    assert.deepEqual((await client.stats()).sourceSnapshots.map(row => [row.sourceType, row.generation]), [['album', 1], ['chat', 1], ['life', 1]]);
    const recalled = await client.recallBatch({ queries: [{ queryId: 'q', occurrenceId: 'current', relativePath: 'inbox/a.png' }], beforeTs: base + 60000, excludeOccurrenceIds: [] });
    assert.equal(recalled.matches.length, 1);
    assert.deepEqual(recalled.matches[0].sources.map(row => row.sourceType).sort(), ['album', 'chat', 'life']);
    const bridged = await revalidateImageRecallForBridge({
      recallResult: recalled, beforeTs: base + 60000, deadlineAt: Date.now() + 1000, policyPath,
      historyPath, statePath, lifePath, albumsPath, hashAsset: async () => recalled.matches[0].sha256,
    });
    assert.equal(bridged.matches.length, 1);
    assert.deepEqual(bridged.matches[0].sources.map(row => row.sourceType).sort(), ['album', 'chat', 'life']);
    assert.deepEqual(bridged.matches[0].context.map(row => row.messageId), ['photo']);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('life-only and album-only assets keep the runner retryable until visual and region features are durable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-source-features-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  await sharp({ create: { width: 96, height: 72, channels: 3, background: { r: 200, g: 20, b: 30 } } }).png().toFile(join(inboxDir, 'life.png'));
  await sharp({ create: { width: 80, height: 100, channels: 3, background: { r: 20, g: 40, b: 210 } } }).png().toFile(join(inboxDir, 'album.png'));
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const lifePath = join(dir, 'life.json');
  const albumsPath = join(dir, 'albums.json');
  const policyPath = join(dir, 'policy.json');
  const dbPath = join(dir, 'index.sqlite');
  const manifestPath = join(dir, 'manifest.json');
  const base = Date.parse('2026-09-20T01:00:00Z');
  writeFileSync(historyPath, '');
  writeFileSync(statePath, JSON.stringify({ log: [] }));
  writeFileSync(lifePath, JSON.stringify([{ id: 'life-1', kind: 'photo', photo: 'inbox/life.png', text: 'life', ts: new Date(base).toISOString() }]));
  writeFileSync(albumsPath, JSON.stringify({ albums: [{ id: 'album-1', name: 'album', items: [{ id: 'item-1', src: 'inbox/album.png', at: new Date(base + 1).toISOString() }] }] }));
  writeFileSync(manifestPath, JSON.stringify({ revision: 'fixture-revision', embeddingVersion: 'v1' }));
  initializeImageMemoryPolicy(policyPath);
  const client = createImageMemoryClient({
    enabled: true, workerPath: sourceFeatureWorkerPath, embeddingWorkerPath: embeddingFixturePath,
    cwd: dir, inboxDir, dbPath, policyPath, manifestPath, cacheDir: join(dir, 'cache'), regionsEnabled: true, timeoutMs: 5000,
  });
  const runner = createImageMemoryBackfillRunner({
    historyPath, statePath, lifePath, albumsPath, inboxDir, policyPath, cursorPath: join(dir, 'cursor.json'), client,
    collect: async () => ({ sources: [], denied: [], issues: [], cursor: { historyBytes: 0, latestSourceTs: base } }),
    now: (() => { let value = base + 10000; return () => value++; })(),
  });
  try {
    let result = await runner.run();
    assert.equal(result.selected, 0);
    assert.equal(result.cursorAdvanced, false);
    assert.ok(result.pendingEmbedding > 0 || result.pendingRegions > 0);
    for (let attempt = 0; attempt < 40 && !result.cursorAdvanced; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 25));
      result = await runner.run();
    }
    assert.equal(result.cursorAdvanced, true, JSON.stringify({ result, stats: await client.stats() }));
    const stats = await client.stats();
    assert.deepEqual({ images: stats.images, pendingEmbedding: stats.pendingEmbedding, pendingRegions: stats.pendingRegions, fixedSets: stats.fixedSets, yoloSets: stats.yoloSets }, {
      images: 2, pendingEmbedding: 0, pendingRegions: 0, fixedSets: 2, yoloSets: 2,
    });
    writeFileSync(lifePath, '[]');
    assert.equal((await runner.run()).cursorAdvanced, true);
    await client.close();
    const db = openImageStore(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM images WHERE embedding IS NOT NULL').get().count, 2);
      assert.deepEqual(db.prepare('SELECT source_type FROM source_memberships ORDER BY source_type').all().map(row => row.source_type), ['album']);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM occurrences').get().count, 0);
    } finally { db.close(); }
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a newly private source is persisted by path and sha, removed, and cannot return on rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-backfill-denial-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir);
  const imagePath = join(inboxDir, 'a.png');
  writeFileSync(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  copyFileSync(imagePath, join(inboxDir, 'b.png'));
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const policyPath = join(dir, 'policy.json');
  const cursorPath = join(dir, 'cursor.json');
  writeFileSync(historyPath, [
    JSON.stringify({ role: 'user', ts: 100, images: ['inbox/a.png'], text: 'safe a' }),
    JSON.stringify({ role: 'user', ts: 110, images: ['inbox/b.png'], text: 'same bytes under another path' }),
  ].join('\n') + '\n');
  writeFileSync(statePath, JSON.stringify({ log: [] }));
  initializeImageMemoryPolicy(policyPath);
  const worker = createImageMemoryWorker({ inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath });
  const client = {
    backfill: sources => worker.handle({ id: 'backfill', op: 'backfill', sources, deadlineMs: 5000 }),
    reconcile: () => worker.handle({ id: 'reconcile', op: 'reconcile', deadlineMs: 5000 }),
    revoke: relativePaths => worker.handle({ id: 'revoke', op: 'revoke', relativePaths }),
  };
  const runner = createImageMemoryBackfillRunner({ historyPath, statePath, inboxDir, policyPath, cursorPath, client, now: () => 1000, fullIntervalMs: 0 });
  try {
    assert.equal((await runner.run()).indexed, 2);
    writeFileSync(statePath, JSON.stringify({ log: [{ role: 'user', ts: 200, images: ['inbox/a.png'], memorySafe: false }] }));
    const denied = await runner.run();
    assert.equal(denied.denied, 1);
    assert.equal(denied.selected, 0);
    assert.equal(denied.failed, 0);
    assert.ok(Number.isFinite(readImageMemoryPolicy(policyPath).paths['inbox/a.png']));
    assert.equal(Object.keys(readImageMemoryPolicy(policyPath).shas).length, 1);
    const recalled = await worker.handle({ id: 'recall', op: 'recall', queries: [{ queryId: 'q', occurrenceId: 'new', relativePath: 'inbox/b.png' }], beforeTs: 300, excludeOccurrenceIds: [], deadlineMs: 5000, limits: { maxHits: 3, pHashMaxDistance: 8, visualMinScore: 0.88 } });
    assert.deepEqual(recalled.matches, []);
    const rebuilt = await worker.handle({ id: 'rebuild', op: 'backfill', sources: [{ occurrenceId: 'old', relativePath: 'inbox/b.png', sourceTs: 110, sourceText: 'safe' }], deadlineMs: 5000 });
    assert.equal(rebuilt.failed, 1);
    assert.equal((await worker.handle({ id: 'stats', op: 'stats' })).images, 0);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});
