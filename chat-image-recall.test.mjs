import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { assembleImageRecallBridgeDelivery, assembleImageRecallPrompts, formatUnconfirmedAngleContext, handleImageMemoryChatRoute, imageRecallPromptsForCurrentPolicy, persistChatEntriesAfterAsyncWork, prepareImageRecallBatch, prepareImageRecallBridgeDispatch, revalidateImageRecallForBridge } from './image-memory-chat.mjs';
import { initializeImageMemoryPolicy, readImageMemoryPolicy, revokeImageMemoryAsync } from './image-memory-policy.mjs';
import { readAlbumImageSourceSnapshot, readChatImageSourceSnapshot } from './image-memory-sources.mjs';
import { selectChatContextWindow } from './image-memory-context.mjs';

const entries = baseTs => [
  { role: 'user', ts: new Date(baseTs).toISOString(), text: 'first', images: ['inbox/a.jpg'] },
  { role: 'user', ts: new Date(baseTs + 1).toISOString(), text: 'second', images: ['inbox/b.jpg'] },
];

test('chat image recall uses one batch, source dates, query ids, and excludes all current occurrences', async () => {
  const calls = [];
  const client = { recallBatch: async request => { calls.push(request); return { matches: [], warnings: [], channels: { hash: 'ready', visual: 'unavailable' } }; } };
  const baseTs = Date.parse('2026-09-24T00:00:00Z');
  const prepared = await prepareImageRecallBatch({
    entries: entries(baseTs), batchId: 'batch', baseTs, client,
    resolveSource: async source => source,
  });
  await prepared.recallPromise;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].beforeTs, baseTs);
  assert.deepEqual(calls[0].queries.map(row => row.queryId), ['batch:0', 'batch:1']);
  assert.deepEqual(calls[0].excludeOccurrenceIds, prepared.sources.map(row => row.occurrenceId));
  assert.equal(prepared.sources[1].sourceTs, baseTs + 1);
  assert.equal(prepared.sources[1].sourceText, 'second');
});

test('chat only requests angle fallback when the active bridge supports native candidate images', async () => {
  const calls = [];
  const client = { recallBatch: async request => { calls.push(request); return { matches: [] }; } };
  const baseTs = Date.parse('2026-09-24T00:00:00Z');
  await (await prepareImageRecallBatch({ entries: entries(baseTs), batchId: 'codex', baseTs, client, angleFallbackEnabled: true, resolveSource: async source => source })).recallPromise;
  await (await prepareImageRecallBatch({ entries: entries(baseTs), batchId: 'claude', baseTs, client, angleFallbackEnabled: false, resolveSource: async source => source })).recallPromise;
  assert.equal(calls[0].angleFallbackEnabled, true);
  assert.equal(calls[1].angleFallbackEnabled, false);
});

test('production chat handler forwards the active bridge angle capability into its one recall batch', async () => {
  const calls = [];
  let state = { log: [], msgTotal: 0 };
  const route = await handleImageMemoryChatRoute({
    entries: entries(1000), batchId: 'route', baseTs: 1000, deadlineAt: Date.now() + 500,
    angleFallbackEnabled: true,
    client: { recallBatch: async request => { calls.push(request); return { matches: [] }; }, indexBatch: async () => ({ indexed: 0 }) },
    resolveSource: async source => source,
    loadState: () => structuredClone(state), saveState: value => { state = structuredClone(value); },
    appendEntries: (value, rows) => { value.log.push(...rows); },
  });
  await route.finishRecall();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].angleFallbackEnabled, true);
});

test('one invalid image is isolated while other images still recall', async () => {
  let queries = [];
  const prepared = await prepareImageRecallBatch({
    entries: entries(1000), batchId: 'batch', baseTs: 1000,
    client: { recallBatch: async request => { queries = request.queries; return { matches: [], warnings: [], channels: { hash: 'ready', visual: 'unavailable' } }; } },
    resolveSource: async source => { if (source.relativePath.endsWith('a.jpg')) throw Object.assign(new Error('bad'), { code: 'IMAGE_DECODE_FAILED' }); return source; },
  });
  await prepared.recallPromise;
  assert.deepEqual(queries.map(row => row.relativePath), ['inbox/b.jpg']);
  assert.deepEqual(prepared.issues, [{ code: 'IMAGE_DECODE_FAILED' }]);
});

test('source preparation and worker share one absolute deadline', async () => {
  const started = Date.now();
  let workerCalled = false;
  const prepared = await prepareImageRecallBatch({
    entries: entries(1000), batchId: 'batch', baseTs: 1000, deadlineAt: started + 25,
    client: { recallBatch: async () => { workerCalled = true; return { matches: [] }; } },
    resolveSource: () => new Promise(resolve => setTimeout(resolve, 100)),
  });
  await prepared.recallPromise;
  assert.equal(workerCalled, false);
  assert.equal(prepared.sources.length, 0);
  assert.ok(Date.now() - started < 90);
});

