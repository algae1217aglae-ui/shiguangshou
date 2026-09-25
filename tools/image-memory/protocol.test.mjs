import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PROTOCOL_LINE_BYTES,
  createRequestParser,
  validateRequest,
} from './protocol.mjs';

const recall = {
  id: 'r1', op: 'recall',
  queries: [{ queryId: 'q1', occurrenceId: 'o1', relativePath: 'inbox/a.jpg' }],
  beforeTs: 1000, excludeOccurrenceIds: [], deadlineMs: 2500,
  limits: { maxHits: 3, pHashMaxDistance: 8, visualMinScore: 0.88 },
};

test('protocol parser accepts a split line followed by several complete lines', () => {
  const requests = [];
  const errors = [];
  const parser = createRequestParser({ onRequest: request => requests.push(request), onError: error => errors.push(error) });
  const first = `${JSON.stringify(recall)}\n`;
  parser.push(Buffer.from(first.slice(0, 17)));
  assert.equal(requests.length, 0);
  parser.push(Buffer.from(first.slice(17) + `${JSON.stringify({ id: 's1', op: 'stats' })}\n${JSON.stringify({ id: 'x1', op: 'shutdown' })}\n`));
  assert.deepEqual(requests.map(row => row.id), ['r1', 's1', 'x1']);
  assert.deepEqual(errors, []);
});

test('bad JSON, missing ids, and unknown operations return isolated structured errors', () => {
  const requests = [];
  const errors = [];
  const parser = createRequestParser({ onRequest: request => requests.push(request), onError: error => errors.push(error) });
  parser.push(Buffer.from('{bad}\n{"op":"stats"}\n{"id":"wat","op":"unknown"}\n{"id":"ok","op":"stats"}\n'));
  assert.deepEqual(requests.map(row => row.id), ['ok']);
  assert.deepEqual(errors.map(row => row.id), [null, null, 'wat']);
  assert.ok(errors.every(row => row.ok === false && row.error.code));
});

test('protocol enforces one MiB on complete lines and unterminated buffers', () => {
  const errors = [];
  const parser = createRequestParser({ onRequest() {}, onError: error => errors.push(error) });
  parser.push(Buffer.alloc(MAX_PROTOCOL_LINE_BYTES + 1, 65));
  assert.equal(errors.at(-1).error.code, 'PROTOCOL_LINE_TOO_LARGE');
  parser.push(Buffer.from(`${JSON.stringify({ id: 'ok', op: 'stats' })}\n`));
  assert.equal(errors.length, 1);
});

test('request validation bounds arrays, text, deadlines, thresholds, and evaluate topK', () => {
  const validated = validateRequest({
    id: 'i1', op: 'index', deadlineMs: 1000,
    sources: [{ occurrenceId: 'o1', queryId: 'q1', relativePath: 'inbox/a.jpg', sourceTs: 1, sourceText: '字'.repeat(200) }],
  });
  assert.equal([...validated.sources[0].sourceText].length, 160);
  assert.throws(() => validateRequest({ ...recall, id: 'bad', queries: Array.from({ length: 33 }, (_, i) => ({ queryId: `q${i}`, occurrenceId: `o${i}`, relativePath: 'inbox/a.jpg' })) }), /32/);
  assert.throws(() => validateRequest({ ...recall, id: 'bad', deadlineMs: Infinity }), /deadlineMs/);
  assert.throws(() => validateRequest({ ...recall, id: 'bad', limits: { ...recall.limits, maxHits: 4 } }), /maxHits/);
  assert.throws(() => validateRequest({ ...recall, id: 'bad', limits: { ...recall.limits, pHashMaxDistance: 64 } }), /pHashMaxDistance/);
  assert.throws(() => validateRequest({ ...recall, id: 'bad', limits: { ...recall.limits, visualMinScore: 2 } }), /visualMinScore/);
  assert.throws(() => validateRequest({ ...recall, id: 'bad', op: 'evaluate', topK: 101 }), /topK/);
  assert.equal(validateRequest({ ...recall, id: 'route', op: 'evaluate', topK: 10, regionMode: 'yolo' }).regionMode, 'yolo');
  assert.throws(() => validateRequest({ ...recall, id: 'bad-route', op: 'evaluate', topK: 10, regionMode: 'all-unbounded' }), /regionMode/);
  assert.equal(validateRequest({ ...recall, deadlineAt: 5000 }).deadlineAt, 5000);
  assert.deepEqual(validateRequest({ id: 'deny', op: 'revoke', relativePaths: ['/inbox/a.jpg', 'inbox/b.jpg'] }).relativePaths, ['inbox/a.jpg', 'inbox/b.jpg']);
});

