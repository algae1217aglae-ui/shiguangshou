import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { formatImageRecallContext, rankUnconfirmedAngleCandidates, refreshImageMatchQueryEvidence, selectImageMemorySources } from './image-memory-core.mjs';
import { formatImageRecallData, selectChatContextWindow } from './image-memory-context.mjs';
import { readAlbumImageSourceSnapshot, readChatHistoryContextEntries, readChatHistoryToken, readLifeImageSourceSnapshot, verifyChatHistoryLocator } from './image-memory-sources.mjs';
import { normalizeImageMemoryPath, resolveImageMemoryImage } from './tools/image-memory/source-paths.mjs';
import { computeSha256 } from './tools/image-memory/phash.mjs';
import { memoryEntryAllowsContext } from './memory-recall.mjs';
import {
  filterImageMemoryMatchesByPolicy,
  imageMemoryPolicyStatus,
  readImageMemoryPolicy,
  recoverPendingImageMemoryPolicy,
  revokeImageMemoryAsync,
} from './image-memory-policy.mjs';

const emptyRecall = { matches: [], warnings: [], channels: { hash: 'unavailable', visual: 'unavailable' }, skippedQueryCount: 0 };

export function imageMemoryPrivacyFields(payload, item) {
  return payload?.memorySafe === false || item?.memorySafe === false ? { memorySafe: false } : {};
}

export async function prepareImageRecallBatch({
  entries, batchId, baseTs, deadlineAt = Date.now() + 2500, client, policyPath = null,
  angleFallbackEnabled = false, supportsImageAttachments = false,
  resolveSource = async source => source,
  shaForSource = null,
}) {
  const selected = selectImageMemorySources(entries, { batchId, beforeTs: baseTs });
  const denied = new Set(selected.denied);
  if (denied.size) {
    for (const entry of entries) {
      const paths = Array.isArray(entry?.images) ? entry.images.map(value => String(value).replace(/^\/+/, '').replaceAll('\\', '/')) : [];
      if (paths.some(path => denied.has(path))) entry.memorySafe = false;
    }
    if (policyPath) {
      const shas = [];
      if (shaForSource) {
        for (const relativePath of denied) {
          try {
            const sha = await withinDeadline(() => shaForSource({ relativePath }), deadlineAt);
            if (sha) shas.push(sha);
          } catch {}
        }
      }
      await revokeImageMemoryAsync({ policyPath, relativePaths: [...denied], knownShas: shas, revokedAt: Date.now() });
    }
  }

  const issues = [];
  const sources = [];
  for (const source of selected.allowed) {
    if (denied.has(source.relativePath)) continue;
    try {
      await withinDeadline(() => resolveSource(source), deadlineAt);
      sources.push(source);
    } catch (error) { issues.push({ code: String(error?.code || 'IMAGE_SOURCE_INVALID') }); }
  }
  const queries = sources.map(({ queryId, occurrenceId, relativePath }) => ({ queryId, occurrenceId, relativePath }));
  const excludeOccurrenceIds = sources.map(source => source.occurrenceId);
  const recallPromise = queries.length
    ? Promise.resolve(client.recallBatch({ queries, beforeTs: baseTs, excludeOccurrenceIds, deadlineAt, angleFallbackEnabled: angleFallbackEnabled === true && supportsImageAttachments === true })).catch(() => emptyRecall)
    : Promise.resolve(emptyRecall);
  return { sources, denied: [...denied], issues, recallPromise, excludeOccurrenceIds };
}

export function assembleImageRecallPrompts({ basePromptText, imageRecallContext }) {
  const promptText = imageRecallContext ? `${basePromptText}\n${imageRecallContext}` : basePromptText;
  return { promptText, plainPromptText: basePromptText };
}

function safeContextValue(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replaceAll(']]]', '］］］').slice(0, 240);
}