test('batch privacy persists before recall and marks every matching entry unsafe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-chat-image-'));
  const policyPath = join(dir, 'policy.json');
  const batch = [
    { role: 'user', ts: new Date(1000).toISOString(), text: '不要存' },
    { role: 'user', ts: new Date(1001).toISOString(), text: '', images: ['inbox/a.jpg'] },
    { role: 'user', ts: new Date(1002).toISOString(), text: '', images: ['inbox/b.jpg'] },
  ];
  let called = false;
  try {
    initializeImageMemoryPolicy(policyPath);
    const prepared = await prepareImageRecallBatch({
      entries: batch, batchId: 'batch', baseTs: 1000, policyPath,
      client: { recallBatch: async () => { called = true; return {}; } },
      resolveSource: async source => source,
      shaForSource: async source => source.relativePath.endsWith('a.jpg') ? 'a'.repeat(64) : 'b'.repeat(64),
    });
    assert.deepEqual(prepared.sources, []);
    assert.equal(called, false);
    assert.equal(batch[1].memorySafe, false);
    assert.equal(batch[2].memorySafe, false);
    const policy = readImageMemoryPolicy(policyPath);
    assert.deepEqual(Object.keys(policy.paths).sort(), ['inbox/a.jpg', 'inbox/b.jpg']);
    assert.deepEqual(Object.keys(policy.shas).sort(), ['a'.repeat(64), 'b'.repeat(64)]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('main prompt receives bounded candidates beside the photo note while both GLM routes stay clean', () => {
  const result = assembleImageRecallPrompts({
    basePromptText: 'BASE\nPHOTO NOTE',
    imageRecallContext: '【圖片回憶候選】\nold image',
  });
  assert.match(result.promptText, /PHOTO NOTE\n【圖片回憶候選】/);
  assert.doesNotMatch(result.forcedGlmPromptText, /圖片回憶候選/);
  assert.doesNotMatch(result.fallbackGlmPromptText, /圖片回憶候選/);
  assert.equal(result.forcedGlmPromptText, 'BASE\nPHOTO NOTE');
});

test('unconfirmed angle context maps queries, fixed regions and diagnostic-only YOLO without claiming identity', () => {
  const context = formatUnconfirmedAngleContext([{
    candidateType: 'unconfirmed_angle', confidence: 'unconfirmed', relativePath: 'inbox/old.jpg',
    queryEvidence: [{
      queryId: 'q', queryRelativePath: 'inbox/query.jpg', whole: { score: 0.74, rank: 1 },
      fixed: { score: 0.79, rank: 2, queryRegionId: 'fq', queryRegionBbox: { x: 0, y: 0, width: 1, height: 1 }, candidateRegionId: 'fc', candidateRegionBbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } },
      yoloDiagnostic: { score: 0.81, rank: 1, classAgreement: true },
    }],
  }]);
  assert.match(context, /未確認的不同角度相似候補/);
  assert.match(context, /candidateType=unconfirmed_angle confidence=unconfirmed/);
  assert.match(context, /queryPath=inbox\/query\.jpg/);
  assert.match(context, /candidatePath=inbox\/old\.jpg/);
  assert.match(context, /fixedQueryRegion=fq/);
  assert.match(context, /diagnosticOnly=true/);
  assert.match(context, /不要據此自動寫入長期記憶/);
  assert.doesNotMatch(context, /已確認是同一物件/);
});

test('bridge delivery changes attachments only for enabled Codex and keeps Claude and GLM candidate-free', () => {
  const liveRecall = {
    context: 'STRICT\nANGLE',
    strictContext: 'STRICT',
    recalledImagePaths: ['C:/porch/inbox/old.jpg'],
  };
  const codex = assembleImageRecallBridgeDelivery({ bridgeKind: 'codex', angleFallbackEnabled: true, photoPaths: ['inbox/query.jpg'], liveRecall });
  assert.deepEqual(codex.images, ['inbox/query.jpg', 'C:/porch/inbox/old.jpg']);
  assert.equal(codex.context, 'STRICT\nANGLE');
  for (const bridgeKind of ['claude', 'glm']) {
    const delivery = assembleImageRecallBridgeDelivery({ bridgeKind, angleFallbackEnabled: true, photoPaths: ['inbox/query.jpg'], liveRecall });
    assert.deepEqual(delivery.images, ['inbox/query.jpg']);
    assert.equal(delivery.context, 'STRICT');
  }
  const off = assembleImageRecallBridgeDelivery({ bridgeKind: 'codex', angleFallbackEnabled: false, photoPaths: ['inbox/query.jpg'], liveRecall });
  assert.deepEqual(off.images, ['inbox/query.jpg']);
  assert.equal(off.context, 'STRICT');
});

test('shared bridge dispatch runs final revalidation before assembling Codex images and context', async () => withBridgePolicy(async ({ policyPath }) => {
  const source = albumSource(1);
  const dispatched = await prepareImageRecallBridgeDispatch({
    bridgeKind: 'codex', angleFallbackEnabled: true, maxHits: 1, photoPaths: ['C:/porch/inbox/query.png'],
    revalidation: {
      recallResult: { matches: [], unconfirmedCandidatePool: [{
        occurrenceId: 'angle', relativePath: source.relativePath, sha256: 'a'.repeat(64), sourceTs: 2, sources: [source], queryIds: ['q'],
        wholeCosine: 0.8, fixedCosine: 0.8,
        queryEvidence: [{ queryId: 'q', queryRelativePath: 'inbox/q.png', querySha256: 'b'.repeat(64), wholeCosine: 0.8, fixedCosine: 0.8 }],
      }] },
      beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
      loadLiveViews: async () => liveViews([source]),
      hashAsset: async path => path === 'inbox/q.png' ? 'b'.repeat(64) : 'a'.repeat(64),
      resolveAssetPath: async path => `C:/porch/${path}`,
    },
  });
  assert.equal(dispatched.liveRecall.unconfirmedCandidates.length, 1);
  assert.deepEqual(dispatched.images, ['C:/porch/inbox/query.png', 'C:/porch/gallery/a.png']);
  assert.match(dispatched.context, /candidateType=unconfirmed_angle/);
  assert.match(dispatched.context, /未確認候補的來源與對話/);
  assert.match(dispatched.context, /old-1/);
}));

test('candidate conversation uses the shared bounded data formatter and leaves evidence unconfirmed', () => {
  const candidate = {
    relativePath: 'inbox/old.png', sources: [],
    context: [{ contextKind: 'photo', author: 'user', sourceTs: 1, text: '甲'.repeat(300) }],
  };
  const context = formatUnconfirmedAngleContext([candidate], { maxDataChars: 220 });
  const data = context.slice(context.indexOf('【未確認候補的來源與對話】'));
  assert.match(context, /未確認候補的來源與對話/);
  assert.match(data, /使用者：/);
  assert.match(data, /已省略/);
  assert.ok([...data].length <= 220);
  assert.doesNotMatch(data, new RegExp('甲'.repeat(121)));
  assert.match(context, /不要據此自動寫入長期記憶/);
  const exhausted = formatUnconfirmedAngleContext([candidate], { maxDataChars: 0 });
  assert.doesNotMatch(exhausted, /甲|未確認候補的來源與對話/);
});

async function candidateContextDispatch(dir, policyPath, onResolve = () => {}) {
  const lifePath = join(dir, 'life.json'), albumsPath = join(dir, 'albums.json');
  const historyPath = join(dir, 'history.jsonl'), statePath = join(dir, 'state.json');
  const base = Date.parse('2026-09-20T01:00:00Z');
  const rows = [
    { role: 'resident', messageId: 'prior', conversationId: 'c', text: 'CANDIDATE_PRIOR', ts: new Date(base).toISOString() },
    { role: 'user', messageId: 'photo', conversationId: 'c', text: 'CANDIDATE_PHOTO', images: ['inbox/a.png'], ts: new Date(base + 60000).toISOString() },
    { role: 'resident', messageId: 'next', conversationId: 'c', text: 'CANDIDATE_NEXT', ts: new Date(base + 120000).toISOString() },
  ];
  writeFileSync(lifePath, '[]'); writeFileSync(historyPath, '');
  writeFileSync(albumsPath, JSON.stringify({ albums: [{ id: 'a', items: [{ id: 'i', src: 'inbox/a.png', at: new Date(base).toISOString() }] }] }));
  writeFileSync(statePath, JSON.stringify({ log: rows }));
  const chat = readChatImageSourceSnapshot({ historyPath, statePath });
  const album = readAlbumImageSourceSnapshot(albumsPath).memberships[0];
  return prepareImageRecallBridgeDispatch({
    bridgeKind: 'codex', angleFallbackEnabled: true, maxHits: 1, photoPaths: ['C:/porch/inbox/q.png'],
    revalidation: {
      recallResult: { matches: [], unconfirmedCandidatePool: [{
        occurrenceId: 'candidate', relativePath: 'inbox/a.png', sha256: 'a'.repeat(64), sourceTs: base,
        sources: [...chat.memberships, album], queryIds: ['q'], wholeCosine: 0.8, fixedCosine: 0.8,
        queryEvidence: [{ queryId: 'q', queryRelativePath: 'inbox/q.png', querySha256: 'b'.repeat(64), wholeCosine: 0.8, fixedCosine: 0.8 }],
      }] },
      beforeTs: base + 3600000, deadlineAt: Date.now() + 1500, policyPath,
      lifePath, albumsPath, historyPath, statePath,
      hashAsset: async path => path === 'inbox/q.png' ? 'b'.repeat(64) : 'a'.repeat(64),
      resolveAssetPath: async path => { onResolve(rows, statePath); return `C:/porch/${path}`; },
    },
  });
}

test('shared candidate dispatch carries the live photo and surrounding conversation with its original image', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const result = await candidateContextDispatch(dir, policyPath);
  assert.equal(result.liveRecall.unconfirmedCandidates.length, 1);
  assert.deepEqual(result.images, ['C:/porch/inbox/q.png', 'C:/porch/inbox/a.png']);
  assert.match(result.context, /【前文】[^\n]*助理：CANDIDATE_PRIOR/);
  assert.match(result.context, /【照片訊息】[^\n]*使用者：CANDIDATE_PHOTO/);
  assert.match(result.context, /【後文】[^\n]*助理：CANDIDATE_NEXT/);
  for (const bridgeKind of ['claude', 'glm']) {
    const blocked = assembleImageRecallBridgeDelivery({ bridgeKind, angleFallbackEnabled: true, liveRecall: result.liveRecall });
    assert.doesNotMatch(blocked.context, /CANDIDATE_/);
  }
}));

