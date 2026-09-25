import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import { admitVisualEvidence, cosineSimilarityFloat32, hammingDistanceHex, rankImageCandidatesForThresholds, rankUnconfirmedAngleCandidates } from '../../image-memory-core.mjs';
import {
  filterImageMemoryMatchesByPolicy,
  imageMemoryPolicyStatus,
  readImageMemoryPolicy,
  revokeImageMemoryAsync,
} from '../../image-memory-policy.mjs';
import { computePhash, computeSha256, PHASH_VERSION } from './phash.mjs';
import { createImageMemoryRoots, decodeImageMemoryImage, resolveImageMemoryImage } from './image-input.mjs';
import { createRequestParser } from './protocol.mjs';
import { getChatWindow, getLogicalImageStoreDigest, getRegionStats, getSourceGeneration, getStats, listImageSources, listSearchableImages, listSearchableRegions, listSourceGenerations, openImageStore, removeImage, replaceImageRegionChannelSet, replaceSourceSnapshot, updateImageEmbedding, upsertImageHash, upsertImagePath, upsertOccurrence } from './store.mjs';
import { createEmbeddingProcessClient } from './embedding-process.mjs';
import { fixedRegions, selectOnlineRegions, selectYoloRegions } from './regions.mjs';
import { createDetectorProcessClient } from './detector-process.mjs';
import { REGION_V1, verifyDetectorManifest } from '../image-region/detector-spec.mjs';

function workerError(message, code, retryable = false, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, retryable });
}

function denied(policy, relativePath, sha256 = null) {
  return policy.paths?.[relativePath] != null || (sha256 && policy.shas?.[sha256] != null);
}

export async function verifyImageAccessAfterHash({ policyPath, relativePath, expectedSha, hashCurrent, onAllowed = () => true }) {
  if (imageMemoryPolicyStatus(policyPath).paused) return false;
  if (denied(readImageMemoryPolicy(policyPath), relativePath, expectedSha)) return false;
  const actualSha = await hashCurrent();
  if (actualSha !== expectedSha) return false;
  if (imageMemoryPolicyStatus(policyPath).paused) return false;
  if (denied(readImageMemoryPolicy(policyPath), relativePath, actualSha)) return false;
  return onAllowed(actualSha);
}

function publicError(error) {
  return { code: String(error?.code || 'IMAGE_WORKER_FAILED'), message: String(error?.message || 'image worker failed').replace(/[A-Za-z]:\\[^\s]+|\/[\w./-]+/g, '[path]').slice(0, 200), retryable: error?.retryable === true };
}

function beforeDeadline(promise, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.reject(workerError('visual deadline expired', 'MODEL_DEADLINE', true));
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(workerError('visual deadline expired', 'MODEL_DEADLINE', true)), remaining); }),
  ]).finally(() => clearTimeout(timer));
}

export function queryDeadlineBudget(receivedAt, deadlineMs, requestedDeadlineAt = null) {
  const localDeadlineAt = receivedAt + Math.max(1, Number(deadlineMs) || 1);
  const deadlineAt = Number.isFinite(requestedDeadlineAt) ? Math.min(requestedDeadlineAt, localDeadlineAt) : localDeadlineAt;
  const availableMs = Math.max(1, deadlineAt - receivedAt);
  const reserveMs = Math.min(500, Math.max(30, Math.floor(availableMs / 5)));
  return { deadlineAt, visualDeadlineAt: deadlineAt - reserveMs, reserveMs };
}