export function formatUnconfirmedAngleContext(candidates, { maxHits = 3, maxDataChars = 1800 } = {}) {
  const rows = (Array.isArray(candidates) ? candidates : []).slice(0, Math.max(0, Math.min(3, maxHits)));
  if (!rows.length) return '';
  const lines = [
    '【未確認的不同角度相似候補】',
    '以下舊圖只是 whole 與 production fixed 前列交集後送來給你看原圖，尚未確認是同一物件。請把本輪 query 原圖與候補原圖實際比較；背景、日期、舊文字與局部高分都不能單獨證明同物件。無法確認就明說無法確認，不要寫成以前看過，也不要據此自動寫入長期記憶。',
  ];
  for (const candidate of rows) {
    for (const evidence of candidate.queryEvidence || []) {
      const fixed = evidence.fixed || {};
      const yolo = evidence.yoloDiagnostic;
      lines.push(`- candidateType=unconfirmed_angle confidence=unconfirmed queryId=${safeContextValue(evidence.queryId)} queryPath=${safeContextValue(evidence.queryRelativePath)} candidatePath=${safeContextValue(candidate.relativePath)} wholeRank=${Number(evidence.whole?.rank) || 0} wholeScore=${Number(evidence.whole?.score)} fixedRank=${Number(fixed.rank) || 0} fixedScore=${Number(fixed.score)} fixedQueryRegion=${safeContextValue(fixed.queryRegionId)} fixedQueryBbox=${safeContextValue(JSON.stringify(fixed.queryRegionBbox ?? null))} fixedCandidateRegion=${safeContextValue(fixed.candidateRegionId)} fixedCandidateBbox=${safeContextValue(JSON.stringify(fixed.candidateRegionBbox ?? null))}`);
      if (yolo) lines.push(`  YOLO diagnosticOnly=true rank=${Number(yolo.rank) || 0} score=${Number(yolo.score)} classAgreement=${yolo.classAgreement === true}`);
    }
  }
  const evidenceContext = [...lines.join('\n')].slice(0, 2400).join('');
  const sourceContext = formatImageRecallData(rows, { maxChars: Math.min(1800, maxDataChars), unconfirmed: true });
  return [evidenceContext, sourceContext].filter(Boolean).join('\n');
}

export function assembleImageRecallBridgeDelivery({ supportsImageAttachments = false, angleFallbackEnabled = false, photoPaths = [], liveRecall = {} } = {}) {
  const supportsCandidates = angleFallbackEnabled === true && supportsImageAttachments === true;
  const images = [...new Set([...(photoPaths || []), ...(supportsCandidates ? liveRecall.recalledImagePaths || [] : [])])];
  return {
    images,
    context: supportsCandidates ? String(liveRecall.context || '') : String(liveRecall.strictContext || ''),
  };
}

export function imageRecallPromptsForCurrentPolicy({ basePromptText, promptSuffix = '', recallResult, policyPath }) {
  const current = filterImageMemoryMatchesByPolicy(policyPath, recallResult?.matches || []);
  const imageRecallContext = imageRecallContextFromResult({ matches: current.matches });
  const prompts = assembleImageRecallPrompts({ basePromptText, imageRecallContext });
  return {
    promptText: prompts.promptText + promptSuffix,
    plainPromptText: prompts.plainPromptText + promptSuffix,
    matches: current.matches,
    warning: current.warning,
  };
}

function deadlineError() { return Object.assign(new Error('image recall deadline expired'), { code: 'IMAGE_RECALL_DEADLINE' }); }

async function withinDeadline(value, deadlineAt) {
  const remaining = deadlineAt - Date.now();
  if (!(remaining > 0)) throw deadlineError();
  const pending = Promise.resolve().then(value);
  pending.catch(() => {});
  let timer;
  try {
    return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(deadlineError()), remaining); })]);
  } finally { clearTimeout(timer); }
}

function snapshotMap(snapshot) {
  return snapshot?.status === 'complete' ? new Map(snapshot.memberships.map(row => [row.membershipId, row])) : new Map();
}

function readStateView(statePath) {
  try {
    const bytes = readFileSync(statePath);
    const state = JSON.parse(bytes.toString('utf8'));
    const messages = new Map((Array.isArray(state?.log) ? state.log : []).flatMap(entry => {
      const id = String(entry?.messageId || '').trim();
      return id ? [[id, entry]] : [];
    }));
    const log = Array.isArray(state?.log) ? state.log : [];
    return { messages, log, token: createHash('sha256').update(bytes).digest('hex'), readable: true };
  } catch { return { messages: new Map(), log: [], token: null, readable: false }; }
}

function defaultLiveViews({ lifePath, albumsPath, historyPath, statePath }) {
  const life = readLifeImageSourceSnapshot(lifePath);
  const album = readAlbumImageSourceSnapshot(albumsPath);
  const state = readStateView(statePath);
  return {
    life, album, stateMessages: state.messages, stateLog: state.log, stateReadable: state.readable,
    tokens: {
      life: life.status === 'complete' ? life.revision : null,
      album: album.status === 'complete' ? album.revision : null,
      chat: readChatHistoryToken(historyPath), state: state.token,
    },
  };
}