test('candidate dispatch removes chat context when its anchor is withdrawn during attachment resolution', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const result = await candidateContextDispatch(dir, policyPath, (rows, statePath) => {
    writeFileSync(statePath, JSON.stringify({ log: rows.filter(row => row.messageId !== 'photo') }));
  });
  assert.equal(result.liveRecall.unconfirmedCandidates.length, 1);
  assert.equal(result.images.length, 2);
  assert.doesNotMatch(result.context, /CANDIDATE_PRIOR|CANDIDATE_PHOTO|CANDIDATE_NEXT/);
}));

test('candidate conversation stops at a private barrier added while resolving its image', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const result = await candidateContextDispatch(dir, policyPath, (rows, statePath) => {
    writeFileSync(statePath, JSON.stringify({ log: [rows[0], rows[1], { ...rows[2], hidden: true }] }));
  });
  assert.equal(result.liveRecall.unconfirmedCandidates.length, 1);
  assert.match(result.context, /CANDIDATE_PRIOR/);
  assert.match(result.context, /CANDIDATE_PHOTO/);
  assert.doesNotMatch(result.context, /CANDIDATE_NEXT/);
}));

test('empty and timed-out recall produce no prompt injection', () => {
  for (const matches of [[], null]) {
    const result = assembleImageRecallPrompts({ basePromptText: 'BASE', imageRecallContext: matches ? '' : '' });
    assert.equal(result.promptText, 'BASE');
  }
});

test('chat persistence reloads state after asynchronous image preparation and preserves concurrent updates', () => {
  let diskState = { log: [{ role: 'user', text: 'old', ts: '1' }], msgTotal: 1 };
  const staleState = structuredClone(diskState);
  diskState = { log: [...diskState.log, { role: 'resident', text: 'concurrent heartbeat', ts: '2' }], msgTotal: 2, concurrentFlag: true };
  const saved = persistChatEntriesAfterAsyncWork({
    loadState: () => structuredClone(diskState),
    saveState: value => { diskState = structuredClone(value); },
    appendEntries: (state, entries) => { state.log.push(...entries); state.msgTotal += entries.length; },
    entries: [{ role: 'user', text: 'new photo', ts: '3', images: ['inbox/a.jpg'] }],
    prepareState: state => { state.prepared = true; },
  });
  assert.equal(staleState.concurrentFlag, undefined);
  assert.equal(saved.concurrentFlag, true);
  assert.deepEqual(saved.log.map(entry => entry.text), ['old', 'concurrent heartbeat', 'new photo']);
  assert.equal(diskState.msgTotal, 3);
});

test('bridge-time query revocation drops its winning evidence and keeps an unrevoked query for the same candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-chat-query-policy-'));
  const policyPath = join(dir, 'policy.json');
  initializeImageMemoryPolicy(policyPath);
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 1, paths: { 'inbox/revoked-query.png': 10 }, shas: {} }));
  try {
    const candidate = {
      queryIds: ['revoked', 'safe'], relativePath: 'inbox/old.png', sha256: 'a'.repeat(64), occurrenceId: 'old', sourceTs: 1, sourceText: 'old',
      kind: 'visual', cosine: 0.96, visualChannel: 'fixed',
      queryEvidence: [
        { queryId: 'revoked', queryRelativePath: 'inbox/revoked-query.png', querySha256: 'b'.repeat(64), kind: 'visual', cosine: 0.96, visualChannel: 'fixed', fixedCosine: 0.96 },
        { queryId: 'safe', queryRelativePath: 'inbox/safe-query.png', querySha256: 'c'.repeat(64), kind: 'visual', cosine: 0.9, visualChannel: 'yolo', yoloCosine: 0.9 },
      ],
    };
    const result = imageRecallPromptsForCurrentPolicy({ basePromptText: 'BASE', recallResult: { matches: [candidate] }, policyPath });
    assert.deepEqual(result.matches[0].queryIds, ['safe']);
    assert.equal(result.matches[0].cosine, 0.9);
    assert.equal(result.matches[0].visualChannel, 'yolo');
    assert.match(result.promptText, /圖片回憶候選/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function albumSource(index, metadata = {}) {
  return {
    membershipId: `album:a:i${index}`, sourceType: 'album', sourceId: 'a', relativePath: 'gallery/a.png',
    sourceTs: index + 1, sourceText: `old-${index}`, sourceRevision: 'old', locator: { kind: 'album', confidence: 'exact' }, metadata,
  };
}

function liveViews(memberships, token = 'r1') {
  return {
    life: { status: 'complete', revision: token, memberships: [] },
    album: { status: 'complete', revision: token, memberships }, stateMessages: new Map(),
    tokens: { life: token, album: token, chat: token },
  };
}

async function withBridgePolicy(run) {
  const dir = mkdtempSync(join(tmpdir(), 'porch-bridge-revalidate-'));
  const policyPath = join(dir, 'policy.json');
  initializeImageMemoryPolicy(policyPath);
  try { await run({ dir, policyPath }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('bridge revalidation rehydrates live album metadata and validates all sources before cap six', async () => withBridgePolicy(async ({ policyPath }) => {
  const sources = Array.from({ length: 7 }, (_, index) => albumSource(index));
  const seventh = { ...sources[6], sourceText: 'live seventh', metadata: { albumName: 'renamed live' }, sourceRevision: 'r1' };
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: 'gallery/a.png', sources }] },
    beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([seventh]), hashAsset: async () => 'a'.repeat(64),
  });
  assert.equal(result.matches[0].sources.length, 1);
  assert.equal(result.matches[0].sources[0].metadata.albumName, 'renamed live');
  assert.match(result.context, /renamed live/);
  assert.doesNotMatch(result.context, /old-0/);
}));