test('angle fallback protocol flag defaults off and only accepts booleans', () => {
  assert.equal(validateRequest(recall).limits.angleFallbackEnabled, false);
  assert.equal(validateRequest({ ...recall, limits: { ...recall.limits, angleFallbackEnabled: true } }).limits.angleFallbackEnabled, true);
  assert.equal(validateRequest({ ...recall, limits: { ...recall.limits, angleFallbackEnabled: false } }).limits.angleFallbackEnabled, false);
  assert.throws(() => validateRequest({ ...recall, limits: { ...recall.limits, angleFallbackEnabled: 'true' } }), /angleFallbackEnabled/);
  assert.throws(() => validateRequest({ ...recall, limits: { ...recall.limits, angleFallbackEnabled: 1 } }), /angleFallbackEnabled/);
});

test('evaluate candidate validation allowlist is explicit, bounded to 32, and unavailable to recall', () => {
  const base = { id: 'e', op: 'evaluate', queries: [{ queryId: 'q', occurrenceId: 'o', relativePath: 'inbox/q.png' }], beforeTs: 2, excludeOccurrenceIds: [], deadlineMs: 100, limits: {}, topK: 100 };
  assert.deepEqual(validateRequest({ ...base, candidateValidationPaths: [] }).candidateValidationPaths, []);
  assert.deepEqual(validateRequest({ ...base, candidateValidationPaths: ['inbox/a.png'] }).candidateValidationPaths, ['inbox/a.png']);
  assert.throws(() => validateRequest({ ...base, candidateValidationPaths: Array.from({ length: 33 }, (_, index) => `inbox/${index}.png`) }), /32/);
  const recall = { ...base, op: 'recall' };
  delete recall.topK;
  assert.throws(() => validateRequest({ ...recall, candidateValidationPaths: ['inbox/a.png'] }), /evaluate/);
});

test('protocol accepts all finite roots and validates source snapshot CAS messages', () => {
  for (const relativePath of ['inbox/a.jpg', 'life-photos/a.jpg', 'gallery/a.jpg']) {
    assert.equal(validateRequest({ ...recall, id: relativePath, queries: [{ queryId: 'q', occurrenceId: 'o', relativePath }] }).queries[0].relativePath, relativePath);
  }
  assert.throws(() => validateRequest({ ...recall, queries: [{ queryId: 'q', occurrenceId: 'o', relativePath: 'other/a.jpg' }] }), /relativePath/);
  const begin = validateRequest({ id: 'b', op: 'source_sync_begin', snapshotId: 'snap-1', sourceType: 'album', revision: 'r2', baseGeneration: 1, baseRevision: 'r1', mode: 'complete' });
  assert.equal(begin.baseGeneration, 1);
  const batch = validateRequest({
    id: 'x', op: 'source_sync_batch', snapshotId: 'snap-1',
    memberships: [{ membershipId: 'album:a:i', sourceType: 'album', sourceId: 'a', relativePath: 'gallery/a.jpg', sourceTs: 1, sourceText: 'x', sourceRevision: 'r2' }],
    messages: [],
  });
  assert.equal(batch.memberships[0].membershipId, 'album:a:i');
  assert.equal(validateRequest({ id: 'c', op: 'source_sync_commit', snapshotId: 'snap-1' }).snapshotId, 'snap-1');
  assert.equal(validateRequest({ id: 'a', op: 'source_sync_abort', snapshotId: 'snap-1' }).snapshotId, 'snap-1');
  assert.deepEqual(validateRequest({ id: 'd', op: 'source_remove', membershipIds: ['album:a:i'] }).membershipIds, ['album:a:i']);
});