function liveChatEntry(source, views, historyPath) {
  const locator = source?.locator;
  if (views.stateReadable === false) return null;
  if (locator?.kind === 'history') {
    const archived = verifyChatHistoryLocator(historyPath, locator);
    if (!archived) return null;
    const exactId = String(locator.messageId || '').trim();
    if (exactId && views.stateMessages.has(exactId)) {
      const live = views.stateMessages.get(exactId);
      return memoryEntryAllowsContext(live) ? live : null;
    }
    return archived;
  }
  if (locator?.kind === 'state' && locator.confidence === 'exact') {
    const entry = views.stateMessages.get(locator.messageId);
    return memoryEntryAllowsContext(entry) ? entry : null;
  }
  return null;
}

function liveChatSource(source, views, historyPath) {
  const entry = liveChatEntry(source, views, historyPath);
  if (!entry) return null;
  const imageIndex = Number(/:image:(\d+)$/.exec(String(source.membershipId || ''))?.[1]);
  const images = Array.isArray(entry.images) ? entry.images : [];
  let livePath;
  try { livePath = normalizeImageMemoryPath(String(images[imageIndex] || '').replace(/^\/+/, '')); }
  catch { return null; }
  if (!Number.isInteger(imageIndex) || livePath !== source.relativePath) return null;
  const sourceTs = new Date(entry.ts).getTime();
  if (!Number.isFinite(sourceTs)) return null;
  const text = [...String(entry.text || '')];
  return {
    ...source, sourceTs, sourceText: text.slice(0, 160).join(''),
    author: entry.role === 'user' ? 'user' : 'assistant',
    metadata: { ...(source.metadata || {}), sourceTextLength: text.length },
  };
}

function liveSource(source, views, historyPath) {
  if (source?.sourceType === 'life') return snapshotMap(views.life).get(source.membershipId) || null;
  if (source?.sourceType === 'album') return snapshotMap(views.album).get(source.membershipId) || null;
  if (source?.sourceType === 'chat') return liveChatSource(source, views, historyPath);
  return null;
}

function liveContextRow(entry, { locator, orderKey, fallbackMessageId = '', fallbackConversationId = '' } = {}) {
  const messageId = String(entry?.messageId || '').trim() || fallbackMessageId;
  const conversationId = String(entry?.conversationId || '').trim() || fallbackConversationId;
  const sourceTs = new Date(entry?.ts).getTime();
  const allowed = !!entry && memoryEntryAllowsContext(entry) && Number.isFinite(sourceTs);
  const text = allowed ? [...String(entry.text || '')] : [];
  return {
    messageId, conversationId, orderKey, sourceTs: Number.isFinite(sourceTs) ? sourceTs : 0,
    author: entry?.role === 'user' ? 'user' : 'assistant',
    text: allowed ? text.slice(0, 240).join('') : '', hidden: !allowed, memorySafe: allowed,
    locator: { ...locator, ...(allowed ? { textLength: text.length } : {}) },
  };
}

function liveContext(rows, views, historyPath, beforeTs) {
  const photo = (rows || []).find(row => row.contextKind === 'photo');
  if (!photo || views.stateReadable === false) return [];
  const locator = photo.locator;
  let current = [];
  if (locator?.kind === 'state' && locator.confidence === 'exact') {
    current = (views.stateLog || []).map((entry, ordinal) => liveContextRow(entry, {
      locator: { kind: 'state', confidence: String(entry?.messageId || '').trim() ? 'exact' : 'none', messageId: String(entry?.messageId || '').trim(), ordinal },
      orderKey: `1:${String(ordinal).padStart(16, '0')}:${String(ordinal).padStart(12, '0')}`,
    }));
  } else if (locator?.kind === 'history') {
    current = readChatHistoryContextEntries(historyPath, locator).map(row => {
      const archived = row.entry;
      const exactId = String(archived?.messageId || '').trim();
      const entry = exactId && views.stateMessages.has(exactId) ? views.stateMessages.get(exactId) : archived;
      return liveContextRow(entry, {
        locator: { kind: 'history', confidence: exactId ? 'exact' : 'legacy-window', generation: locator.generation, byteStart: row.byteStart, ordinal: row.ordinal, messageId: exactId, segmentSignature: row.segmentSignature },
        orderKey: `0:${String(row.byteStart).padStart(16, '0')}:${String(row.ordinal).padStart(12, '0')}`,
        fallbackMessageId: row.byteStart === locator.byteStart ? photo.messageId : `live-history:${row.byteStart}`,
        fallbackConversationId: photo.conversationId,
      });
    });
  }
  return selectChatContextWindow(current, { photoMessageId: photo.messageId, beforeTs });
}