test('bridge revalidates angle query and candidate originals and returns bounded absolute attachment paths', async () => withBridgePolicy(async ({ policyPath }) => {
  const source = albumSource(1, { albumName: 'live candidate' });
  const candidate = {
    candidateType: 'unconfirmed_angle', confidence: 'unconfirmed', relativePath: 'gallery/a.png', sha256: 'a'.repeat(64), imageId: 1,
    occurrenceId: 'candidate', sourceTs: 2, sourceText: '', sources: [source], queryIds: ['q'],
    queryEvidence: [{
      queryId: 'q', queryRelativePath: 'inbox/query.png', querySha256: 'b'.repeat(64),
      whole: { score: 0.74, rank: 1 }, fixed: { score: 0.79, rank: 2, queryRegionId: 'fq', queryRegionBbox: null, candidateRegionId: 'fc', candidateRegionBbox: null }, yoloDiagnostic: null,
    }], ranking: { weakestViewScore: 0.74, meanViewScore: 0.765 },
  };
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [], unconfirmedCandidates: [candidate] }, angleFallbackEnabled: true,
    beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([source]),
    hashAsset: async path => path === 'inbox/query.png' ? 'b'.repeat(64) : 'a'.repeat(64),
    resolveAssetPath: async path => `C:/porch/${path}`,
  });
  assert.equal(result.unconfirmedCandidates.length, 1);
  assert.deepEqual(result.recalledImagePaths, ['C:/porch/gallery/a.png']);
  assert.match(result.angleContext, /confidence=unconfirmed/);
  assert.match(result.context, /未確認的不同角度相似候補/);
}));

test('bridge removes stale raw angle evidence and reranks the remaining bounded pool', async () => withBridgePolicy(async ({ policyPath }) => {
  const firstSource = albumSource(1, { albumName: 'stale winner' });
  const secondSource = { ...albumSource(2, { albumName: 'live fallback' }), relativePath: 'gallery/b.png' };
  const raw = ({ occurrenceId, relativePath, sha256, queryRelativePath, querySha256, score, source }) => ({
    occurrenceId, relativePath, sha256, imageId: occurrenceId, sourceTs: 2, sourceText: '', sources: [source], queryIds: ['q'],
    wholeCosine: score, fixedCosine: score,
    queryEvidence: [{ queryId: 'q', queryRelativePath, querySha256, wholeCosine: score, fixedCosine: score }],
  });
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [], unconfirmedCandidatePool: [
      raw({ occurrenceId: 'first', relativePath: 'gallery/a.png', sha256: 'a'.repeat(64), queryRelativePath: 'inbox/stale.png', querySha256: 'b'.repeat(64), score: 0.9, source: firstSource }),
      raw({ occurrenceId: 'second', relativePath: 'gallery/b.png', sha256: 'c'.repeat(64), queryRelativePath: 'inbox/live.png', querySha256: 'd'.repeat(64), score: 0.8, source: secondSource }),
    ] },
    angleFallbackEnabled: true,
    beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([firstSource, secondSource]),
    hashAsset: async path => ({
      'inbox/stale.png': 'changed'.padEnd(64, '0'),
      'inbox/live.png': 'd'.repeat(64),
      'gallery/a.png': 'a'.repeat(64),
      'gallery/b.png': 'c'.repeat(64),
    })[path],
    resolveAssetPath: async path => `C:/porch/${path}`,
  });
  assert.equal(result.unconfirmedCandidates.length, 1);
  assert.equal(result.unconfirmedCandidates[0].occurrenceId, 'second');
  assert.deepEqual(result.recalledImagePaths, ['C:/porch/gallery/b.png']);
}));

test('an unavailable angle candidate cannot remove a live strict result', async () => withBridgePolicy(async ({ policyPath }) => {
  const strictSource = { ...albumSource(1), relativePath: 'gallery/strict.png' };
  const angleSource = { ...albumSource(2), relativePath: 'gallery/angle.png' };
  const result = await revalidateImageRecallForBridge({
    recallResult: {
      matches: [{ kind: 'visual', sha256: 'e'.repeat(64), relativePath: 'gallery/strict.png', sources: [strictSource] }],
      unconfirmedCandidatePool: [{
        occurrenceId: 'angle', relativePath: 'gallery/angle.png', sha256: 'a'.repeat(64), sourceTs: 2, sources: [angleSource], queryIds: ['q'],
        wholeCosine: 0.8, fixedCosine: 0.8,
        queryEvidence: [{ queryId: 'q', queryRelativePath: 'inbox/unavailable.png', querySha256: 'b'.repeat(64), wholeCosine: 0.8, fixedCosine: 0.8 }],
      }],
    },
    angleFallbackEnabled: true,
    beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([strictSource, angleSource]),
    hashAsset: async path => {
      if (path === 'inbox/unavailable.png') throw Object.assign(new Error('unavailable'), { code: 'IMAGE_UNAVAILABLE' });
      if (path === 'gallery/strict.png') return 'e'.repeat(64);
      return 'a'.repeat(64);
    },
    resolveAssetPath: async path => `C:/porch/${path}`,
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].relativePath, 'gallery/strict.png');
  assert.deepEqual(result.unconfirmedCandidates, []);
  assert.deepEqual(result.recalledImagePaths, ['C:/porch/gallery/strict.png']);
}));

test('final candidate attachment follows a same-membership live alias and revalidates that exact path', async () => withBridgePolicy(async ({ policyPath }) => {
  const oldSource = { ...albumSource(1), relativePath: 'gallery/old.png' };
  const newSource = { ...oldSource, relativePath: 'gallery/new.png', sourceRevision: 'r2' };
  let changed = false;
  const hashReads = [];
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [], unconfirmedCandidatePool: [{
      occurrenceId: 'angle', relativePath: oldSource.relativePath, sha256: 'a'.repeat(64), sourceTs: 2, sources: [oldSource], queryIds: ['q'],
      wholeCosine: 0.8, fixedCosine: 0.8,
      queryEvidence: [{ queryId: 'q', queryRelativePath: 'inbox/q.png', querySha256: 'b'.repeat(64), wholeCosine: 0.8, fixedCosine: 0.8 }],
    }] },
    angleFallbackEnabled: true, maxHits: 3,
    beforeTs: 100, deadlineAt: Date.now() + 1000, policyPath,
    loadLiveViews: async () => liveViews([changed ? newSource : oldSource], changed ? 'r2' : 'r1'),
    hashAsset: async path => {
      hashReads.push(path);
      if (path === 'inbox/q.png') return 'b'.repeat(64);
      if (path === 'gallery/old.png' && changed) return 'c'.repeat(64);
      return 'a'.repeat(64);
    },
    resolveAssetPath: async path => {
      if (path === 'gallery/old.png') changed = true;
      return `C:/porch/${path}`;
    },
  });
  assert.equal(result.unconfirmedCandidates.length, 1);
  assert.equal(result.unconfirmedCandidates[0].relativePath, 'gallery/new.png');
  assert.deepEqual(result.recalledImagePaths, ['C:/porch/gallery/new.png']);
  assert.ok(hashReads.includes('gallery/new.png'));
  assert.equal(result.angleContext.includes('candidatePath=gallery/new.png'), true);
}));

test('strict source failures are local and a same-SHA live alias survives with angle fallback off', async () => withBridgePolicy(async ({ policyPath }) => {
  const missing = { ...albumSource(1), relativePath: 'gallery/missing.png' };
  const alias = { ...albumSource(2), relativePath: 'gallery/live.png' };
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: missing.relativePath, sources: [missing, alias] }] },
    angleFallbackEnabled: false, beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([missing, alias]),
    hashAsset: async path => {
      if (path === missing.relativePath) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return 'a'.repeat(64);
    },
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].relativePath, alias.relativePath);
  assert.deepEqual(result.matches[0].sources.map(source => source.relativePath), [alias.relativePath]);
}));

