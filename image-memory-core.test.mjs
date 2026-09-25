import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  admitVisualEvidence,
  cosineSimilarityFloat32,
  formatImageRecallContext,
  hammingDistanceHex,
  rankImageCandidatesForThresholds,
  rankImageCandidatesForRecallSemantics,
  rankImageMatches,
  rankUnconfirmedAngleCandidates,
  selectImageMemorySources,
} from './image-memory-core.mjs';

const iso = day => `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const occurrence = (role, ts, path) => createHash('sha256').update(JSON.stringify([role, ts, path])).digest('hex');

test('hammingDistanceHex compares exactly 64 bits and rejects malformed hashes', () => {
  assert.equal(hammingDistanceHex('0000000000000000', '0000000000000000'), 0);
  assert.equal(hammingDistanceHex('0000000000000000', 'ffffffffffffffff'), 64);
  assert.equal(hammingDistanceHex('8000000000000000', '0000000000000001'), 2);
  assert.throws(() => hammingDistanceHex('0', '0000000000000000'), /16.*hex/i);
  assert.throws(() => hammingDistanceHex('gggggggggggggggg', '0000000000000000'), /16.*hex/i);
});

test('cosineSimilarityFloat32 handles same, orthogonal, opposite, and mismatched vectors', () => {
  assert.equal(cosineSimilarityFloat32(new Float32Array([1, 0]), new Float32Array([1, 0])), 1);
  assert.equal(cosineSimilarityFloat32(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
  assert.equal(cosineSimilarityFloat32(new Float32Array([1, 0]), new Float32Array([-1, 0])), -1);
  assert.throws(() => cosineSimilarityFloat32(new Float32Array([1]), new Float32Array([1, 2])), /dimension/i);
  assert.throws(() => cosineSimilarityFloat32(new Float32Array([0, 0]), new Float32Array([1, 0])), /zero/i);
});

test('visual evidence keeps raw maximum but ranks only channels that pass their own threshold', () => {
  const evidence = admitVisualEvidence({
    wholeCosine: 0.9,
    fixedCosine: 0.87,
    yoloCosine: 0.99,
    yoloClassAgreement: true,
  }, { wholeVisualMinScore: 0.88, fixedVisualMinScore: 0.88, yoloVisualMinScore: 1 });
  assert.equal(evidence.rawBestCosine, 0.99);
  assert.equal(evidence.admittedBestCosine, 0.9);
  assert.equal(evidence.cosine, 0.9);
  assert.equal(evidence.visualChannel, 'whole');

  const rejected = admitVisualEvidence({ wholeCosine: 0.87, fixedCosine: 0.87, yoloCosine: 0.87 }, {
    wholeVisualMinScore: 0.88, fixedVisualMinScore: 0.88, yoloVisualMinScore: 0.88,
  });
  assert.equal(rejected.rawBestCosine, 0.87);
  assert.equal(rejected.admittedBestCosine, null);
  assert.equal(rejected.cosine, null);
});

test('visual evidence tie order is whole, same-class YOLO, YOLO, then fixed', () => {
  assert.equal(admitVisualEvidence({ wholeCosine: 0.9, fixedCosine: 0.9, yoloCosine: 0.9, yoloClassAgreement: true }).visualChannel, 'whole');
  assert.equal(admitVisualEvidence({ wholeCosine: null, fixedCosine: 0.9, yoloCosine: 0.9, yoloClassAgreement: true }).visualChannel, 'yolo');
  assert.equal(admitVisualEvidence({ wholeCosine: null, fixedCosine: 0.9, yoloCosine: 0.9, yoloClassAgreement: false }).visualChannel, 'yolo');
  assert.equal(admitVisualEvidence({ wholeCosine: null, fixedCosine: 0.9, yoloCosine: null }).visualChannel, 'fixed');
});

test('threshold ranking recomputes channel admission from raw scores and maps only the winning region evidence', () => {
  const candidate = {
    queryIds: ['q'], relativePath: 'inbox/old.png', sha256: 'old-sha', occurrenceId: 'old', sourceTs: 100, sourceText: '',
    exact: false, hammingDistance: 34, cosine: null,
    wholeCosine: 0.86, fixedCosine: 0.96, yoloCosine: 0.9,
    fixedQueryRegionId: 'fixed-query', fixedCandidateRegionId: 'fixed-old',
    fixedQueryRegionBbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    fixedCandidateRegionBbox: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
    yoloQueryRegionId: 'yolo-query', yoloCandidateRegionId: 'yolo-old',
    yoloQueryRegionBbox: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
    yoloCandidateRegionBbox: { x: 0.4, y: 0.4, width: 0.1, height: 0.1 },
  };
  const fixed = rankImageCandidatesForThresholds([candidate], {
    beforeTs: 200, maxHits: 10, pHashMaxDistance: 8, allowEvaluationTopK: true,
    wholeVisualMinScore: 0.88, fixedVisualMinScore: 0.95, yoloVisualMinScore: 0.91,
  });
  assert.equal(fixed[0]?.visualChannel, 'fixed');
  assert.equal(fixed[0]?.cosine, 0.96);
  assert.equal(fixed[0]?.queryRegionId, 'fixed-query');
  assert.deepEqual(fixed[0]?.candidateRegionBbox, candidate.fixedCandidateRegionBbox);

  const yolo = rankImageCandidatesForThresholds([candidate], {
    beforeTs: 200, maxHits: 10, pHashMaxDistance: 8, allowEvaluationTopK: true,
    wholeVisualMinScore: 0.88, fixedVisualMinScore: 0.97, yoloVisualMinScore: 0.89,
  });
  assert.equal(yolo[0]?.visualChannel, 'yolo');
  assert.equal(yolo[0]?.queryRegionId, 'yolo-query');
  assert.deepEqual(yolo[0]?.candidateRegionBbox, candidate.yoloCandidateRegionBbox);

  const whole = rankImageCandidatesForThresholds([{ ...candidate, wholeCosine: 0.99 }], {
    beforeTs: 200, maxHits: 10, pHashMaxDistance: 8, allowEvaluationTopK: true,
    wholeVisualMinScore: 0.88, fixedVisualMinScore: 0.95, yoloVisualMinScore: 0.89,
  });
  assert.equal(whole[0]?.visualChannel, 'whole');
  assert.equal(whole[0]?.queryRegionId, null);
  assert.equal(whole[0]?.candidateRegionBbox, null);
});

test('raw scores below the formal threshold survive for a later threshold grid', () => {
  const candidate = {
    queryIds: ['q'], relativePath: 'inbox/drinking-fountain.png', sha256: 'old-sha', occurrenceId: 'old', sourceTs: 100, sourceText: '',
    exact: false, hammingDistance: 34, cosine: null,
    wholeCosine: 0.831327737118204, fixedCosine: 0.85, yoloCosine: 0.84,
  };
  assert.deepEqual(rankImageCandidatesForThresholds([candidate], {
    beforeTs: 200, maxHits: 10, pHashMaxDistance: 8, visualMinScore: 0.88, allowEvaluationTopK: true,
  }), []);
  const lowered = rankImageCandidatesForThresholds([candidate], {
    beforeTs: 200, maxHits: 10, pHashMaxDistance: 8, visualMinScore: 0.82, allowEvaluationTopK: true,
  });
  assert.equal(lowered[0]?.relativePath, 'inbox/drinking-fountain.png');
  assert.equal(lowered[0]?.cosine, 0.85);
  assert.equal(lowered[0]?.visualChannel, 'fixed');
});

test('raw candidates fall back from rejected pHash to visual under each threshold grid', () => {
  const candidate = {
    queryIds: ['q'], relativePath: 'inbox/old.png', sha256: 'old-sha', occurrenceId: 'old', sourceTs: 100, sourceText: '',
    exact: false, hammingDistance: 6, cosine: 0.96,
  };
  const strictHash = rankImageCandidatesForThresholds([candidate], {
    beforeTs: 200, maxHits: 10, pHashMaxDistance: 4, visualMinScore: 0.9, allowEvaluationTopK: true,
  });
  assert.equal(strictHash[0]?.kind, 'visual');
  assert.equal(strictHash[0]?.cosine, 0.96);

  const looseHash = rankImageCandidatesForThresholds([candidate], {
    beforeTs: 200, maxHits: 10, pHashMaxDistance: 8, visualMinScore: 0.9, allowEvaluationTopK: true,
  });
  assert.equal(looseHash[0]?.kind, 'near_duplicate');
  assert.equal(looseHash[0]?.hammingDistance, 6);
});

test('production recall semantics suppress visual candidates when the query already has a reliable hash hit', () => {
  const candidates = [
    { queryIds: ['q'], relativePath: 'inbox/exact.png', sha256: 'exact', occurrenceId: 'exact', sourceTs: 100, sourceText: '', exact: true, hammingDistance: null, cosine: null },
    { queryIds: ['q'], relativePath: 'inbox/visual.png', sha256: 'visual', occurrenceId: 'visual', sourceTs: 101, sourceText: '', exact: false, hammingDistance: 20, cosine: 1 },
  ];
  const ranked = rankImageCandidatesForRecallSemantics(candidates, {
    beforeTs: 200, maxHits: 3, pHashMaxDistance: 0, visualMinScore: 0.88,
  });
  assert.deepEqual(ranked.map(match => match.occurrenceId), ['exact']);
});

function angleCandidate(id, wholeCosine, fixedCosine, {
  queryId = 'q', sourceTs = 100, sha256 = id, occurrenceId = id, yoloCosine = null,
} = {}) {
  const raw = {
    queryId, queryIds: [queryId], queryRelativePath: `inbox/${queryId}.png`, querySha256: `${queryId}-sha`,
    relativePath: `inbox/${id}.png`, sha256, occurrenceId, sourceTs, sourceText: '',
    wholeCosine, fixedCosine, yoloCosine,
    fixedQueryRegionId: `${queryId}-fixed`, fixedCandidateRegionId: `${id}-fixed`,
    fixedQueryRegionBbox: { x: 0, y: 0, width: 0.5, height: 0.5 },
    fixedCandidateRegionBbox: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
  };
  return { ...raw, queryEvidence: [raw] };
}

test('angle fallback uses fixed top-three intersection even when whole and fixed winners are different images', () => {
  const ranked = rankUnconfirmedAngleCandidates([
    angleCandidate('whole-winner', 0.99, 0.6),
    angleCandidate('fixed-winner', 0.6, 0.99),
    angleCandidate('shared-best', 0.9, 0.9, { yoloCosine: 0.1 }),
    angleCandidate('shared-next', 0.8, 0.85, { yoloCosine: 1 }),
    angleCandidate('outside', 0.7, 0.8),
  ], { beforeTs: 200, maxHits: 3 });

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].sha256, 'shared-best');
  assert.equal(ranked[0].candidateType, 'unconfirmed_angle');
  assert.equal(ranked[0].confidence, 'unconfirmed');
  assert.equal(ranked[0].kind, undefined);
  assert.deepEqual(ranked[0].queryIds, ['q']);
  assert.deepEqual(ranked[0].queryEvidence[0].whole, { score: 0.9, rank: 2 });
  assert.equal(ranked[0].queryEvidence[0].fixed.rank, 2);
  assert.equal(ranked[0].queryEvidence[0].fixed.candidateRegionId, 'shared-best-fixed');
  assert.equal(ranked[0].queryEvidence[0].yoloDiagnostic.score, 0.1);
});

test('angle fallback rejects missing channels and disjoint top-three lists while ignoring YOLO rank', () => {
  const candidates = [
    angleCandidate('w1', 0.99, 0.1, { yoloCosine: 0 }),
    angleCandidate('w2', 0.98, 0.2, { yoloCosine: 0 }),
    angleCandidate('w3', 0.97, null, { yoloCosine: 1 }),
    angleCandidate('f1', 0.1, 0.99, { yoloCosine: 1 }),
    angleCandidate('f2', 0.2, 0.98, { yoloCosine: 1 }),
    angleCandidate('f3', null, 0.97, { yoloCosine: 1 }),
  ];
  assert.deepEqual(rankUnconfirmedAngleCandidates(candidates, { beforeTs: 200, maxHits: 3 }), []);
});

test('angle fallback deduplicates SHA evidence, excludes strict-covered queries and preserves cross-query fairness', () => {
  const candidates = [
    angleCandidate('q1-a', 0.9, 0.9, { queryId: 'q1', sha256: 'shared', occurrenceId: 'later', sourceTs: 20 }),
    angleCandidate('q1-b', 0.9, 0.9, { queryId: 'q1', sha256: 'shared', occurrenceId: 'earlier', sourceTs: 10 }),
    angleCandidate('q2', 0.8, 0.8, { queryId: 'q2', sourceTs: 30 }),
    angleCandidate('q3', 0.7, 0.7, { queryId: 'q3', sourceTs: 40 }),
  ];
  const strictMatches = [{ sha256: 'strict', queryIds: ['q1'] }];
  const ranked = rankUnconfirmedAngleCandidates(candidates, { beforeTs: 200, maxHits: 3, strictMatches });

  assert.deepEqual(ranked.map(row => row.queryIds), [['q2'], ['q3']]);
  assert.equal(ranked[0].queryEvidence.length, 1);
  assert.equal(ranked.every(row => row.candidateType === 'unconfirmed_angle' && row.confidence === 'unconfirmed'), true);
  assert.equal(ranked.length + strictMatches.length, 3);
});

test('angle fallback keeps low absolute scores unconfirmed instead of treating them as identity confirmation', () => {
  const ranked = rankUnconfirmedAngleCandidates([
    angleCandidate('low', 0.12, 0.11),
  ], { beforeTs: 200, maxHits: 1 });
  assert.equal(ranked[0].confidence, 'unconfirmed');
  assert.equal(ranked[0].candidateType, 'unconfirmed_angle');
  assert.equal(Object.hasOwn(ranked[0], 'confirmed'), false);
});

test('rankImageMatches filters future and self matches, keeps historical same SHA, deduplicates, and preserves query ids', () => {
  const beforeTs = Date.parse(iso(20));
  const ranked = rankImageMatches([
    { queryIds: ['batch:0'], relativePath: 'inbox/exact-old.jpg', sha256: 'same', occurrenceId: 'old', sourceTs: Date.parse(iso(1)), sourceText: 'old', kind: 'exact', hammingDistance: null, cosine: null },
    { queryIds: ['batch:1'], relativePath: 'inbox/exact-copy.jpg', sha256: 'same', occurrenceId: 'old-copy', sourceTs: Date.parse(iso(2)), sourceText: 'copy', kind: 'exact', hammingDistance: null, cosine: null },
    { queryIds: ['batch:0'], relativePath: 'inbox/self.jpg', sha256: 'self', occurrenceId: 'self', sourceTs: Date.parse(iso(3)), sourceText: '', kind: 'exact', hammingDistance: null, cosine: null },
    { queryIds: ['batch:1'], relativePath: 'inbox/future.jpg', sha256: 'future', occurrenceId: 'future', sourceTs: beforeTs, sourceText: '', kind: 'exact', hammingDistance: null, cosine: null },
    { queryIds: ['batch:1'], relativePath: 'inbox/near.jpg', sha256: 'near', occurrenceId: 'near', sourceTs: Date.parse(iso(4)), sourceText: '', kind: 'near_duplicate', hammingDistance: 3, cosine: null },
    { queryIds: ['batch:0'], relativePath: 'inbox/visual.jpg', sha256: 'visual', occurrenceId: 'visual', sourceTs: Date.parse(iso(5)), sourceText: '', kind: 'visual', hammingDistance: null, cosine: 0.93 },
  ], { beforeTs, excludeOccurrenceIds: ['self'], maxHits: 3 });

  assert.deepEqual(ranked.map(row => row.kind), ['exact', 'near_duplicate', 'visual']);
  assert.deepEqual(ranked[0].queryIds, ['batch:0', 'batch:1']);
  assert.equal(ranked[0].occurrenceId, 'old');
  assert.equal(ranked.some(row => row.occurrenceId === 'future' || row.occurrenceId === 'self'), false);
});

test('rankImageMatches gives each query its best reliable candidate before filling remaining slots', () => {
  const matches = [
    { queryIds: ['q1'], relativePath: 'inbox/a.jpg', sha256: 'a', occurrenceId: 'a', sourceTs: 1, sourceText: '', kind: 'exact', hammingDistance: null, cosine: null },
    { queryIds: ['q1'], relativePath: 'inbox/b.jpg', sha256: 'b', occurrenceId: 'b', sourceTs: 2, sourceText: '', kind: 'near_duplicate', hammingDistance: 1, cosine: null },
    { queryIds: ['q2'], relativePath: 'inbox/c.jpg', sha256: 'c', occurrenceId: 'c', sourceTs: 3, sourceText: '', kind: 'visual', hammingDistance: null, cosine: 0.91 },
    { queryIds: ['q3'], relativePath: 'inbox/weak.jpg', sha256: 'd', occurrenceId: 'd', sourceTs: 4, sourceText: '', kind: 'visual', hammingDistance: null, cosine: 0.5 },
  ];
  assert.deepEqual(rankImageMatches(matches, { beforeTs: 10, maxHits: 3 }).map(row => row.occurrenceId), ['a', 'c', 'b']);
});

test('rankImageMatches keeps the earliest complete occurrence as one intact source record', () => {
  const ranked = rankImageMatches([
    { queryIds: ['q1'], relativePath: 'inbox/empty.jpg', sha256: 'same', occurrenceId: 'empty', sourceTs: 1, sourceText: '', kind: 'exact', hammingDistance: null, cosine: null },
    { queryIds: ['q2'], relativePath: 'inbox/captioned.jpg', sha256: 'same', occurrenceId: 'captioned', sourceTs: 2, sourceText: 'the useful caption', kind: 'exact', hammingDistance: null, cosine: null },
    { queryIds: ['q3'], relativePath: 'inbox/later.jpg', sha256: 'same', occurrenceId: 'later', sourceTs: 3, sourceText: 'later caption', kind: 'exact', hammingDistance: null, cosine: null },
  ], { beforeTs: 10, maxHits: 3 });
  assert.equal(ranked.length, 1);
  assert.deepEqual({
    relativePath: ranked[0].relativePath,
    occurrenceId: ranked[0].occurrenceId,
    sourceTs: ranked[0].sourceTs,
    sourceText: ranked[0].sourceText,
  }, {
    relativePath: 'inbox/captioned.jpg',
    occurrenceId: 'captioned',
    sourceTs: 2,
    sourceText: 'the useful caption',
  });
  assert.deepEqual(ranked[0].queryIds, ['q1', 'q2', 'q3']);
});

test('rankImageMatches covers uncovered queries before filling extra slots', () => {
  const match = (id, queryIds, sourceTs) => ({ queryIds, relativePath: `inbox/${id}.jpg`, sha256: id, occurrenceId: id, sourceTs, sourceText: '', kind: 'exact', hammingDistance: null, cosine: null });
  const ranked = rankImageMatches([
    match('a', ['q1', 'q2', 'q3'], 1),
    match('b', ['q2'], 2),
    match('c', ['q3'], 3),
    match('d', ['q4'], 4),
  ], { beforeTs: 10, maxHits: 3 });
  assert.deepEqual(ranked.map(row => row.occurrenceId), ['a', 'd', 'b']);
});

test('rankImageMatches never exceeds maxHits after fair query coverage', () => {
  const matches = [0, 1, 2, 3].map(index => ({
    queryIds: [`q${index}`],
    relativePath: `inbox/${index}.png`,
    sha256: `sha-${index}`,
    occurrenceId: `occ-${index}`,
    sourceTs: 100 + index,
    sourceText: '',
    kind: 'exact',
  }));
  assert.equal(rankImageMatches(matches, { beforeTs: 1000, maxHits: 3 }).length, 3);
  assert.equal(rankImageMatches(matches, { beforeTs: 1000, maxHits: 1 }).length, 1);
});

test('rankImageMatches caps fill candidates from the same query', () => {
  const matches = [0, 1, 2].map(index => ({
    queryIds: ['q0'],
    relativePath: `inbox/same-query-${index}.png`,
    sha256: `same-query-sha-${index}`,
    occurrenceId: `same-query-occ-${index}`,
    sourceTs: 100 + index,
    sourceText: '',
    kind: 'exact',
  }));
  assert.equal(rankImageMatches(matches, { beforeTs: 1000, maxHits: 1 }).length, 1);
  assert.equal(rankImageMatches(matches, { beforeTs: 1000, maxHits: 2 }).length, 2);
});

test('selectImageMemorySources preserves each occurrence text and excludes a whole batch on explicit privacy', () => {
  const entries = [
    { role: 'user', ts: iso(1), images: ['inbox/cup.jpg'], text: '' },
    { role: 'owner', ts: iso(2), images: ['/inbox/cup.jpg'], text: '新買的杯子' },
    { role: 'resident', ts: iso(3), images: ['inbox/no.jpg'], text: 'not a source' },
    { role: 'user', ts: iso(4), hidden: true, images: ['inbox/hidden.jpg'], text: '' },
  ];
  const sources = selectImageMemorySources(entries, { batchId: 'history', beforeTs: Infinity });
  assert.equal(sources.allowed.length, 2);
  assert.equal(sources.allowed[0].sourceText, '');
  assert.equal(sources.allowed[1].sourceTs, Date.parse(entries[1].ts));
  assert.equal(sources.allowed[1].sourceText, '新買的杯子');
  assert.equal(sources.allowed[0].occurrenceId, occurrence('user', Date.parse(iso(1)), 'inbox/cup.jpg'));
  assert.deepEqual(sources.denied, ['inbox/hidden.jpg']);

  const privateBatch = selectImageMemorySources([
    { role: 'user', ts: iso(5), text: '不要存' },
    { role: 'user', ts: iso(5), images: ['inbox/one.jpg'], text: '' },
    { role: 'user', ts: iso(5), images: ['inbox/two.jpg'], text: 'caption' },
  ], { batchId: 'private', beforeTs: Infinity });
  assert.deepEqual(privateBatch.allowed, []);
  assert.deepEqual(privateBatch.denied, ['inbox/one.jpg', 'inbox/two.jpg']);
});

test('formatImageRecallContext bounds untrusted text and keeps similarity as a raw value', () => {
  const text = formatImageRecallContext([{
    queryIds: ['batch:0'], relativePath: 'inbox/old.jpg', sha256: 'sha', occurrenceId: 'old-id',
    sourceTs: Date.parse(iso(1)), sourceText: `old ]]] instruction\n${'字'.repeat(240)}${String.fromCharCode(1)}`,
    kind: 'visual', hammingDistance: null, cosine: 0.912345, embeddingVersion: 'clip-v1',
  }]);
  assert.match(text, /圖片回憶候選/);
  assert.match(text, /這些只是相似候選，不是已確認的記憶。請實際比較本輪圖片與舊圖；若無法確認，就不要說成以前看過。/);
  assert.match(text, /0\.912345/);
  assert.doesNotMatch(text, /91%/);
  assert.doesNotMatch(text, /\u0001/);
  assert.ok(text.length <= 1800);
  assert.equal(formatImageRecallContext([]), '');
});