function liveContextsForSources(sources, views, historyPath, beforeTs) {
  const output = [];
  const seen = new Set();
  for (const source of sources || []) {
    if (source.sourceType !== 'chat') continue;
    const anchorKey = `${source.sourceId}:${JSON.stringify(source.locator || null)}`;
    if (seen.has(anchorKey)) continue;
    seen.add(anchorKey);
    output.push(...liveContext([{
      messageId: source.sourceId,
      conversationId: source.conversationId,
      locator: source.locator,
      contextKind: 'photo',
    }], views, historyPath, beforeTs));
  }
  return output;
}

function sameTokens(left, right) {
  return ['life', 'album', 'chat', 'state'].every(key => left?.[key] === right?.[key]);
}

export async function revalidateImageRecallForBridge({
  recallResult, beforeTs, deadlineAt, roots, policyPath, historyPath, statePath, lifePath, albumsPath,
  excludeOccurrenceIds = [], angleFallbackEnabled = false, maxHits = recallResult?.maxHits ?? 3,
  loadLiveViews = defaultLiveViews, hashAsset, resolveAssetPath,
} = {}) {
  const hitLimit = Number.isInteger(maxHits) ? Math.max(1, Math.min(3, maxHits)) : 3;
  const empty = warning => ({ matches: [], unconfirmedCandidates: [], recalledImagePaths: [], strictContext: '', angleContext: '', context: '', warning, maxHits: hitLimit });
  if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) return empty('IMAGE_RECALL_DEADLINE');
  const excluded = new Set(excludeOccurrenceIds.map(String));
  const warnings = [];
  const noteWarning = code => { if (code) warnings.push(String(code)); };
  const readActivePolicy = () => {
    const status = imageMemoryPolicyStatus(policyPath);
    if (status.paused) throw Object.assign(new Error('image memory policy is paused'), { code: status.code || 'IMAGE_MEMORY_POLICY_PENDING' });
    return readImageMemoryPolicy(policyPath);
  };
  const normalizedPolicyAsset = (relativePath, sha256) => {
    try {
      const path = normalizeImageMemoryPath(relativePath);
      const sha = String(sha256 || '').trim().toLowerCase();
      return /^[0-9a-f]{64}$/.test(sha) ? { path, sha } : null;
    } catch { return null; }
  };
  const assetAllowedByPolicy = (relativePath, sha256) => {
    const policy = readActivePolicy();
    const asset = normalizedPolicyAsset(relativePath, sha256);
    return !!asset && policy.paths?.[asset.path] == null && policy.shas?.[asset.sha] == null;
  };
  const shaAllowedByPolicy = sha256 => {
    const policy = readActivePolicy();
    const sha = String(sha256 || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(sha) && policy.shas?.[sha] == null;
  };
  const hash = hashAsset || (async relativePath => {
    const resolved = await resolveImageMemoryImage(relativePath, roots);
    return computeSha256(resolved.absolutePath);
  });
  const resolvePath = resolveAssetPath || (async relativePath => (await resolveImageMemoryImage(relativePath, roots)).absolutePath);
  const startedRemainingMs = Math.max(0, deadlineAt - Date.now());
  const finalReserveMs = Math.min(300, Math.max(100, Math.ceil(startedRemainingMs * 0.2)));
  const candidateDeadlineAt = Math.max(Date.now(), deadlineAt - finalReserveMs);
  const stabilityReserveMs = Math.min(50, Math.max(20, Math.floor(finalReserveMs / 3)));
  const candidateFinalDeadlineAt = Math.max(Date.now(), deadlineAt - stabilityReserveMs);

  const currentShaReader = deadline => {
    const hashes = new Map();
    return relativePath => {
      let pending = hashes.get(relativePath);
      if (!pending) { pending = withinDeadline(() => hash(relativePath), deadline); hashes.set(relativePath, pending); }
      return pending;
    };
  };

  const validateStrict = async (rows, views, limitAt) => {
    readActivePolicy();
    const currentSha = currentShaReader(limitAt);
    const matches = [];
    for (const original of rows || []) {
      if (Date.now() >= limitAt) throw deadlineError();
      if (!shaAllowedByPolicy(original?.sha256)) continue;
      let match = refreshImageMatchQueryEvidence(original, evidence => assetAllowedByPolicy(evidence?.queryRelativePath, evidence?.querySha256));
      if (!match) continue;
      if (Array.isArray(match.queryEvidence)) {
        const allowedEvidence = [];
        for (const evidence of match.queryEvidence) {
          if (!assetAllowedByPolicy(evidence.queryRelativePath, evidence.querySha256)) continue;
          let actualSha;
          try {
            actualSha = await currentSha(evidence.queryRelativePath);
          } catch (error) {
            if (error?.code === 'IMAGE_RECALL_DEADLINE') throw error;
            noteWarning(error?.code || 'IMAGE_STRICT_QUERY_INVALID');
            continue;
          }
          if (actualSha === evidence.querySha256 && assetAllowedByPolicy(evidence.queryRelativePath, evidence.querySha256)) allowedEvidence.push(evidence);
        }
        match = refreshImageMatchQueryEvidence(match, evidence => allowedEvidence.includes(evidence));
        if (!match) continue;
      }
      const sources = [];
      for (const source of match.sources || []) {
        const live = liveSource(source, views, historyPath);
        if (!live || excluded.has(live.membershipId) || !(Number(live.sourceTs) < beforeTs)) continue;
        if (!assetAllowedByPolicy(live.relativePath, match.sha256)) continue;
        let actualSha;
        try {
          actualSha = await currentSha(live.relativePath);
        } catch (error) {
          if (error?.code === 'IMAGE_RECALL_DEADLINE') throw error;
          noteWarning(error?.code || 'IMAGE_STRICT_SOURCE_INVALID');
          continue;
        }
        if (actualSha !== match.sha256 || !assetAllowedByPolicy(live.relativePath, match.sha256)) continue;
        sources.push({ ...live, live: true });
      }
      if (!sources.length) continue;
      matches.push({
        ...match,
        relativePath: sources[0].relativePath,
        sources,
        context: liveContextsForSources(sources, views, historyPath, beforeTs),
      });
      if (matches.length >= hitLimit) break;
    }
    return { matches, warning: null };
  };

  const refreshStructuredAngleCandidate = (candidate, queryEvidence) => {
    if (!queryEvidence.length) return null;
    const weakest = queryEvidence.map(evidence => Math.min(Number(evidence.whole?.score), Number(evidence.fixed?.score)));
    const means = queryEvidence.map(evidence => (Number(evidence.whole?.score) + Number(evidence.fixed?.score)) / 2);
    return {
      ...candidate,
      queryEvidence,
      queryIds: [...new Set(queryEvidence.map(evidence => String(evidence.queryId)))],
      ranking: {
        weakestViewScore: Math.min(...weakest),
        meanViewScore: Math.min(...means),
      },
    };
  };

  const validateCandidates = async (rows, views, limitAt, { rawPool = false } = {}) => {
    const currentSha = currentShaReader(limitAt);
    const validated = [];
    for (const original of rows || []) {
        if (Date.now() >= limitAt) { noteWarning('IMAGE_ANGLE_FALLBACK_DEADLINE'); break; }
        if (!rawPool && (original?.candidateType !== 'unconfirmed_angle' || original?.confidence !== 'unconfirmed')) continue;
        if (!shaAllowedByPolicy(original.sha256)) continue;
        const queryEvidence = [];
        for (const evidence of original.queryEvidence || []) {
          if (!assetAllowedByPolicy(evidence.queryRelativePath, evidence.querySha256)) continue;
          let actualSha;
          try {
            actualSha = await currentSha(evidence.queryRelativePath);
          } catch (error) { noteWarning(error?.code === 'IMAGE_RECALL_DEADLINE' ? 'IMAGE_ANGLE_FALLBACK_DEADLINE' : (error?.code || 'IMAGE_ANGLE_QUERY_INVALID')); }
          if (actualSha === evidence.querySha256 && assetAllowedByPolicy(evidence.queryRelativePath, evidence.querySha256)) queryEvidence.push(evidence);
        }
        if (!queryEvidence.length) continue;
        const sources = [];
        for (const source of original.sources || []) {
          const live = liveSource(source, views, historyPath);
          if (!live || excluded.has(live.membershipId) || !(Number(live.sourceTs) < beforeTs)) continue;
          if (!assetAllowedByPolicy(live.relativePath, original.sha256)) continue;
          let actualSha;
          try {
            actualSha = await currentSha(live.relativePath);
          } catch (error) { noteWarning(error?.code === 'IMAGE_RECALL_DEADLINE' ? 'IMAGE_ANGLE_FALLBACK_DEADLINE' : (error?.code || 'IMAGE_ANGLE_CANDIDATE_INVALID')); continue; }
          if (actualSha !== original.sha256 || !assetAllowedByPolicy(live.relativePath, original.sha256)) continue;
          sources.push({ ...live, live: true });
        }
        if (!sources.length) continue;
        const refreshed = rawPool ? {
          ...original,
          relativePath: sources[0].relativePath,
          sources,
          context: liveContextsForSources(sources, views, historyPath, beforeTs),
          queryEvidence,
          queryIds: [...new Set(queryEvidence.map(evidence => String(evidence.queryId)))],
        } : refreshStructuredAngleCandidate({
          ...original,
          relativePath: sources[0].relativePath,
          sources,
          context: liveContextsForSources(sources, views, historyPath, beforeTs),
        }, queryEvidence);
        if (refreshed) validated.push(refreshed);
    }
    return validated;
  };

  try {
    let provisionalStrict = [];
    let provisionalCandidates = [];
    if (Date.now() < candidateDeadlineAt) {
      try {
        const initialViews = await withinDeadline(() => loadLiveViews({ lifePath, albumsPath, historyPath, statePath }), candidateDeadlineAt);
        provisionalStrict = (await validateStrict(recallResult?.matches || [], initialViews, candidateDeadlineAt)).matches;
        if (angleFallbackEnabled === true && provisionalStrict.length < hitLimit && Date.now() < candidateDeadlineAt) {
          const rawPool = Array.isArray(recallResult?.unconfirmedCandidatePool) ? recallResult.unconfirmedCandidatePool : null;
          const candidateInput = rawPool || recallResult?.unconfirmedCandidates || [];
          const validatedPool = await validateCandidates(candidateInput, initialViews, candidateDeadlineAt, { rawPool: !!rawPool });
          if (rawPool) {
            const ranked = rankUnconfirmedAngleCandidates(validatedPool, {
              beforeTs, excludeOccurrenceIds, strictMatches: provisionalStrict, maxHits: hitLimit,
            });
            provisionalCandidates = ranked.map(candidate => {
              const live = validatedPool.find(row => row.occurrenceId === candidate.occurrenceId && row.sha256 === candidate.sha256)
                || validatedPool.find(row => row.sha256 === candidate.sha256);
              return { ...candidate, sources: live?.sources || [], context: live?.context || [] };
            });
          } else {
            provisionalCandidates = validatedPool.slice(0, Math.max(0, hitLimit - provisionalStrict.length));
          }
        }
      } catch (error) {
        noteWarning(error?.code === 'IMAGE_RECALL_DEADLINE' ? 'IMAGE_ANGLE_FALLBACK_DEADLINE' : (error?.code || 'IMAGE_RECALL_REVALIDATION_FAILED'));
      }
    }

    const attachmentPaths = new Map();
    const attachmentKey = row => `${String(row?.sha256 || '')}${String.fromCharCode(0)}${String(row?.occurrenceId || row?.relativePath || '')}`;
    if (angleFallbackEnabled === true) {
      const seen = new Set();
      for (const row of [...provisionalStrict, ...provisionalCandidates]) {
        if (Date.now() >= candidateDeadlineAt) { noteWarning('IMAGE_ANGLE_ATTACHMENT_DEADLINE'); break; }
        const key = String(row.sha256 || row.relativePath || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        try { attachmentPaths.set(attachmentKey(row), await withinDeadline(() => resolvePath(row.relativePath), candidateDeadlineAt)); }
        catch (error) { noteWarning(error?.code === 'IMAGE_RECALL_DEADLINE' ? 'IMAGE_ANGLE_ATTACHMENT_DEADLINE' : (error?.code || 'IMAGE_ANGLE_ATTACHMENT_UNAVAILABLE')); }
        if (attachmentPaths.size >= hitLimit) break;
      }
    }

    let stableResult = null;
    let views = await withinDeadline(() => loadLiveViews({ lifePath, albumsPath, historyPath, statePath }), deadlineAt);
    for (let pass = 0; pass < 2; pass++) {
      const policyRevision = readImageMemoryPolicy(policyPath).revision;
      const strictResult = await validateStrict(recallResult?.matches || [], views, deadlineAt);
      if (strictResult.warning) return empty(strictResult.warning);
      const remainingSlots = Math.max(0, hitLimit - strictResult.matches.length);
      const candidatesWithAttachments = provisionalCandidates.filter(candidate => attachmentPaths.has(attachmentKey(candidate)));
      const finalCandidates = angleFallbackEnabled === true && remainingSlots && Date.now() < candidateFinalDeadlineAt
        ? (await validateCandidates(candidatesWithAttachments, views, candidateFinalDeadlineAt)).slice(0, remainingSlots)
        : [];
      const confirmedViews = await withinDeadline(() => loadLiveViews({ lifePath, albumsPath, historyPath, statePath }), deadlineAt);
      const confirmedPolicyRevision = readImageMemoryPolicy(policyPath).revision;
      if (policyRevision === confirmedPolicyRevision && sameTokens(views.tokens, confirmedViews.tokens)) {
        stableResult = { matches: strictResult.matches, unconfirmedCandidates: finalCandidates };
        break;
      }
      views = confirmedViews;
    }
    if (!stableResult) return empty('IMAGE_RECALL_SOURCE_CHANGED');

    const finalAttachmentPaths = new Map();
    const finalAttachmentKey = row => `${attachmentKey(row)}${String.fromCharCode(0)}${String(row?.relativePath || '')}`;
    if (angleFallbackEnabled === true) {
      for (const row of [...stableResult.matches, ...stableResult.unconfirmedCandidates]) {
        if (Date.now() >= candidateFinalDeadlineAt) { noteWarning('IMAGE_ANGLE_ATTACHMENT_DEADLINE'); break; }
        try {
          const firstResolved = await withinDeadline(() => resolvePath(row.relativePath), candidateFinalDeadlineAt);
          const resolvedSha = await withinDeadline(() => hash(row.relativePath), candidateFinalDeadlineAt);
          const confirmedResolved = await withinDeadline(() => resolvePath(row.relativePath), candidateFinalDeadlineAt);
          if (resolvedSha !== row.sha256) throw Object.assign(new Error('image attachment changed'), { code: 'IMAGE_ANGLE_ATTACHMENT_SHA_CHANGED' });
          if (String(firstResolved) !== String(confirmedResolved)) throw Object.assign(new Error('image attachment path changed'), { code: 'IMAGE_ANGLE_ATTACHMENT_PATH_CHANGED' });
          finalAttachmentPaths.set(finalAttachmentKey(row), confirmedResolved);
        } catch (error) {
          noteWarning(error?.code === 'IMAGE_RECALL_DEADLINE' ? 'IMAGE_ANGLE_ATTACHMENT_DEADLINE' : (error?.code || 'IMAGE_ANGLE_ATTACHMENT_UNAVAILABLE'));
        }
      }

      const finalViews = await withinDeadline(() => loadLiveViews({ lifePath, albumsPath, historyPath, statePath }), deadlineAt);
      const finalPolicyRevision = readImageMemoryPolicy(policyPath).revision;
      const finalStrict = await validateStrict(recallResult?.matches || [], finalViews, deadlineAt);
      if (finalStrict.warning) return empty(finalStrict.warning);
      const remainingSlots = Math.max(0, hitLimit - finalStrict.matches.length);
      const reboundCandidates = stableResult.unconfirmedCandidates.filter(candidate => finalAttachmentPaths.has(finalAttachmentKey(candidate)));
      const finalCandidates = remainingSlots && Date.now() < candidateFinalDeadlineAt
        ? (await validateCandidates(reboundCandidates, finalViews, candidateFinalDeadlineAt))
          .filter(candidate => finalAttachmentPaths.has(finalAttachmentKey(candidate)))
          .slice(0, remainingSlots)
        : [];
      const confirmedFinalViews = await withinDeadline(() => loadLiveViews({ lifePath, albumsPath, historyPath, statePath }), deadlineAt);
      const confirmedFinalPolicyRevision = readImageMemoryPolicy(policyPath).revision;
      if (finalPolicyRevision !== confirmedFinalPolicyRevision || !sameTokens(finalViews.tokens, confirmedFinalViews.tokens)) return empty('IMAGE_RECALL_SOURCE_CHANGED');
      stableResult = { matches: finalStrict.matches, unconfirmedCandidates: finalCandidates };
    }

    const strictContext = stableResult.matches.length ? formatImageRecallData(stableResult.matches) : '';
    const angleContext = formatUnconfirmedAngleContext(stableResult.unconfirmedCandidates, {
      maxHits: Math.max(0, hitLimit - stableResult.matches.length),
      maxDataChars: Math.max(0, 1800 - [...strictContext].length),
    });
    const context = [strictContext, angleContext].filter(Boolean).join('\n');
    const recalledImagePaths = [];
    if (angleFallbackEnabled === true) {
      const seen = new Set();
      for (const row of [...stableResult.matches, ...stableResult.unconfirmedCandidates]) {
        const path = finalAttachmentPaths.get(finalAttachmentKey(row));
        const key = String(row.sha256 || row.relativePath || '');
        if (!path || !key || seen.has(key)) continue;
        seen.add(key);
        recalledImagePaths.push(path);
        if (recalledImagePaths.length >= hitLimit) break;
      }
    }
    return { ...stableResult, recalledImagePaths, strictContext, angleContext, context, warning: warnings[0] || null, warnings: [...new Set(warnings)], maxHits: hitLimit };
  } catch (error) {
    return empty(String(error?.code || 'IMAGE_RECALL_REVALIDATION_FAILED'));
  }
}

export async function prepareImageRecallBridgeDispatch({
  supportsImageAttachments = false,
  angleFallbackEnabled = false,
  maxHits = 3,
  photoPaths = [],
  revalidation = {},
} = {}) {
  const liveRecall = await revalidateImageRecallForBridge({
    ...revalidation,
    angleFallbackEnabled: angleFallbackEnabled && supportsImageAttachments,
    maxHits,
  });
  const delivery = assembleImageRecallBridgeDelivery({
    supportsImageAttachments,
    angleFallbackEnabled,
    photoPaths,
    liveRecall,
  });
  return { ...delivery, liveRecall };
}

export function imageRecallContextFromResult(result, options) {
  return formatImageRecallContext(result?.matches || [], options);
}

export function persistChatEntriesAfterAsyncWork({ loadState, saveState, appendEntries, entries, prepareState, finishState }) {
  const fresh = loadState();
  prepareState?.(fresh);
  appendEntries(fresh, entries);
  finishState?.(fresh);
  saveState(fresh);
  return fresh;
}

export async function handleImageMemoryChatRoute({
  entries,
  batchId,
  baseTs,
  deadlineAt = Date.now() + 2500,
  angleFallbackEnabled = false,
  supportsImageAttachments = false,
  client,
  policyPath = null,
  resolveSource = async source => source,
  shaForSource = null,
  loadState,
  saveState,
  appendEntries,
  prepareState,
  finishState,
  onIssue = () => {},
}) {
  let prepared = { sources: [], denied: [], issues: [], recallPromise: Promise.resolve(emptyRecall), excludeOccurrenceIds: [] };
  if (entries.some(entry => entry?.images?.length)) {
    if (policyPath && imageMemoryPolicyStatus(policyPath).paused) {
      try { await recoverPendingImageMemoryPolicy(policyPath); }
      catch (error) { onIssue({ stage: 'recovery', code: String(error?.code || 'IMAGE_MEMORY_POLICY_RECOVERY_FAILED') }); }
    }
    try {
      prepared = await prepareImageRecallBatch({ entries, batchId, baseTs, deadlineAt, angleFallbackEnabled, supportsImageAttachments, client, policyPath, resolveSource, shaForSource });
      for (const issue of prepared.issues) onIssue({ stage: 'source', ...issue });
      if (prepared.denied.length && typeof client?.revoke === 'function') {
        try { await client.revoke(prepared.denied); }
        catch (error) { onIssue({ stage: 'revoke', code: String(error?.code || 'IMAGE_REVOKE_FAILED') }); }
      }
    } catch (error) {
      onIssue({ stage: 'prepare', code: String(error?.code || 'IMAGE_PREPARE_FAILED') });
    }
  }
  const state = persistChatEntriesAfterAsyncWork({ loadState, saveState, appendEntries, entries, prepareState, finishState });
  let finished = null;

  function finishRecall() {
    if (finished) return finished;
    finished = (async () => {
      let recallResult = emptyRecall;
      try { recallResult = await prepared.recallPromise; }
      catch (error) { onIssue({ stage: 'recall', code: String(error?.code || 'IMAGE_RECALL_FAILED') }); }
      const indexing = prepared.sources.length && typeof client?.indexBatch === 'function'
        ? Promise.resolve(client.indexBatch(prepared.sources)).catch(error => {
          onIssue({ stage: 'index', code: String(error?.code || 'IMAGE_INDEX_FAILED') });
          return null;
        })
        : Promise.resolve(null);
      return { recallResult, indexing };
    })();
    return finished;
  }

  return { state, entries, denied: prepared.denied, sources: prepared.sources, issues: prepared.issues, excludeOccurrenceIds: prepared.excludeOccurrenceIds, finishRecall };
}