test('strict query failures are local and surviving evidence is reranked', async () => withBridgePolicy(async ({ policyPath }) => {
  const source = { ...albumSource(1), relativePath: 'gallery/live.png' };
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{
      kind: 'visual', cosine: 0.99, sha256: 'a'.repeat(64), relativePath: source.relativePath, sources: [source],
      queryEvidence: [
        { queryId: 'gone', queryRelativePath: 'inbox/gone.png', querySha256: 'c'.repeat(64), kind: 'visual', cosine: 0.99 },
        { queryId: 'live', queryRelativePath: 'inbox/live.png', querySha256: 'b'.repeat(64), kind: 'visual', cosine: 0.9 },
      ],
    }] },
    angleFallbackEnabled: false, beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([source]),
    hashAsset: async path => {
      if (path === 'inbox/gone.png') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (path === 'inbox/live.png') return 'b'.repeat(64);
      return 'a'.repeat(64);
    },
  });
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].queryIds, ['live']);
  assert.equal(result.matches[0].cosine, 0.9);
}));

test('one missing strict image does not erase another valid strict match', async () => withBridgePolicy(async ({ policyPath }) => {
  const missing = { ...albumSource(1), relativePath: 'gallery/missing.png' };
  const live = { ...albumSource(2), relativePath: 'gallery/live.png' };
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [
      { kind: 'exact', sha256: 'a'.repeat(64), relativePath: missing.relativePath, sources: [missing] },
      { kind: 'exact', sha256: 'b'.repeat(64), relativePath: live.relativePath, sources: [live] },
    ] },
    angleFallbackEnabled: false, beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([missing, live]),
    hashAsset: async path => {
      if (path === missing.relativePath) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return 'b'.repeat(64);
    },
  });
  assert.deepEqual(result.matches.map(match => match.relativePath), [live.relativePath]);
}));

test('path-only policy denial removes a strict alias before choosing representative text with fallback off', async () => withBridgePolicy(async ({ policyPath }) => {
  const denied = { ...albumSource(1), relativePath: 'gallery/denied.png', sourceText: 'SYNTH_DENIED' };
  const allowed = { ...albumSource(2), relativePath: 'gallery/allowed.png', sourceText: 'SYNTH_ALLOWED' };
  await revokeImageMemoryAsync({ policyPath, relativePaths: [denied.relativePath], knownShas: [], revokedAt: Date.now() });
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: denied.relativePath, sources: [denied, allowed] }] },
    angleFallbackEnabled: false, beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([denied, allowed]), hashAsset: async () => 'a'.repeat(64),
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].relativePath, allowed.relativePath);
  assert.deepEqual(result.matches[0].sources.map(source => source.relativePath), [allowed.relativePath]);
  assert.doesNotMatch(result.context, /SYNTH_DENIED/);
  assert.match(result.context, /SYNTH_ALLOWED/);
}));

test('path-only policy denial removes an angle alias before binding native attachment with fallback on', async () => withBridgePolicy(async ({ policyPath }) => {
  const denied = { ...albumSource(1), relativePath: 'gallery/denied.png', sourceText: 'SYNTH_DENIED' };
  const allowed = { ...albumSource(2), relativePath: 'gallery/allowed.png', sourceText: 'SYNTH_ALLOWED' };
  await revokeImageMemoryAsync({ policyPath, relativePaths: [denied.relativePath], knownShas: [], revokedAt: Date.now() });
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [], unconfirmedCandidatePool: [{
      occurrenceId: 'angle', relativePath: denied.relativePath, sha256: 'a'.repeat(64), sourceTs: 2, sources: [denied, allowed], queryIds: ['q'],
      wholeCosine: 0.8, fixedCosine: 0.8,
      queryEvidence: [{ queryId: 'q', queryRelativePath: 'inbox/q.png', querySha256: 'b'.repeat(64), wholeCosine: 0.8, fixedCosine: 0.8 }],
    }] },
    angleFallbackEnabled: true, beforeTs: 100, deadlineAt: Date.now() + 1000, policyPath,
    loadLiveViews: async () => liveViews([denied, allowed]),
    hashAsset: async path => path === 'inbox/q.png' ? 'b'.repeat(64) : 'a'.repeat(64),
    resolveAssetPath: async path => `C:/porch/${path}`,
  });
  assert.equal(result.unconfirmedCandidates.length, 1);
  assert.equal(result.unconfirmedCandidates[0].relativePath, allowed.relativePath);
  assert.deepEqual(result.unconfirmedCandidates[0].sources.map(source => source.relativePath), [allowed.relativePath]);
  assert.deepEqual(result.recalledImagePaths, ['C:/porch/gallery/allowed.png']);
  assert.doesNotMatch(result.context, /SYNTH_DENIED/);
}));

test('path denial created during a source hash await cannot leave that alias or its text', async () => withBridgePolicy(async ({ policyPath }) => {
  const revokedDuringHash = { ...albumSource(1), relativePath: 'gallery/revoked.png', sourceText: 'SYNTH_REVOKED' };
  const allowed = { ...albumSource(2), relativePath: 'gallery/allowed.png', sourceText: 'SYNTH_ALLOWED' };
  let revoked = false;
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: revokedDuringHash.relativePath, sources: [revokedDuringHash, allowed] }] },
    angleFallbackEnabled: true, beforeTs: 100, deadlineAt: Date.now() + 1000, policyPath,
    loadLiveViews: async () => liveViews([revokedDuringHash, allowed]),
    hashAsset: async path => {
      if (path === revokedDuringHash.relativePath && !revoked) {
        revoked = true;
        await revokeImageMemoryAsync({ policyPath, relativePaths: [revokedDuringHash.relativePath], knownShas: [], revokedAt: Date.now() });
      }
      return 'a'.repeat(64);
    },
    resolveAssetPath: async path => `C:/porch/${path}`,
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].relativePath, allowed.relativePath);
  assert.deepEqual(result.recalledImagePaths, ['C:/porch/gallery/allowed.png']);
  assert.doesNotMatch(result.context, /SYNTH_REVOKED/);
}));

test('SHA policy denial removes every alias while path-only denial still permits an independent alias', async () => {
  await withBridgePolicy(async ({ policyPath }) => {
    const denied = { ...albumSource(1), relativePath: 'gallery/denied.png' };
    const allowed = { ...albumSource(2), relativePath: 'gallery/allowed.png' };
    await revokeImageMemoryAsync({ policyPath, relativePaths: [denied.relativePath], knownShas: [], revokedAt: Date.now() });
    const pathOnly = await revalidateImageRecallForBridge({
      recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: denied.relativePath, sources: [denied, allowed] }] },
      angleFallbackEnabled: false, beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
      loadLiveViews: async () => liveViews([denied, allowed]), hashAsset: async () => 'a'.repeat(64),
    });
    assert.equal(pathOnly.matches[0]?.relativePath, allowed.relativePath);
  });
  await withBridgePolicy(async ({ policyPath }) => {
    const first = { ...albumSource(1), relativePath: 'gallery/first.png' };
    const second = { ...albumSource(2), relativePath: 'gallery/second.png' };
    await revokeImageMemoryAsync({ policyPath, relativePaths: [], knownShas: ['a'.repeat(64)], revokedAt: Date.now() });
    const shaDenied = await revalidateImageRecallForBridge({
      recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: first.relativePath, sources: [first, second] }] },
      angleFallbackEnabled: false, beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
      loadLiveViews: async () => liveViews([first, second]), hashAsset: async () => 'a'.repeat(64),
    });
    assert.deepEqual(shaDenied.matches, []);
  });
});