export function orderCandidatesForValidation(candidates, rankOptions) {
  const rows = Array.isArray(candidates) ? candidates : [];
  const ranked = rankImageCandidatesForThresholds(rows, {
    ...rankOptions,
    maxHits: 100,
    allowEvaluationTopK: true,
  });
  const candidateKey = row => String(row?.sha256 || row?.relativePath || row?.occurrenceId || '');
  const groups = new Map();
  for (const row of rows) {
    const key = candidateKey(row);
    if (!key) continue;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const ordered = [];
  for (const selected of ranked) {
    const group = groups.get(candidateKey(selected)) || [];
    group.sort((left, right) => {
      const selectedFirst = Number(right.occurrenceId === selected.occurrenceId) - Number(left.occurrenceId === selected.occurrenceId);
      if (selectedFirst) return selectedFirst;
      const time = Number(left.sourceTs) - Number(right.sourceTs);
      return time || String(left.occurrenceId || '').localeCompare(String(right.occurrenceId || ''));
    });
    ordered.push(...group);
  }
  return ordered;
}

export function orderUnconfirmedCandidatesForValidation(candidates, {
  beforeTs = Infinity, excludeOccurrenceIds = [], strictMatches = [], topKPerChannel = 3,
} = {}) {
  const excluded = new Set((excludeOccurrenceIds || []).map(String));
  const coveredQueries = new Set((strictMatches || []).flatMap(match => match?.queryIds || []).map(String));
  const selectedShas = new Set((strictMatches || []).map(match => String(match?.sha256 || '')).filter(Boolean));
  const byQuery = new Map();
  const sourceRows = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || excluded.has(String(candidate.occurrenceId || '')) || !(Number(candidate.sourceTs) < beforeTs)) continue;
    const evidenceRows = Array.isArray(candidate.queryEvidence) && candidate.queryEvidence.length ? candidate.queryEvidence : [candidate];
    for (const evidence of evidenceRows) {
      const queryIds = [...new Set((evidence?.queryIds || candidate.queryIds || (evidence?.queryId ? [evidence.queryId] : candidate.queryId ? [candidate.queryId] : [])).map(String))];
      for (const queryId of queryIds) {
        if (!queryId || coveredQueries.has(queryId) || !candidate.sha256 || selectedShas.has(String(candidate.sha256))) continue;
        const row = { ...candidate, ...evidence, queryId, queryIds: [queryId], relativePath: candidate.relativePath, sha256: candidate.sha256, occurrenceId: candidate.occurrenceId, sourceTs: candidate.sourceTs };
        sourceRows.push({ candidate, row });
        let bySha = byQuery.get(queryId);
        if (!bySha) { bySha = new Map(); byQuery.set(queryId, bySha); }
        const prior = bySha.get(String(candidate.sha256)) || { sha256: String(candidate.sha256), whole: null, fixed: null };
        if (Number.isFinite(row.wholeCosine) && (!prior.whole || Number(row.wholeCosine) > Number(prior.whole.wholeCosine))) prior.whole = row;
        if (Number.isFinite(row.fixedCosine) && (!prior.fixed || Number(row.fixedCosine) > Number(prior.fixed.fixedCosine))) prior.fixed = row;
        bySha.set(prior.sha256, prior);
      }
    }
  }
  const allowedPairs = new Set();
  for (const [queryId, bySha] of byQuery) {
    const groups = [...bySha.values()];
    const stable = field => (left, right) => Number(right[field][`${field === 'whole' ? 'whole' : 'fixed'}Cosine`]) - Number(left[field][`${field === 'whole' ? 'whole' : 'fixed'}Cosine`])
      || Number(left[field].sourceTs) - Number(right[field].sourceTs)
      || String(left[field].occurrenceId || '').localeCompare(String(right[field].occurrenceId || ''));
    const whole = groups.filter(group => group.whole).sort(stable('whole')).slice(0, topKPerChannel);
    const fixed = groups.filter(group => group.fixed).sort(stable('fixed')).slice(0, topKPerChannel);
    for (const group of [...whole, ...fixed]) allowedPairs.add(`${queryId}\u0000${group.sha256}`);
  }
  const selected = [];
  const seen = new Set();
  for (const { candidate, row } of sourceRows) {
    if (!allowedPairs.has(`${row.queryId}\u0000${row.sha256}`)) continue;
    const key = `${row.queryId}\u0000${row.sha256}\u0000${row.occurrenceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(candidate);
  }
  return selected;
}

export function createImageMemoryWorker({
  inboxDir, lifePhotosDir, galleryDir, imageRoots = null, dbPath, policyPath, embeddingVersion = null, embedImage = null, embeddingClient = null,
  regionConfig = null, embedRegions = null, detectImage = null, detectorClient = null, readOnly = false, readSnapshot = false,
  angleCandidateRanker = rankUnconfirmedAngleCandidates, onImageRead = null,
}) {
  if (readSnapshot && !readOnly) throw workerError('snapshot mode requires read-only mode', 'IMAGE_STORE_SNAPSHOT_REQUIRES_READ_ONLY');
  const db = openImageStore(dbPath, { readOnly });
  if (readSnapshot) db.exec('BEGIN');
  const roots = imageRoots || createImageMemoryRoots({ inboxDir, lifePhotosDir, galleryDir });
  const backgroundEmbeddings = new Map();
  const backgroundRegions = new Map();
  const sourceSnapshots = new Map();
  let closing = false;

  const auditImageRead = async (stage, relativePath) => {
    if (typeof onImageRead === 'function') await onImageRead({ stage, relativePath });
  };

  async function hashFeatures(relativePath, stage = 'source-hash') {
    await auditImageRead(stage, relativePath);
    const resolved = await resolveImageMemoryImage(relativePath, roots);
    const sha256 = await computeSha256(resolved.absolutePath);
    const phash = await computePhash(relativePath, roots);
    return { resolved, sha256, ...phash };
  }

  async function visualFeature(relativePath) {
    if (!embeddingVersion) return null;
    const provider = typeof embedImage === 'function' ? embedImage : embeddingClient?.embed?.bind(embeddingClient);
    if (!provider) return null;
    const value = await provider(relativePath);
    return value instanceof Float32Array ? value : Float32Array.from(value || []);
  }

  function visualAvailable() {
    return !!(embeddingVersion && (typeof embedImage === 'function' || embeddingClient?.ready === true));
  }

  function regionsAvailable() {
    return !!(regionConfig && embeddingVersion && (typeof embedRegions === 'function' || embeddingClient?.ready === true));
  }

  function yoloEnabled() {
    return !!(regionConfig && regionConfig.yoloEnabled !== false);
  }

  async function regionFeatures(relativePath, descriptors, expectedSha256, priority = 'background', deadlineAt = null) {
    if (!descriptors.length) return [];
    const provider = typeof embedRegions === 'function' ? embedRegions : embeddingClient?.embedRegions?.bind(embeddingClient);
    if (!provider) throw workerError('region embedding is unavailable', 'MODEL_UNAVAILABLE', true);
    const value = await provider(relativePath, descriptors, { expectedSha256, priority, deadlineAt });
    if (!Array.isArray(value) || value.length !== descriptors.length) throw workerError('region embedding result is invalid', 'MODEL_PROTOCOL_ERROR', true);
    return value.map(vector => vector instanceof Float32Array ? vector : Float32Array.from(vector || []));
  }

  async function detectRegions(relativePath, expectedSha256, priority = 'background', deadlineAt = null) {
    const provider = typeof detectImage === 'function' ? detectImage : detectorClient?.detect?.bind(detectorClient);
    if (!provider) throw workerError('detector is unavailable', 'DETECTOR_UNAVAILABLE', true);
    return provider(relativePath, { expectedSha256, priority, deadlineAt });
  }

  function regionSetReady(imageId, featureVersion, channel) {
    return !!db.prepare('SELECT 1 FROM region_sets WHERE image_id=? AND feature_version=? AND channel=?').get(imageId, featureVersion, channel);
  }

  function missingRegionCount(imageId) {
    if (!regionConfig || !embeddingVersion) return 0;
    let count = regionSetReady(imageId, regionConfig.fixedFeatureVersion, 'fixed') ? 0 : 1;
    if (yoloEnabled() && !regionSetReady(imageId, regionConfig.yoloFeatureVersion, 'yolo')) count++;
    return count;
  }

  async function embedAndPersist(source, hash) {
    const embedding = await visualFeature(source.relativePath);
    if (!embedding || closing) return false;
    return verifyImageAccessAfterHash({
      policyPath,
      relativePath: source.relativePath,
      expectedSha: hash.sha256,
      hashCurrent: async () => (await hashFeatures(source.relativePath)).sha256,
      onAllowed: () => {
        if (closing) return false;
        db.exec('BEGIN IMMEDIATE');
        try {
          updateImageEmbedding(db, { relativePath: source.relativePath, sha256: hash.sha256, embedding, embeddingDims: embedding.length, embeddingVersion, indexedAt: Date.now() });
          db.exec('COMMIT');
          return true;
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
      },
    });
  }

  function scheduleEmbedding(source, hash) {
    const key = `${source.relativePath}:${hash.sha256}:${embeddingVersion}`;
    if (backgroundEmbeddings.has(key) || closing) return;
    const job = embedAndPersist(source, hash).catch(() => false).finally(() => backgroundEmbeddings.delete(key));
    backgroundEmbeddings.set(key, job);
  }

  async function persistRegionSet(source, hash, imageId, channel, descriptors, vectors, detector = null) {
    if (closing) return false;
    return verifyImageAccessAfterHash({
      policyPath,
      relativePath: source.relativePath,
      expectedSha: hash.sha256,
      hashCurrent: async () => (await hashFeatures(source.relativePath)).sha256,
      onAllowed: () => {
        if (closing) return false;
        replaceImageRegionChannelSet(db, {
          imageId,
          imageSha256: hash.sha256,
          featureVersion: channel === 'fixed' ? regionConfig.fixedFeatureVersion : regionConfig.yoloFeatureVersion,
          channel,
          detectorVersion: channel === 'yolo' ? detector.detectorVersion : null,
          cropVersion: channel === 'fixed' ? regionConfig.fixedCropVersion : `pad${Math.round(regionConfig.paddingFraction * 100)}-v1`,
          embeddingVersion,
          rawDetectionCount: channel === 'yolo' ? detector.rawDetectionCount : null,
          acceptedDetectionCount: channel === 'yolo' ? descriptors.length : null,
          indexedAt: Date.now(),
          regions: descriptors.map((item, index) => ({ ...item, embedding: vectors[index] })),
        });
        return true;
      },
    });
  }

  async function indexRegionChannels(source, hash, imageId) {
    if (!regionConfig || !embeddingVersion) return { pendingRegions: 0, codes: [] };
    let pendingRegions = 0;
    const codes = [];
    if (!regionSetReady(imageId, regionConfig.fixedFeatureVersion, 'fixed')) {
      try {
        const decoded = await decodeImageMemoryImage(source.relativePath, roots);
        if (decoded.sha256 !== hash.sha256) throw workerError('image changed before fixed region indexing', 'IMAGE_CHANGED_DURING_READ', true);
        const descriptors = fixedRegions(decoded);
        const vectors = await regionFeatures(source.relativePath, descriptors, hash.sha256, 'background');
        if (!await persistRegionSet(source, hash, imageId, 'fixed', descriptors, vectors)) pendingRegions++;
      } catch (error) { pendingRegions++; codes.push(error.code || 'MODEL_UNAVAILABLE'); }
    }
    if (yoloEnabled() && !regionSetReady(imageId, regionConfig.yoloFeatureVersion, 'yolo')) {
      try {
        const detector = await detectRegions(source.relativePath, hash.sha256, 'background');
        const descriptors = selectYoloRegions(detector.detections, { width: detector.orientedWidth, height: detector.orientedHeight }, regionConfig);
        const vectors = descriptors.length ? await regionFeatures(source.relativePath, descriptors, hash.sha256, 'background') : [];
        if (!await persistRegionSet(source, hash, imageId, 'yolo', descriptors, vectors, detector)) pendingRegions++;
      } catch (error) { pendingRegions++; codes.push(error.code || 'DETECTOR_UNAVAILABLE'); }
    }
    return { pendingRegions, codes };
  }

  function scheduleRegions(source, hash, imageId) {
    const key = `${source.relativePath}:${hash.sha256}:${regionConfig?.fixedFeatureVersion}:${regionConfig?.yoloFeatureVersion}`;
    if (!regionConfig || backgroundRegions.has(key) || closing) return;
    const job = indexRegionChannels(source, hash, imageId).catch(() => ({ pendingRegions: yoloEnabled() ? 2 : 1, codes: [] })).finally(() => backgroundRegions.delete(key));
    backgroundRegions.set(key, job);
  }

  async function indexSources(sources) {
    const status = imageMemoryPolicyStatus(policyPath);
    if (status.paused) return { indexed: 0, unchanged: 0, pendingEmbedding: 0, failed: sources.length, codes: [status.code] };
    let indexed = 0, unchanged = 0, pendingEmbedding = 0, pendingRegions = 0, failed = 0;
    const codes = [];
    for (const source of sources) {
      try {
        if (imageMemoryPolicyStatus(policyPath).paused) throw workerError('image memory policy has pending denials', 'IMAGE_MEMORY_POLICY_PENDING');
        const policy = readImageMemoryPolicy(policyPath);
        if (denied(policy, source.relativePath)) throw workerError('source is denied by policy', 'IMAGE_POLICY_DENIED');
        const hash = await hashFeatures(source.relativePath);
        if (imageMemoryPolicyStatus(policyPath).paused) throw workerError('image memory policy has pending denials', 'IMAGE_MEMORY_POLICY_PENDING');
        if (denied(readImageMemoryPolicy(policyPath), source.relativePath, hash.sha256)) throw workerError('source is denied by policy', 'IMAGE_POLICY_DENIED');
        const current = db.prepare('SELECT * FROM images WHERE relative_path = ?').get(source.relativePath);
        const occurrence = db.prepare('SELECT source_ts, source_text, image_id FROM occurrences WHERE occurrence_id = ?').get(source.occurrenceId);
        const same = current && current.sha256 === hash.sha256 && Number(current.file_mtime_ms) === Number(hash.resolved.stat.mtimeMs)
          && Number(current.file_size) === Number(hash.resolved.stat.size) && occurrence && Number(occurrence.source_ts) === Number(source.sourceTs)
          && String(occurrence.source_text) === String(source.sourceText || '') && (!embeddingVersion || current.embedding_version === embeddingVersion);
        if (same) {
          unchanged++;
          if (embeddingVersion && (!current.embedding || current.embedding_version !== embeddingVersion)) pendingEmbedding++;
          if (regionConfig) {
            if (typeof embedRegions === 'function') {
              const result = await indexRegionChannels(source, hash, Number(current.id));
              pendingRegions += result.pendingRegions;
              codes.push(...result.codes);
            } else {
              pendingRegions += missingRegionCount(Number(current.id));
              if (regionsAvailable()) scheduleRegions(source, hash, Number(current.id));
            }
          }
          continue;
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const imageId = upsertImageHash(db, {
            relativePath: source.relativePath, sha256: hash.sha256, phash: hash.phash,
            phashVersion: hash.phashVersion, phashUsable: hash.phashUsable,
            fileMtimeMs: hash.resolved.stat.mtimeMs, fileSize: hash.resolved.stat.size, indexedAt: Date.now(),
          });
          upsertOccurrence(db, { occurrenceId: source.occurrenceId, imageId, relativePath: source.relativePath, sourceTs: source.sourceTs, sourceText: source.sourceText });
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch {}
          throw error;
        }
        indexed++;
        const keptEmbedding = current && current.sha256 === hash.sha256 && Number(current.file_mtime_ms) === Number(hash.resolved.stat.mtimeMs)
          && Number(current.file_size) === Number(hash.resolved.stat.size) && current.embedding && current.embedding_version === embeddingVersion;
        if (embeddingVersion && !keptEmbedding) {
          if (typeof embedImage === 'function') {
            let stored = false;
            try { stored = await embedAndPersist(source, hash); } catch (error) { codes.push(error.code || 'MODEL_UNAVAILABLE'); }
            if (!stored) pendingEmbedding++;
          } else {
            if (embeddingClient?.ready === true) scheduleEmbedding(source, hash);
            pendingEmbedding++;
          }
        }
        const storedImage = db.prepare('SELECT id FROM images WHERE relative_path=? AND sha256=?').get(source.relativePath, hash.sha256);
        if (regionConfig && storedImage) {
          if (typeof embedRegions === 'function') {
            const result = await indexRegionChannels(source, hash, Number(storedImage.id));
            pendingRegions += result.pendingRegions;
            codes.push(...result.codes);
          } else {
            pendingRegions += missingRegionCount(Number(storedImage.id));
            if (regionsAvailable()) scheduleRegions(source, hash, Number(storedImage.id));
          }
        }
      } catch (error) {
        failed++;
        codes.push(error.code || 'IMAGE_INDEX_FAILED');
      }
    }
    return {
      indexed, unchanged, pendingEmbedding,
      ...(regionConfig ? { pendingRegions } : {}),
      failed, codes: [...new Set(codes)],
    };
  }

  async function recall(request) {
    const status = imageMemoryPolicyStatus(policyPath);
    if (status.paused) return { matches: [], warnings: [status.code], channels: { hash: 'unavailable', visual: 'unavailable', fixed: 'unavailable', yolo: 'unavailable' }, skippedQueryCount: request.queries.length };
    const receivedAt = Number.isFinite(request.receivedAt) ? request.receivedAt : Date.now();
    const { deadlineAt, visualDeadlineAt } = queryDeadlineBudget(receivedAt, request.deadlineMs, request.deadlineAt);
    const policy = readImageMemoryPolicy(policyPath);
    const candidates = [];
    let visualReady = visualAvailable();
    let fixedReady = regionsAvailable();
    let yoloReady = fixedReady && yoloEnabled() && (typeof detectImage === 'function' || detectorClient?.ready === true);
    let hashReady = true;
    const warnings = [];
    const regionDiagnostics = {
      mode: request.op === 'evaluate' && ['whole', 'fixed', 'yolo', 'combined'].includes(request.regionMode) ? request.regionMode : 'combined',
      rawDetectionCount: null,
      acceptedDetectionCount: null,
      selectedRegionCount: 0,
      selectedChannels: [],
    };
    const regionMode = request.op === 'evaluate' && ['whole', 'fixed', 'yolo', 'combined'].includes(request.regionMode) ? request.regionMode : 'combined';
    await Promise.all(request.queries.map(async query => {
      try {
        if (denied(policy, query.relativePath)) return;
        const hash = await hashFeatures(query.relativePath, 'query-hash');
        if (denied(readImageMemoryPolicy(policyPath), query.relativePath, hash.sha256)) return;
        const rows = listSearchableImages(db, { beforeTs: request.beforeTs, excludeOccurrenceIds: request.excludeOccurrenceIds, embeddingVersion });
        const exactRows = rows.filter(row => row.sha256 === hash.sha256);
        const hasReliableHashMatch = exactRows.length > 0 || rows.some(row => {
          if (!hash.phashUsable || !row.phashUsable || row.phashVersion !== hash.phashVersion) return false;
          return hammingDistanceHex(hash.phash, row.phash) <= request.limits.pHashMaxDistance;
        });
        let queryEmbedding = null;
        let decoded = null;
        let detector = null;
        const shouldVisualize = request.op === 'evaluate' || !hasReliableHashMatch;
        const wholeWanted = shouldVisualize && visualReady && (regionMode === 'whole' || regionMode === 'combined');
        const fixedWanted = shouldVisualize && fixedReady && regionConfig && (regionMode === 'fixed' || regionMode === 'combined');
        const yoloWanted = shouldVisualize && yoloReady && regionConfig && (regionMode === 'yolo' || regionMode === 'combined');
        const [wholeResult, decodedResult, detectorResult] = await Promise.allSettled([
          wholeWanted ? beforeDeadline(visualFeature(query.relativePath), visualDeadlineAt) : null,
          fixedWanted ? beforeDeadline((async () => { await auditImageRead('query-decode', query.relativePath); return decodeImageMemoryImage(query.relativePath, roots); })(), visualDeadlineAt) : null,
          yoloWanted ? beforeDeadline(detectRegions(query.relativePath, hash.sha256, 'query', visualDeadlineAt), visualDeadlineAt) : null,
        ]);
        if (wholeResult.status === 'fulfilled') queryEmbedding = wholeResult.value;
        else { visualReady = false; warnings.push(wholeResult.reason?.code || 'MODEL_UNAVAILABLE'); }
        if (decodedResult.status === 'fulfilled') decoded = decodedResult.value;
        else { fixedReady = false; warnings.push(decodedResult.reason?.code || 'IMAGE_DECODE_FAILED'); }
        if (detectorResult.status === 'fulfilled') detector = detectorResult.value;
        else { yoloReady = false; warnings.push(detectorResult.reason?.code || 'DETECTOR_UNAVAILABLE'); }
        if (denied(readImageMemoryPolicy(policyPath), query.relativePath, hash.sha256)) return;

        let fixedDescriptors = decoded ? fixedRegions(decoded) : [];
        let yoloDescriptors = detector ? selectYoloRegions(detector.detections, { width: detector.orientedWidth, height: detector.orientedHeight }, regionConfig) : [];
        let selectedDescriptors = [];
        if (regionMode === 'fixed') selectedDescriptors = fixedDescriptors.slice(0, regionConfig?.detectorMaxRegions || 5);
        else if (regionMode === 'yolo') selectedDescriptors = yoloDescriptors.slice(0, regionConfig?.detectorMaxRegions || 5);
        else if (regionMode === 'combined' && regionConfig) selectedDescriptors = selectOnlineRegions({ fixed: fixedDescriptors, yolo: yoloDescriptors }, regionConfig);
        if (detector) {
          regionDiagnostics.rawDetectionCount = (regionDiagnostics.rawDetectionCount || 0) + detector.rawDetectionCount;
          regionDiagnostics.acceptedDetectionCount = (regionDiagnostics.acceptedDetectionCount || 0) + yoloDescriptors.length;
        }
        regionDiagnostics.selectedRegionCount += selectedDescriptors.length;
        regionDiagnostics.selectedChannels.push(...selectedDescriptors.map(item => item.channel));
        let selectedVectors = [];
        if (selectedDescriptors.length) {
          try { selectedVectors = await beforeDeadline(regionFeatures(query.relativePath, selectedDescriptors, hash.sha256, 'query', visualDeadlineAt), visualDeadlineAt); }
          catch (error) {
            warnings.push(error.code || 'MODEL_UNAVAILABLE');
            if (selectedDescriptors.some(item => item.channel === 'fixed')) fixedReady = false;
            if (selectedDescriptors.some(item => item.channel === 'yolo')) yoloReady = false;
            selectedDescriptors = [];
          }
        }
        if (denied(readImageMemoryPolicy(policyPath), query.relativePath, hash.sha256)) return;
        const queryRegions = selectedDescriptors.map((item, index) => ({ ...item, embedding: selectedVectors[index] }));
        const byOccurrence = new Map();
        for (const row of rows) {
          const exact = row.sha256 === hash.sha256;
          let hammingDistance = null, wholeCosine = null;
          if (!exact && hash.phashUsable && row.phashUsable && row.phashVersion === hash.phashVersion) {
            hammingDistance = hammingDistanceHex(hash.phash, row.phash);
          }
          if (!exact && queryEmbedding && row.embedding) {
            wholeCosine = cosineSimilarityFloat32(queryEmbedding, row.embedding);
          }
          byOccurrence.set(row.occurrenceId, {
            imageId: row.id, queryIds: [query.queryId], relativePath: row.relativePath, sha256: row.sha256, occurrenceId: row.occurrenceId,
            sourceTs: row.sourceTs, sourceText: row.sourceText, exact, hammingDistance, wholeCosine,
            fixedCosine: null, yoloCosine: null, yoloClassAgreement: false,
            fixedQueryRegionId: null, fixedCandidateRegionId: null, fixedQueryRegionBbox: null, fixedCandidateRegionBbox: null,
            yoloQueryRegionId: null, yoloCandidateRegionId: null, yoloQueryRegionBbox: null, yoloCandidateRegionBbox: null,
            queryRegionId: null, candidateRegionId: null, queryRegionBbox: null, candidateRegionBbox: null,
            queryRelativePath: query.relativePath, querySha256: hash.sha256, embeddingVersion: row.embeddingVersion,
            regionMode, queryRegionCount: queryRegions.length,
          });
        }
        for (const channel of ['fixed', 'yolo']) {
          const queryChannel = queryRegions.filter(item => item.channel === channel);
          if (!queryChannel.length) continue;
          const featureVersion = channel === 'fixed' ? regionConfig.fixedFeatureVersion : regionConfig.yoloFeatureVersion;
          const regionRows = listSearchableRegions(db, {
            beforeTs: request.beforeTs, excludeOccurrenceIds: request.excludeOccurrenceIds,
            channel, featureVersion, embeddingVersion,
          });
          for (const historical of regionRows) {
            const candidate = byOccurrence.get(historical.occurrenceId);
            if (!candidate || candidate.exact || !historical.embedding) continue;
            for (const current of queryChannel) {
              const score = cosineSimilarityFloat32(current.embedding, historical.embedding);
              const field = channel === 'fixed' ? 'fixedCosine' : 'yoloCosine';
              if (!Number.isFinite(candidate[field]) || score > candidate[field]) {
                candidate[field] = score;
                candidate[`${channel}QueryRegionId`] = current.regionId;
                candidate[`${channel}CandidateRegionId`] = historical.regionId;
                candidate[`${channel}QueryRegionBbox`] = current.bbox;
                candidate[`${channel}CandidateRegionBbox`] = historical.bbox;
                if (channel === 'yolo') candidate.yoloClassAgreement = current.classId != null && current.classId === historical.classId;
              }
            }
          }
        }
        if (denied(readImageMemoryPolicy(policyPath), query.relativePath, hash.sha256)) return;
        for (const candidate of byOccurrence.values()) {
          const raw = admitVisualEvidence(candidate, {
            wholeVisualMinScore: -1,
            fixedVisualMinScore: -1,
            yoloVisualMinScore: -1,
          });
          if (!candidate.exact && !Number.isInteger(candidate.hammingDistance) && !Number.isFinite(raw.rawBestCosine)) continue;
          candidates.push({
            ...raw,
            queryEvidence: [{ ...raw, queryId: query.queryId, queryRelativePath: query.relativePath, querySha256: hash.sha256 }],
          });
        }
      } catch (error) {
        warnings.push(error.code || 'IMAGE_QUERY_FAILED');
      }
    }));
    const rankOptions = {
      beforeTs: request.beforeTs,
      excludeOccurrenceIds: request.excludeOccurrenceIds,
      maxHits: request.op === 'evaluate' ? request.topK || 10 : request.limits.maxHits,
      pHashMaxDistance: request.limits.pHashMaxDistance,
      visualMinScore: request.limits.visualMinScore,
      wholeVisualMinScore: request.limits.visualMinScore,
      fixedVisualMinScore: regionConfig?.regionVisualMinScore ?? request.limits.visualMinScore,
      yoloVisualMinScore: regionConfig?.regionVisualMinScore ?? request.limits.visualMinScore,
      allowEvaluationTopK: request.op === 'evaluate',
    };
    const validCandidates = [];
    const currentHashes = new Map();
    const currentQueryHashes = new Map();
    const currentHash = (cache, relativePath, expectedSha, stage = 'candidate-hash', hashDeadlineAt = deadlineAt) => {
      const key = `${relativePath}:${expectedSha}`;
      return () => {
        let pending = cache.get(key);
        if (!pending) {
          pending = Promise.resolve().then(() => auditImageRead(stage, relativePath))
            .then(() => resolveImageMemoryImage(relativePath, roots))
            .then(resolved => computeSha256(resolved.absolutePath));
          cache.set(key, pending);
        }
        return beforeDeadline(pending, hashDeadlineAt);
      };
    };
    const evaluationValidationAllowlist = request.op === 'evaluate' && Array.isArray(request.candidateValidationPaths)
      ? new Set(request.candidateValidationPaths)
      : null;
    const validationOrder = request.op === 'evaluate'
      ? (evaluationValidationAllowlist ? candidates.filter(candidate => evaluationValidationAllowlist.has(candidate.relativePath)) : candidates)
      : orderCandidatesForValidation(candidates, rankOptions);
    for (const match of validationOrder) {
      if (Date.now() >= deadlineAt - 5) { warnings.push('IMAGE_CANDIDATE_DEADLINE'); break; }
      try {
        const queryAllowed = await verifyImageAccessAfterHash({
          policyPath,
          relativePath: match.queryRelativePath,
          expectedSha: match.querySha256,
          hashCurrent: currentHash(currentQueryHashes, match.queryRelativePath, match.querySha256, 'query-hash'),
        });
        if (!queryAllowed) continue;
        await verifyImageAccessAfterHash({
          policyPath,
          relativePath: match.relativePath,
          expectedSha: match.sha256,
          hashCurrent: currentHash(currentHashes, match.relativePath, match.sha256),
          onAllowed: () => { validCandidates.push(match); return true; },
        });
      }
      catch (error) { warnings.push(error.code || 'IMAGE_CANDIDATE_INVALID'); }
    }
    let finalPolicy = filterImageMemoryMatchesByPolicy(policyPath, validCandidates);
    if (finalPolicy.warning) warnings.push(finalPolicy.warning);
    let ranked = rankImageCandidatesForThresholds(finalPolicy.matches, rankOptions)
      .map(match => {
        const sources = match.imageId ? listImageSources(db, match.imageId) : [];
        const context = sources.filter(source => source.sourceType === 'chat').flatMap(source => getChatWindow(db, {
          membershipId: source.membershipId, beforeTs: request.beforeTs,
        }));
        return { ...match, sources, context };
      });
    let unconfirmedCandidates = [];
    let unconfirmedCandidatePool = [];
    const rankAngleCandidates = (rows, options) => {
      try { return angleCandidateRanker(rows, options); }
      catch (error) { warnings.push(error?.code || 'IMAGE_ANGLE_FALLBACK_FAILED'); return []; }
    };
    if (request.op === 'recall' && request.limits.angleFallbackEnabled === true && ranked.length < request.limits.maxHits && Date.now() < deadlineAt - 5) {
      const remainingBeforeAngle = Math.max(0, deadlineAt - Date.now());
      const finalValidationReserveMs = Math.min(250, Math.max(75, Math.floor(remainingBeforeAngle * 0.15)));
      const angleDeadlineAt = Math.max(Date.now(), deadlineAt - finalValidationReserveMs);
      const anglePool = orderUnconfirmedCandidatesForValidation(candidates, {
        beforeTs: request.beforeTs,
        excludeOccurrenceIds: request.excludeOccurrenceIds,
        strictMatches: ranked,
      });
      const validAngleCandidates = [];
      for (const candidate of anglePool) {
        if (Date.now() >= angleDeadlineAt - 5) { warnings.push('IMAGE_ANGLE_FALLBACK_DEADLINE'); break; }
        try {
          const queryAllowed = await verifyImageAccessAfterHash({
            policyPath,
            relativePath: candidate.queryRelativePath,
            expectedSha: candidate.querySha256,
            hashCurrent: currentHash(currentQueryHashes, candidate.queryRelativePath, candidate.querySha256, 'query-hash', angleDeadlineAt),
          });
          if (!queryAllowed) continue;
          await verifyImageAccessAfterHash({
            policyPath,
            relativePath: candidate.relativePath,
            expectedSha: candidate.sha256,
            hashCurrent: currentHash(currentHashes, candidate.relativePath, candidate.sha256, 'candidate-hash', angleDeadlineAt),
            onAllowed: () => { validAngleCandidates.push(candidate); return true; },
          });
        } catch (error) { warnings.push(error.code || 'IMAGE_ANGLE_FALLBACK_INVALID'); }
      }
      const latestPolicy = readImageMemoryPolicy(policyPath);
      const anglePolicyFiltered = validAngleCandidates.flatMap(candidate => {
        if (denied(latestPolicy, candidate.relativePath, candidate.sha256)) return [];
        const evidence = (candidate.queryEvidence || []).filter(row => !denied(latestPolicy, row.queryRelativePath, row.querySha256));
        return evidence.length ? [{ ...candidate, queryEvidence: evidence }] : [];
      });
      unconfirmedCandidatePool = anglePolicyFiltered.map(candidate => {
        const sources = candidate.imageId ? listImageSources(db, candidate.imageId) : [];
        const context = sources.filter(source => source.sourceType === 'chat').flatMap(source => getChatWindow(db, {
          membershipId: source.membershipId, beforeTs: request.beforeTs,
        }));
        return { ...candidate, sources, context };
      });
      unconfirmedCandidates = rankAngleCandidates(anglePolicyFiltered, {
        beforeTs: request.beforeTs,
        excludeOccurrenceIds: request.excludeOccurrenceIds,
        strictMatches: ranked,
        maxHits: request.limits.maxHits,
      }).map(candidate => {
        const sources = candidate.imageId ? listImageSources(db, candidate.imageId) : [];
        const context = sources.filter(source => source.sourceType === 'chat').flatMap(source => getChatWindow(db, {
          membershipId: source.membershipId, beforeTs: request.beforeTs,
        }));
        return { ...candidate, sources, context };
      });
      const freshStrict = [];
      const freshStrictHashes = new Map();
      const freshStrictQueryHashes = new Map();
      for (const match of validCandidates) {
        if (Date.now() >= deadlineAt - 5) { warnings.push('IMAGE_FINAL_VALIDATION_DEADLINE'); break; }
        try {
          const queryAllowed = await verifyImageAccessAfterHash({
            policyPath,
            relativePath: match.queryRelativePath,
            expectedSha: match.querySha256,
            hashCurrent: currentHash(freshStrictQueryHashes, match.queryRelativePath, match.querySha256, 'final-query-hash', deadlineAt),
          });
          if (!queryAllowed) continue;
          await verifyImageAccessAfterHash({
            policyPath,
            relativePath: match.relativePath,
            expectedSha: match.sha256,
            hashCurrent: currentHash(freshStrictHashes, match.relativePath, match.sha256, 'final-candidate-hash', deadlineAt),
            onAllowed: () => { freshStrict.push(match); return true; },
          });
        } catch (error) { warnings.push(error.code || 'IMAGE_FINAL_VALIDATION_FAILED'); }
      }
      finalPolicy = filterImageMemoryMatchesByPolicy(policyPath, freshStrict);
      if (finalPolicy.warning) {
        warnings.push(finalPolicy.warning);
        ranked = [];
        unconfirmedCandidates = [];
        unconfirmedCandidatePool = [];
      } else {
        ranked = rankImageCandidatesForThresholds(finalPolicy.matches, rankOptions).map(match => {
          const sources = match.imageId ? listImageSources(db, match.imageId) : [];
          const context = sources.filter(source => source.sourceType === 'chat').flatMap(source => getChatWindow(db, {
            membershipId: source.membershipId, beforeTs: request.beforeTs,
          }));
          return { ...match, sources, context };
        });
        unconfirmedCandidates = rankAngleCandidates(anglePolicyFiltered, {
          beforeTs: request.beforeTs,
          excludeOccurrenceIds: request.excludeOccurrenceIds,
          strictMatches: ranked,
          maxHits: request.limits.maxHits,
        }).map(candidate => {
          const sources = candidate.imageId ? listImageSources(db, candidate.imageId) : [];
          const context = sources.filter(source => source.sourceType === 'chat').flatMap(source => getChatWindow(db, {
            membershipId: source.membershipId, beforeTs: request.beforeTs,
          }));
          return { ...candidate, sources, context };
        });
      }
    }
    return {
      matches: ranked,
      ...(request.op === 'recall' && request.limits.angleFallbackEnabled === true ? { unconfirmedCandidates, unconfirmedCandidatePool } : {}),
      ...(request.op === 'evaluate' ? {
        candidates: evaluationValidationAllowlist ? filterImageMemoryMatchesByPolicy(policyPath, candidates).matches : finalPolicy.matches,
        ...(evaluationValidationAllowlist ? { validatedCandidates: finalPolicy.matches } : {}),
      } : {}),
      warnings: [...new Set(warnings)],
      channels: {
        hash: hashReady ? 'ready' : 'unavailable', visual: visualReady ? 'ready' : 'unavailable',
        fixed: regionConfig ? (fixedReady ? 'ready' : 'unavailable') : 'disabled',
        yolo: regionConfig ? (yoloEnabled() ? (yoloReady ? 'ready' : 'unavailable') : 'disabled') : 'disabled',
      },
      ...(request.op === 'evaluate' ? { regionDiagnostics: { ...regionDiagnostics, selectedChannels: regionDiagnostics.selectedChannels.slice(0, 5 * request.queries.length) } } : {}),
    };
  }

  async function reconcile() {
    if (imageMemoryPolicyStatus(policyPath).paused) return { removed: 0, paused: true };
    const policy = readImageMemoryPolicy(policyPath);
    const rows = db.prepare('SELECT ip.relative_path,ip.image_id AS id,i.sha256 FROM image_paths ip JOIN images i ON i.id=ip.image_id').all();
    let removed = 0;
    const removedImages = new Set();
    for (const row of rows) {
      if (policy.shas?.[row.sha256] != null) {
        if (!removedImages.has(row.id)) { removed += removeImage(db, row.id); removedImages.add(row.id); }
        continue;
      }
      let removePath = policy.paths?.[row.relative_path] != null;
      if (!removePath) {
        try {
          const resolved = await resolveImageMemoryImage(row.relative_path, roots);
          removePath = await computeSha256(resolved.absolutePath) !== row.sha256;
        } catch { removePath = true; }
      }
      if (removePath) removed += Number(db.prepare('DELETE FROM image_paths WHERE relative_path=?').run(row.relative_path).changes);
    }
    removed += Number(db.prepare('DELETE FROM images WHERE id NOT IN (SELECT image_id FROM image_paths)').run().changes);
    return { removed, paused: false };
  }

  async function revokeSources(relativePaths) {
    const paths = [...new Set(relativePaths || [])];
    const placeholders = paths.map(() => '?').join(',');
    const rows = paths.length ? db.prepare(`SELECT ip.relative_path,i.sha256 FROM image_paths ip JOIN images i ON i.id=ip.image_id WHERE ip.relative_path IN (${placeholders})`).all(...paths) : [];
    const knownShas = [...new Set(rows.map(row => row.sha256))];
    const shaPlaceholders = knownShas.map(() => '?').join(',');
    const sameShaPaths = knownShas.length ? db.prepare(`SELECT ip.relative_path FROM image_paths ip JOIN images i ON i.id=ip.image_id WHERE i.sha256 IN (${shaPlaceholders})`).all(...knownShas).map(row => row.relative_path) : [];
    const policy = await revokeImageMemoryAsync({ policyPath, relativePaths: [...new Set([...paths, ...sameShaPaths])], knownShas, revokedAt: Date.now() });
    let removed = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const path of policy.revokedPaths) removed += Number(db.prepare('DELETE FROM images WHERE relative_path = ?').run(path).changes);
      for (const sha of policy.revokedShas) removed += Number(db.prepare('DELETE FROM images WHERE sha256 = ?').run(sha).changes);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return { ...policy, removed };
  }

  function beginSourceSnapshot(request) {
    if (sourceSnapshots.has(request.snapshotId)) throw workerError('source snapshot already exists', 'IMAGE_SOURCE_SNAPSHOT_EXISTS');
    const current = getSourceGeneration(db, request.sourceType);
    const baseGeneration = request.baseGeneration;
    const baseRevision = request.baseRevision;
    if (current.generation !== baseGeneration || current.revision !== baseRevision) throw workerError('source snapshot generation changed', 'IMAGE_SOURCE_SNAPSHOT_STALE');
    sourceSnapshots.set(request.snapshotId, { ...request, baseGeneration, baseRevision, memberships: [], messages: [], createdAt: Date.now() });
    return { snapshotId: request.snapshotId, ...current };
  }

  function appendSourceSnapshot(request) {
    const snapshot = sourceSnapshots.get(request.snapshotId);
    if (!snapshot) throw workerError('source snapshot is missing', 'IMAGE_SOURCE_SNAPSHOT_MISSING');
    if (snapshot.memberships.length + request.memberships.length > 10000 || snapshot.messages.length + request.messages.length > 10000) throw workerError('source snapshot is too large', 'IMAGE_SOURCE_SNAPSHOT_LIMIT');
    for (const row of request.memberships) if (row.sourceType !== snapshot.sourceType) throw workerError('source snapshot type does not match membership', 'PROTOCOL_INVALID_REQUEST');
    snapshot.memberships.push(...request.memberships);
    snapshot.messages.push(...request.messages);
    return { memberships: snapshot.memberships.length, messages: snapshot.messages.length };
  }

  async function commitSourceSnapshot(request) {
    const snapshot = sourceSnapshots.get(request.snapshotId);
    if (!snapshot) throw workerError('source snapshot is missing', 'IMAGE_SOURCE_SNAPSHOT_MISSING');
    try {
      const verified = [];
      const featureWork = new Map();
      for (const row of snapshot.memberships) {
        if (Date.now() - snapshot.createdAt > 60000) throw workerError('source snapshot expired', 'IMAGE_SOURCE_SNAPSHOT_EXPIRED');
        if (imageMemoryPolicyStatus(policyPath).paused) throw workerError('image memory policy has pending denials', 'IMAGE_MEMORY_POLICY_PENDING');
        const hash = await hashFeatures(row.relativePath);
        if (denied(readImageMemoryPolicy(policyPath), row.relativePath, hash.sha256)) continue;
        let image = db.prepare('SELECT id FROM images WHERE sha256=? ORDER BY id LIMIT 1').get(hash.sha256);
        let imageId;
        if (image) {
          imageId = Number(image.id);
          upsertImagePath(db, { relativePath: row.relativePath, imageId, fileMtimeMs: hash.resolved.stat.mtimeMs, fileSize: hash.resolved.stat.size, verifiedAt: Date.now() });
        } else {
          imageId = upsertImageHash(db, { relativePath: row.relativePath, sha256: hash.sha256, phash: hash.phash, phashVersion: hash.phashVersion, phashUsable: hash.phashUsable, fileMtimeMs: hash.resolved.stat.mtimeMs, fileSize: hash.resolved.stat.size, indexedAt: Date.now() });
        }
        verified.push({ ...row, imageId });
        if (!featureWork.has(imageId)) featureWork.set(imageId, { source: row, hash, imageId });
      }
      if (imageMemoryPolicyStatus(policyPath).paused) throw workerError('image memory policy has pending denials', 'IMAGE_MEMORY_POLICY_PENDING');
      const result = replaceSourceSnapshot(db, {
        sourceType: snapshot.sourceType, baseGeneration: snapshot.baseGeneration, baseRevision: snapshot.baseRevision,
        revision: snapshot.revision, complete: snapshot.mode === 'complete', memberships: verified, messages: snapshot.messages,
      });
      let pendingEmbedding = 0;
      let pendingRegions = 0;
      for (const { source, hash, imageId } of featureWork.values()) {
        const image = db.prepare('SELECT embedding,embedding_version FROM images WHERE id=?').get(imageId);
        if (embeddingVersion && (!image?.embedding || image.embedding_version !== embeddingVersion)) {
          pendingEmbedding++;
          if (visualAvailable()) scheduleEmbedding(source, hash);
        }
        if (regionConfig) {
          const missing = missingRegionCount(imageId);
          pendingRegions += missing;
          if (missing && regionsAvailable()) scheduleRegions(source, hash, imageId);
        }
      }
      return { ...result, memberships: verified.length, messages: snapshot.messages.length, pendingEmbedding, ...(regionConfig ? { pendingRegions } : {}) };
    } finally { sourceSnapshots.delete(request.snapshotId); }
  }

  function removeSourceMemberships(request) {
    if (!request.membershipIds.length) return { removed: 0 };
    const placeholders = request.membershipIds.map(() => '?').join(',');
    return { removed: Number(db.prepare(`DELETE FROM source_memberships WHERE membership_id IN (${placeholders})`).run(...request.membershipIds).changes) };
  }

  function workerStats() {
    const base = {
      ...getStats(db), sourceSnapshots: listSourceGenerations(db),
      embedding: { configured: !!embeddingClient, ready: embeddingClient?.ready === true, queued: Number(embeddingClient?.queued || 0) },
    };
    if (!regionConfig) return base;
    const region = getRegionStats(db);
    const images = db.prepare('SELECT id FROM images').all();
    const pendingRegions = images.reduce((sum, row) => sum + missingRegionCount(Number(row.id)), 0);
    const detectorStats = detectorClient?.stats?.() || null;
    return {
      ...base, ...region, pendingRegions,
      detector: {
        configured: !!detectorClient,
        ready: detectorClient?.ready === true,
        queued: Number(detectorStats?.queued || 0),
        cooldownUntil: Number(detectorStats?.cooldownUntil || 0),
        lastErrorCode: detectorStats?.lastErrorCode ? String(detectorStats.lastErrorCode) : null,
        lastExitCode: Number.isInteger(detectorStats?.lastExitCode) ? detectorStats.lastExitCode : null,
        lastExitSignal: detectorStats?.lastExitSignal ? String(detectorStats.lastExitSignal) : null,
        lastStderrCategory: detectorStats?.lastStderrCategory ? String(detectorStats.lastStderrCategory) : null,
        lastSpawnErrorCode: detectorStats?.lastSpawnErrorCode ? String(detectorStats.lastSpawnErrorCode) : null,
        lastFatalErrorCode: detectorStats?.lastFatalErrorCode ? String(detectorStats.lastFatalErrorCode) : null,
      },
    };
  }

  return {
    logicalDigest() { return getLogicalImageStoreDigest(db); },
    async handle(request) {
      if (readOnly && ['index', 'backfill', 'revoke', 'reconcile', 'source_sync_begin', 'source_sync_batch', 'source_sync_commit', 'source_sync_abort', 'source_remove'].includes(request.op)) throw workerError('operation is unavailable in read-only mode', 'IMAGE_STORE_READ_ONLY');
      if (request.op === 'index' || request.op === 'backfill') return indexSources(request.sources || []);
      if (request.op === 'revoke') return revokeSources(request.relativePaths || []);
      if (request.op === 'recall' || request.op === 'evaluate') return recall({ ...request, applyThresholds: request.op === 'recall' ? true : request.applyThresholds });
      if (request.op === 'reconcile') return reconcile();
      if (request.op === 'source_sync_begin') return beginSourceSnapshot(request);
      if (request.op === 'source_sync_batch') return appendSourceSnapshot(request);
      if (request.op === 'source_sync_commit') return commitSourceSnapshot(request);
      if (request.op === 'source_sync_abort') return { aborted: sourceSnapshots.delete(request.snapshotId) };
      if (request.op === 'source_remove') return removeSourceMemberships(request);
      if (request.op === 'stats') return workerStats();
      if (request.op === 'shutdown') return { shuttingDown: true };
      throw workerError('unknown worker operation', 'PROTOCOL_UNKNOWN_OP');
    },
    async close() {
      closing = true;
      try { await embeddingClient?.close?.(); } catch {}
      try { await detectorClient?.close?.(); } catch {}
      await Promise.allSettled([...backgroundEmbeddings.values()]);
      await Promise.allSettled([...backgroundRegions.values()]);
      if (readSnapshot) try { db.exec('ROLLBACK'); } catch {}
      try { db.close(); } catch {}
    },
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[String(argv[index]).replace(/^--/, '')] = argv[index + 1];
  return result;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  let manifest = null;
  if (args.manifest && existsSync(args.manifest)) {
    try { manifest = JSON.parse(readFileSync(args.manifest, 'utf8')); } catch {}
  }
  const embeddingVersion = manifest?.revision && manifest?.embeddingVersion ? manifest.embeddingVersion : null;
  const embeddingClient = embeddingVersion && args['embedding-worker'] ? createEmbeddingProcessClient({
    workerPath: args['embedding-worker'], inboxDir: args.inbox, lifePhotosDir: args['life-photos'], galleryDir: args.gallery, manifestPath: args.manifest,
    cacheDir: args.cache, cwd: dirname(args['embedding-worker']), embeddingVersion,
  }) : null;
  const regionsEnabled = args['regions-enabled'] === '1';
  let detectorClient = null;
  if (regionsEnabled && args['detector-manifest'] && args['detector-worker'] && existsSync(args['detector-manifest'])) {
    try {
      const detectorManifest = JSON.parse(readFileSync(args['detector-manifest'], 'utf8'));
      verifyDetectorManifest(detectorManifest, { runtimeDir: dirname(args['detector-manifest']), verifyFiles: true });
      detectorClient = createDetectorProcessClient({
        command: detectorManifest.pythonPath,
        workerPath: args['detector-worker'],
        inboxDir: args.inbox,
        lifePhotosDir: args['life-photos'],
        galleryDir: args.gallery,
        weightPath: detectorManifest.weightPath,
        detectorVersion: REGION_V1.detectorVersion,
        runtimeDir: dirname(args['detector-manifest']),
        cwd: dirname(args['detector-worker']),
        detectorTimeoutMs: REGION_V1.detectorTimeoutMs,
        backgroundTimeoutMs: REGION_V1.detectorBackgroundTimeoutMs,
      });
    } catch {}
  }
  const worker = createImageMemoryWorker({
    inboxDir: args.inbox, lifePhotosDir: args['life-photos'], galleryDir: args.gallery,
    dbPath: args.db, policyPath: args.policy, embeddingVersion, embeddingClient,
    regionConfig: regionsEnabled ? REGION_V1 : null, detectorClient,
  });
  let chain = Promise.resolve();
  const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const parser = createRequestParser({
    onRequest(request) {
      const receivedAt = Date.now();
      chain = chain.then(async () => {
        try {
          const result = await worker.handle({ ...request, receivedAt });
          write({ id: request.id, ok: true, result });
          if (request.op === 'shutdown') {
            await worker.close();
            process.stdin.pause();
            setImmediate(() => process.exit(0));
          }
        } catch (error) { write({ id: request.id, ok: false, error: publicError(error) }); }
      });
    },
    onError: write,
  });
  process.stdin.on('data', chunk => parser.push(chunk));
  process.stdin.on('end', () => parser.end());
  process.on('exit', () => { void worker.close(); });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli().catch(error => {
  process.stderr.write(`[image-memory-worker] ${String(error?.code || 'START_FAILED')}\n`);
  process.exitCode = 1;
});