test('a paused policy fails bridge revalidation closed even when recall rows are empty', async () => withBridgePolicy(async ({ policyPath }) => {
  mkdirSync(`${policyPath}.pending`, { recursive: true });
  writeFileSync(join(`${policyPath}.pending`, 'pending.json'), JSON.stringify({ version: 1, paths: [], shas: [], revokedAt: Date.now() }));
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [], unconfirmedCandidatePool: [] }, angleFallbackEnabled: true,
    beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([]), hashAsset: async () => 'a'.repeat(64),
  });
  assert.deepEqual(result.matches, []);
  assert.equal(result.warning, 'IMAGE_MEMORY_POLICY_PENDING');
}));

test('attachment resolution is followed by a fresh policy and live-source safety pass', async () => {
  for (const mode of ['query-revoked', 'source-deleted']) {
    await withBridgePolicy(async ({ policyPath }) => {
      let deleted = false;
      const source = albumSource(1);
      const candidate = {
        occurrenceId: 'angle', relativePath: source.relativePath, sha256: 'a'.repeat(64), sourceTs: 2, sources: [source], queryIds: ['q'],
        wholeCosine: 0.8, fixedCosine: 0.8,
        queryEvidence: [{ queryId: 'q', queryRelativePath: 'inbox/q.png', querySha256: 'b'.repeat(64), wholeCosine: 0.8, fixedCosine: 0.8 }],
      };
      const result = await revalidateImageRecallForBridge({
        recallResult: { matches: [], unconfirmedCandidatePool: [candidate] }, angleFallbackEnabled: true, maxHits: 3,
        beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
        loadLiveViews: async () => liveViews(deleted ? [] : [source], deleted ? 'r2' : 'r1'),
        hashAsset: async path => path === 'inbox/q.png' ? 'b'.repeat(64) : 'a'.repeat(64),
        resolveAssetPath: async path => {
          if (mode === 'query-revoked') await revokeImageMemoryAsync({ policyPath, relativePaths: ['inbox/q.png'], knownShas: ['b'.repeat(64)], revokedAt: Date.now() });
          else deleted = true;
          return `C:/porch/${path}`;
        },
      });
      assert.deepEqual(result.unconfirmedCandidates, [], mode);
      assert.deepEqual(result.recalledImagePaths, [], mode);
      assert.equal(result.angleContext, '', mode);
    });
  }
});

test('an unresolved or late candidate attachment removes its text and returns a warning', async () => {
  for (const mode of ['unavailable', 'deadline']) {
    await withBridgePolicy(async ({ policyPath }) => {
      const source = albumSource(1);
      const result = await revalidateImageRecallForBridge({
        recallResult: { matches: [], unconfirmedCandidatePool: [{
          occurrenceId: 'angle', relativePath: source.relativePath, sha256: 'a'.repeat(64), sourceTs: 2, sources: [source], queryIds: ['q'],
          wholeCosine: 0.8, fixedCosine: 0.8,
          queryEvidence: [{ queryId: 'q', queryRelativePath: 'inbox/q.png', querySha256: 'b'.repeat(64), wholeCosine: 0.8, fixedCosine: 0.8 }],
        }] },
        angleFallbackEnabled: true, maxHits: 3,
        beforeTs: 100, deadlineAt: Date.now() + 180, policyPath,
        loadLiveViews: async () => liveViews([source]),
        hashAsset: async path => path === 'inbox/q.png' ? 'b'.repeat(64) : 'a'.repeat(64),
        resolveAssetPath: async path => {
          if (mode === 'unavailable') throw Object.assign(new Error('unavailable'), { code: 'IMAGE_UNAVAILABLE' });
          await new Promise(resolve => setTimeout(resolve, 220));
          return `C:/porch/${path}`;
        },
      });
      assert.deepEqual(result.unconfirmedCandidates, [], mode);
      assert.deepEqual(result.recalledImagePaths, [], mode);
      assert.equal(result.angleContext, '', mode);
      assert.ok(result.warning, mode);
    });
  }
});

test('bridge maxHits bounds reranking, context, and historical attachments together', async () => withBridgePolicy(async ({ policyPath }) => {
  const sources = [1, 2, 3].map(index => ({ ...albumSource(index), relativePath: `gallery/${index}.png` }));
  const pool = sources.map((source, index) => ({
    occurrenceId: `angle-${index}`, relativePath: source.relativePath, sha256: String(index + 1).repeat(64), sourceTs: 2, sources: [source], queryIds: [`q${index}`],
    wholeCosine: 0.8, fixedCosine: 0.8,
    queryEvidence: [{ queryId: `q${index}`, queryRelativePath: `inbox/q${index}.png`, querySha256: 'b'.repeat(64), wholeCosine: 0.8, fixedCosine: 0.8 }],
  }));
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [], unconfirmedCandidatePool: pool }, angleFallbackEnabled: true, maxHits: 1,
    beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews(sources),
    hashAsset: async path => path.startsWith('inbox/') ? 'b'.repeat(64) : String(Number(path.match(/(\d)\.png/)[1])).repeat(64),
    resolveAssetPath: async path => `C:/porch/${path}`,
  });
  assert.equal(result.unconfirmedCandidates.length, 1);
  assert.equal(result.recalledImagePaths.length, 1);
  assert.equal((result.angleContext.match(/candidateType=unconfirmed_angle/g) || []).length, 1);
}));

test('slow candidate work stops before the reserved final strict safety pass', async () => withBridgePolicy(async ({ policyPath }) => {
  const strictSource = { ...albumSource(4), relativePath: 'gallery/4.png' };
  const angleSource = { ...albumSource(1), relativePath: 'gallery/1.png' };
  const started = Date.now();
  const result = await revalidateImageRecallForBridge({
    recallResult: {
      matches: [{ kind: 'exact', sha256: '4'.repeat(64), relativePath: strictSource.relativePath, sources: [strictSource] }],
      unconfirmedCandidatePool: [{
        occurrenceId: 'angle', relativePath: angleSource.relativePath, sha256: '1'.repeat(64), sourceTs: 2, sources: [angleSource], queryIds: ['q'],
        wholeCosine: 0.8, fixedCosine: 0.8,
        queryEvidence: [{ queryId: 'q', queryRelativePath: 'inbox/q.png', querySha256: 'b'.repeat(64), wholeCosine: 0.8, fixedCosine: 0.8 }],
      }],
    },
    angleFallbackEnabled: true, maxHits: 3,
    beforeTs: 100, deadlineAt: started + 1200, policyPath,
    loadLiveViews: async () => liveViews([strictSource, angleSource]),
    hashAsset: async path => {
      if (path === 'inbox/q.png') await new Promise(resolve => setTimeout(resolve, 2000));
      return path === 'inbox/q.png' ? 'b'.repeat(64) : path.includes('/4.png') ? '4'.repeat(64) : '1'.repeat(64);
    },
    resolveAssetPath: async path => `C:/porch/${path}`,
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].kind, 'exact');
  assert.deepEqual(result.unconfirmedCandidates, []);
}));

test('bridge drops revoked angle evidence and does not revive it as an attachment', async () => withBridgePolicy(async ({ policyPath }) => {
  const source = albumSource(1);
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [], unconfirmedCandidates: [{
      candidateType: 'unconfirmed_angle', confidence: 'unconfirmed', relativePath: 'gallery/a.png', sha256: 'a'.repeat(64), occurrenceId: 'candidate', sourceTs: 2, sources: [source], queryIds: ['q'],
      queryEvidence: [{ queryId: 'q', queryRelativePath: 'inbox/query.png', querySha256: 'b'.repeat(64), whole: { score: 0.7, rank: 1 }, fixed: { score: 0.7, rank: 1 }, yoloDiagnostic: null }],
      ranking: { weakestViewScore: 0.7, meanViewScore: 0.7 },
    }] }, angleFallbackEnabled: true,
    beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([source]),
    hashAsset: async path => path === 'inbox/query.png' ? 'changed'.padEnd(64, '0') : 'a'.repeat(64),
    resolveAssetPath: async path => `C:/porch/${path}`,
  });
  assert.deepEqual(result.unconfirmedCandidates, []);
  assert.deepEqual(result.recalledImagePaths, []);
  assert.equal(result.angleContext, '');
}));

test('bridge revalidation drops a replaced best query and reselects its next live evidence', async () => withBridgePolicy(async ({ policyPath }) => {
  const source = albumSource(1, { albumName: 'live' });
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{
      kind: 'visual', cosine: 0.99, sha256: 'a'.repeat(64), relativePath: 'gallery/a.png', sources: [source],
      queryEvidence: [
        { queryId: 'best', queryRelativePath: 'inbox/best.png', querySha256: 'b'.repeat(64), kind: 'visual', cosine: 0.99 },
        { queryId: 'next', queryRelativePath: 'inbox/next.png', querySha256: 'c'.repeat(64), kind: 'visual', cosine: 0.9 },
      ],
    }] },
    beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => liveViews([source]),
    hashAsset: async path => path === 'inbox/best.png' ? 'd'.repeat(64) : path === 'inbox/next.png' ? 'c'.repeat(64) : 'a'.repeat(64),
  });
  assert.deepEqual(result.matches[0].queryIds, ['next']);
  assert.equal(result.matches[0].cosine, 0.9);
}));

test('bridge revalidation repeats bounded hydration when the source generation changes after validation', async () => withBridgePolicy(async ({ policyPath }) => {
  const old = albumSource(1, { albumName: 'old' });
  const fresh = { ...old, sourceText: 'fresh', metadata: { albumName: 'fresh' }, sourceRevision: 'r2' };
  let calls = 0;
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: 'gallery/a.png', sources: [old] }] },
    beforeTs: 100, deadlineAt: Date.now() + 500, policyPath,
    loadLiveViews: async () => ++calls === 1 ? liveViews([old], 'r1') : liveViews([fresh], 'r2'),
    hashAsset: async () => 'a'.repeat(64),
  });
  assert.ok(calls >= 2);
  assert.equal(result.matches[0].sources[0].metadata.albumName, 'fresh');
}));

test('one absolute bridge deadline fails closed when live hydration is slow', async () => withBridgePolicy(async ({ policyPath }) => {
  const started = Date.now();
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: 'gallery/a.png', sources: [albumSource(1)] }] },
    beforeTs: 100, deadlineAt: started + 25, policyPath,
    loadLiveViews: () => new Promise(resolve => setTimeout(() => resolve(liveViews([])), 100)),
    hashAsset: async () => 'a'.repeat(64),
  });
  assert.deepEqual(result.matches, []);
  assert.equal(result.warning, 'IMAGE_RECALL_DEADLINE');
  assert.ok(Date.now() - started < 90);
}));

test('bridge revalidation notices a state-only source becoming private during hashing', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const lifePath = join(dir, 'life.json');
  const albumsPath = join(dir, 'albums.json');
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const entry = {
    role: 'user', messageId: 'm-state', conversationId: 'c1', text: 'safe', images: ['inbox/a.png'],
    ts: '2026-09-20T01:00:00Z',
  };
  writeFileSync(lifePath, '[]');
  writeFileSync(albumsPath, '{"albums":[]}');
  writeFileSync(historyPath, '');
  writeFileSync(statePath, JSON.stringify({ log: [entry] }));
  const source = {
    membershipId: 'chat:m-state:image:0', sourceType: 'chat', sourceId: 'm-state', relativePath: 'inbox/a.png',
    sourceTs: Date.parse(entry.ts), sourceText: 'safe', conversationId: 'c1',
    locator: { kind: 'state', confidence: 'exact', messageId: 'm-state' }, metadata: {},
  };
  let changed = false;
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: 'inbox/a.png', sources: [source], context: [] }] },
    beforeTs: Date.parse('2026-09-21T00:00:00Z'), deadlineAt: Date.now() + 1000, policyPath,
    lifePath, albumsPath, historyPath, statePath,
    hashAsset: async () => {
      if (!changed) {
        changed = true;
        writeFileSync(statePath, JSON.stringify({ log: [{ ...entry, text: '不要存 synthetic secret', memorySafe: false }] }));
      }
      return 'a'.repeat(64);
    },
  });
  assert.deepEqual(result.matches, []);
  assert.equal(result.context.includes('synthetic secret'), false);
}));

test('bridge revalidation notices a state-only source being deleted during hashing', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const lifePath = join(dir, 'life.json');
  const albumsPath = join(dir, 'albums.json');
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const entry = {
    role: 'user', messageId: 'm-delete', conversationId: 'c1', text: 'safe', images: ['inbox/a.png'],
    ts: '2026-09-20T01:00:00Z',
  };
  writeFileSync(lifePath, '[]');
  writeFileSync(albumsPath, '{"albums":[]}');
  writeFileSync(historyPath, '');
  writeFileSync(statePath, JSON.stringify({ log: [entry] }));
  const source = {
    membershipId: 'chat:m-delete:image:0', sourceType: 'chat', sourceId: 'm-delete', relativePath: 'inbox/a.png',
    sourceTs: Date.parse(entry.ts), sourceText: 'safe', conversationId: 'c1',
    locator: { kind: 'state', confidence: 'exact', messageId: 'm-delete' }, metadata: {},
  };
  let changed = false;
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: 'inbox/a.png', sources: [source], context: [] }] },
    beforeTs: Date.parse('2026-09-21T00:00:00Z'), deadlineAt: Date.now() + 1000, policyPath,
    lifePath, albumsPath, historyPath, statePath,
    hashAsset: async () => {
      if (!changed) { changed = true; writeFileSync(statePath, JSON.stringify({ log: [] })); }
      return 'a'.repeat(64);
    },
  });
  assert.deepEqual(result.matches, []);
}));

test('a private live-state row overrides a stale public history row with the same exact id', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const lifePath = join(dir, 'life.json');
  const albumsPath = join(dir, 'albums.json');
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const entry = {
    role: 'user', messageId: 'm-history', conversationId: 'c1', text: 'safe', images: ['inbox/a.png'],
    ts: '2026-09-20T01:00:00Z',
  };
  writeFileSync(lifePath, '[]');
  writeFileSync(albumsPath, '{"albums":[]}');
  writeFileSync(historyPath, `${JSON.stringify(entry)}\n`);
  writeFileSync(statePath, JSON.stringify({ log: [] }));
  const stale = readChatImageSourceSnapshot({ historyPath, statePath }).memberships[0];
  writeFileSync(statePath, JSON.stringify({ log: [{ ...entry, text: '不要存 synthetic secret', memorySafe: false }] }));

  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: 'inbox/a.png', sources: [stale], context: [] }] },
    beforeTs: Date.parse('2026-09-21T00:00:00Z'), deadlineAt: Date.now() + 1000, policyPath,
    lifePath, albumsPath, historyPath, statePath, hashAsset: async () => 'a'.repeat(64),
  });
  assert.deepEqual(result.matches, []);
  assert.equal(result.context.includes('synthetic secret'), false);
}));

async function stateContextFixture(dir, policyPath, mutate) {
  const lifePath = join(dir, 'life.json');
  const albumsPath = join(dir, 'albums.json');
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const base = Date.parse('2026-09-20T01:00:00Z');
  const rows = [
    { role: 'resident', messageId: 'prior', conversationId: 'c1', text: 'prior text', ts: new Date(base).toISOString() },
    { role: 'user', messageId: 'photo', conversationId: 'c1', text: 'SYNTH_PHOTO', images: ['inbox/a.png'], ts: new Date(base + 60000).toISOString() },
    { role: 'resident', messageId: 'next', conversationId: 'c1', text: 'next text', ts: new Date(base + 120000).toISOString() },
  ];
  writeFileSync(lifePath, '[]');
  writeFileSync(albumsPath, JSON.stringify({ albums: [{ id: 'a', name: 'album', items: [{ id: 'i', src: 'inbox/a.png', at: new Date(base).toISOString() }] }] }));
  writeFileSync(historyPath, '');
  writeFileSync(statePath, JSON.stringify({ log: rows }));
  const chat = readChatImageSourceSnapshot({ historyPath, statePath });
  const context = selectChatContextWindow(chat.messages, { photoMessageId: 'photo', beforeTs: base + 4 * 3600000 });
  const chatSource = chat.memberships.find(row => row.sourceId === 'photo');
  const album = readAlbumImageSourceSnapshot(albumsPath).memberships[0];
  mutate(rows, statePath, base);
  return revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: 'inbox/a.png', sources: [album, chatSource], context }] },
    beforeTs: base + 4 * 3600000, deadlineAt: Date.now() + 1000, policyPath,
    lifePath, albumsPath, historyPath, statePath, hashAsset: async () => 'a'.repeat(64),
  });
}

test('bridge drops all stale chat context when the live photo anchor is deleted', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const result = await stateContextFixture(dir, policyPath, (rows, statePath) => {
    writeFileSync(statePath, JSON.stringify({ log: rows.filter(row => row.messageId !== 'photo') }));
  });
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].sources.map(row => row.sourceType), ['album']);
  assert.deepEqual(result.matches[0].context, []);
  assert.doesNotMatch(result.context, /prior text/);
  assert.doesNotMatch(result.context, /SYNTH_PHOTO/);
}));

test('bridge keeps an independent album source but drops context when the chat photo points at another image', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const result = await stateContextFixture(dir, policyPath, (rows, statePath) => {
    rows[1] = { ...rows[1], images: ['inbox/other.png'] };
    writeFileSync(statePath, JSON.stringify({ log: rows }));
  });
  assert.equal(result.matches.length, 1);
  assert.deepEqual(result.matches[0].sources.map(row => row.sourceType), ['album']);
  assert.deepEqual(result.matches[0].context, []);
  assert.doesNotMatch(result.context, /SYNTH_PHOTO/);
}));

test('bridge rebuilds the live contiguous window and stops at a newly inserted private row', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const result = await stateContextFixture(dir, policyPath, (rows, statePath, base) => {
    rows.splice(2, 0, { role: 'resident', messageId: 'hidden', conversationId: 'c1', text: '不要存 synthetic secret', memorySafe: false, ts: new Date(base + 90000).toISOString() });
    writeFileSync(statePath, JSON.stringify({ log: rows }));
  });
  assert.deepEqual(result.matches[0].context.map(row => row.messageId), ['prior', 'photo']);
  assert.equal(result.context.includes('next text'), false);
  assert.equal(result.context.includes('synthetic secret'), false);
}));

test('bridge rebuilds live context and rejects a next row moved to another conversation and time window', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const result = await stateContextFixture(dir, policyPath, (rows, statePath, base) => {
    rows[2] = { ...rows[2], conversationId: 'c2', ts: new Date(base + 2 * 3600000).toISOString(), text: 'changed next' };
    writeFileSync(statePath, JSON.stringify({ log: rows }));
  });
  assert.deepEqual(result.matches[0].context.map(row => row.messageId), ['prior', 'photo']);
  assert.equal(result.context.includes('changed next'), false);
}));

test('bridge rebuilds context from a later surviving chat anchor when the first anchor loses its image', async () => withBridgePolicy(async ({ dir, policyPath }) => {
  const lifePath = join(dir, 'life.json');
  const albumsPath = join(dir, 'albums.json');
  const historyPath = join(dir, 'history.jsonl');
  const statePath = join(dir, 'state.json');
  const base = Date.parse('2026-09-20T01:00:00Z');
  const rows = [
    { role: 'resident', messageId: 'prior-1', conversationId: 'c1', text: 'FIRST_PRIOR', ts: new Date(base).toISOString() },
    { role: 'user', messageId: 'photo-1', conversationId: 'c1', text: 'FIRST_PHOTO', images: ['inbox/a.png'], ts: new Date(base + 60000).toISOString() },
    { role: 'resident', messageId: 'prior-2', conversationId: 'c2', text: 'SECOND_PRIOR', ts: new Date(base + 120000).toISOString() },
    { role: 'user', messageId: 'photo-2', conversationId: 'c2', text: 'SECOND_PHOTO', images: ['inbox/a.png'], ts: new Date(base + 180000).toISOString() },
    { role: 'resident', messageId: 'next-2', conversationId: 'c2', text: 'SECOND_NEXT', ts: new Date(base + 240000).toISOString() },
  ];
  writeFileSync(lifePath, '[]');
  writeFileSync(albumsPath, '{"albums":[]}');
  writeFileSync(historyPath, '');
  writeFileSync(statePath, JSON.stringify({ log: rows }));
  const chat = readChatImageSourceSnapshot({ historyPath, statePath });
  const sources = chat.memberships.filter(row => ['photo-1', 'photo-2'].includes(row.sourceId));
  const context = sources.flatMap(source => selectChatContextWindow(chat.messages, { photoMessageId: source.sourceId, beforeTs: base + 3600000 }));
  rows[1] = { ...rows[1], images: [] };
  writeFileSync(statePath, JSON.stringify({ log: rows }));
  const result = await revalidateImageRecallForBridge({
    recallResult: { matches: [{ kind: 'exact', sha256: 'a'.repeat(64), relativePath: 'inbox/a.png', sources, context }] },
    beforeTs: base + 3600000, deadlineAt: Date.now() + 1000, policyPath,
    lifePath, albumsPath, historyPath, statePath, hashAsset: async () => 'a'.repeat(64),
  });
  assert.deepEqual(result.matches[0].sources.map(row => row.sourceId), ['photo-2']);
  assert.deepEqual(result.matches[0].context.map(row => row.messageId), ['prior-2', 'photo-2', 'next-2']);
  assert.doesNotMatch(result.context, /FIRST_PHOTO|FIRST_PRIOR/);
  assert.match(result.context, /SECOND_PHOTO/);
}));
