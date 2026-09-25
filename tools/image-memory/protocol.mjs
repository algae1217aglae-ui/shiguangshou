export const MAX_PROTOCOL_LINE_BYTES = 1024 * 1024;

const OPS = new Set(['recall', 'index', 'backfill', 'revoke', 'reconcile', 'evaluate', 'stats', 'shutdown',
  'source_sync_begin', 'source_sync_batch', 'source_sync_commit', 'source_sync_abort', 'source_remove']);

function protocolError(code, message, id = null) {
  const error = Object.assign(new Error(message), { code, requestId: id });
  return error;
}

function finiteNumber(value, field, { minimum = 0 } = {}) {
  if (!Number.isFinite(value) || value < minimum) throw protocolError('PROTOCOL_INVALID_REQUEST', `${field} must be a finite number`);
  return value;
}

function boundedArray(value, field) {
  if (!Array.isArray(value)) throw protocolError('PROTOCOL_INVALID_REQUEST', `${field} must be an array`);
  if (value.length > 32) throw protocolError('PROTOCOL_INVALID_REQUEST', `${field} cannot contain more than 32 entries`);
  return value;
}

function relativePath(value) {
  const path = String(value || '').trim().replaceAll('\\', '/').replace(/^\/+/, '');
  const match = /^(inbox|life-photos|gallery)\/[^/:]+$/i.exec(path);
  if (!match || path.includes('..')) throw protocolError('PROTOCOL_INVALID_REQUEST', 'relativePath must name one file directly under inbox, life-photos, or gallery');
  return `${match[1].toLowerCase()}/${path.slice(path.indexOf('/') + 1)}`;
}

function sourceType(value) {
  const type = String(value || '');
  if (!['chat', 'life', 'album'].includes(type)) throw protocolError('PROTOCOL_INVALID_REQUEST', 'sourceType must be chat, life, or album');
  return type;
}

function requiredString(value, field, max = 240) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw protocolError('PROTOCOL_INVALID_REQUEST', `${field} is invalid`);
  return text;
}

function sourceMembership(value) {
  if (!value || typeof value !== 'object') throw protocolError('PROTOCOL_INVALID_REQUEST', 'membership must be an object');
  return {
    membershipId: requiredString(value.membershipId, 'membershipId'), sourceType: sourceType(value.sourceType),
    sourceId: requiredString(value.sourceId, 'sourceId'), relativePath: relativePath(value.relativePath),
    sourceTs: finiteNumber(value.sourceTs, 'sourceTs'), sourceText: [...String(value.sourceText || '')].slice(0, 160).join(''),
    author: value.author == null ? null : (['user', 'resident'].includes(value.author) ? value.author : (() => { throw protocolError('PROTOCOL_INVALID_REQUEST', 'author is invalid'); })()),
    conversationId: value.conversationId == null ? null : String(value.conversationId), sourceRevision: requiredString(value.sourceRevision, 'sourceRevision'),
    locator: value.locator && typeof value.locator === 'object' ? value.locator : null,
    metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : {},
  };
}

function chatMessage(value) {
  if (!value || typeof value !== 'object') throw protocolError('PROTOCOL_INVALID_REQUEST', 'message must be an object');
  return {
    messageId: requiredString(value.messageId, 'messageId'), conversationId: requiredString(value.conversationId, 'conversationId'),
    orderKey: requiredString(value.orderKey, 'orderKey'), sourceTs: finiteNumber(value.sourceTs, 'sourceTs'),
    author: ['user', 'resident'].includes(value.author) ? value.author : (() => { throw protocolError('PROTOCOL_INVALID_REQUEST', 'author is invalid'); })(),
    text: [...String(value.text || '')].slice(0, 240).join(''), hidden: value.hidden === true, memorySafe: value.memorySafe !== false,
    sourceRevision: requiredString(value.sourceRevision, 'sourceRevision'), locator: value.locator && typeof value.locator === 'object' ? value.locator : null,
  };
}

function query(value) {
  if (!value || typeof value !== 'object') throw protocolError('PROTOCOL_INVALID_REQUEST', 'query must be an object');
  const queryId = String(value.queryId || '').trim();
  const occurrenceId = String(value.occurrenceId || '').trim();
  if (!queryId || !occurrenceId) throw protocolError('PROTOCOL_INVALID_REQUEST', 'queryId and occurrenceId are required');
  return { queryId, occurrenceId, relativePath: relativePath(value.relativePath) };
}

function source(value) {
  if (!value || typeof value !== 'object') throw protocolError('PROTOCOL_INVALID_REQUEST', 'source must be an object');
  const occurrenceId = String(value.occurrenceId || '').trim();
  if (!occurrenceId) throw protocolError('PROTOCOL_INVALID_REQUEST', 'occurrenceId is required');
  return {
    occurrenceId,
    queryId: value.queryId == null ? null : String(value.queryId),
    relativePath: relativePath(value.relativePath),
    sourceTs: finiteNumber(value.sourceTs, 'sourceTs'),
    sourceText: [...String(value.sourceText || '')].slice(0, 160).join(''),
  };
}

function limits(value = {}) {
  const maxHits = value.maxHits ?? 3;
  const pHashMaxDistance = value.pHashMaxDistance ?? 8;
  const visualMinScore = value.visualMinScore ?? 0.88;
  const angleFallbackEnabled = value.angleFallbackEnabled ?? false;
  if (!Number.isInteger(maxHits) || maxHits < 1 || maxHits > 3) throw protocolError('PROTOCOL_INVALID_REQUEST', 'maxHits must be an integer from 1 to 3');
  if (!Number.isInteger(pHashMaxDistance) || pHashMaxDistance < 0 || pHashMaxDistance > 63) throw protocolError('PROTOCOL_INVALID_REQUEST', 'pHashMaxDistance must be an integer from 0 to 63');
  if (!Number.isFinite(visualMinScore) || visualMinScore < 0 || visualMinScore > 1) throw protocolError('PROTOCOL_INVALID_REQUEST', 'visualMinScore must be between 0 and 1');
  if (typeof angleFallbackEnabled !== 'boolean') throw protocolError('PROTOCOL_INVALID_REQUEST', 'angleFallbackEnabled must be a boolean');
  return { maxHits, pHashMaxDistance, visualMinScore, angleFallbackEnabled };
}

export function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw protocolError('PROTOCOL_INVALID_REQUEST', 'request must be an object');
  const id = typeof input.id === 'string' || typeof input.id === 'number' ? input.id : null;
  if (id == null || String(id).length === 0) throw protocolError('PROTOCOL_ID_REQUIRED', 'request id is required', null);
  if (!OPS.has(input.op)) throw protocolError('PROTOCOL_UNKNOWN_OP', `unknown operation: ${String(input.op || '')}`, id);
  const request = { id, op: input.op };
  if (['recall', 'evaluate'].includes(input.op)) {
    request.queries = boundedArray(input.queries, 'queries').map(query);
    request.beforeTs = finiteNumber(input.beforeTs, 'beforeTs');
    request.excludeOccurrenceIds = boundedArray(input.excludeOccurrenceIds || [], 'excludeOccurrenceIds').map(value => String(value));
    request.deadlineMs = finiteNumber(input.deadlineMs, 'deadlineMs', { minimum: 1 });
    if (input.deadlineAt != null) request.deadlineAt = finiteNumber(input.deadlineAt, 'deadlineAt', { minimum: 1 });
    request.limits = limits(input.limits);
    if (input.op === 'evaluate') {
      request.topK = input.topK ?? 10;
      if (!Number.isInteger(request.topK) || request.topK < 1 || request.topK > 100) throw protocolError('PROTOCOL_INVALID_REQUEST', 'topK must be an integer from 1 to 100', id);
      request.applyThresholds = input.applyThresholds === true;
      request.regionMode = input.regionMode == null ? 'combined' : String(input.regionMode);
      if (!['whole', 'fixed', 'yolo', 'combined'].includes(request.regionMode)) throw protocolError('PROTOCOL_INVALID_REQUEST', 'regionMode must be whole, fixed, yolo, or combined', id);
      if (input.candidateValidationPaths != null) request.candidateValidationPaths = boundedArray(input.candidateValidationPaths, 'candidateValidationPaths').map(relativePath);
    }
    else if (input.candidateValidationPaths != null) throw protocolError('PROTOCOL_INVALID_REQUEST', 'candidateValidationPaths is available only for evaluate', id);
  } else if (['index', 'backfill'].includes(input.op)) {
    request.sources = boundedArray(input.sources, 'sources').map(source);
    request.deadlineMs = finiteNumber(input.deadlineMs, 'deadlineMs', { minimum: 1 });
  } else if (input.op === 'revoke') {
    request.relativePaths = boundedArray(input.relativePaths, 'relativePaths').map(relativePath);
  } else if (input.op === 'reconcile') {
    request.deadlineMs = finiteNumber(input.deadlineMs, 'deadlineMs', { minimum: 1 });
  } else if (input.op === 'source_sync_begin') {
    request.snapshotId = requiredString(input.snapshotId, 'snapshotId');
    request.sourceType = sourceType(input.sourceType);
    request.revision = requiredString(input.revision, 'revision');
    request.baseGeneration = finiteNumber(input.baseGeneration, 'baseGeneration');
    request.baseRevision = input.baseRevision == null ? null : String(input.baseRevision);
    request.mode = input.mode === 'delta' ? 'delta' : input.mode === 'complete' ? 'complete' : (() => { throw protocolError('PROTOCOL_INVALID_REQUEST', 'mode must be complete or delta'); })();
  } else if (input.op === 'source_sync_batch') {
    request.snapshotId = requiredString(input.snapshotId, 'snapshotId');
    request.memberships = boundedArray(input.memberships || [], 'memberships').map(sourceMembership);
    if (!Array.isArray(input.messages || []) || (input.messages || []).length > 64) throw protocolError('PROTOCOL_INVALID_REQUEST', 'messages cannot contain more than 64 entries');
    request.messages = (input.messages || []).map(chatMessage);
  } else if (['source_sync_commit', 'source_sync_abort'].includes(input.op)) {
    request.snapshotId = requiredString(input.snapshotId, 'snapshotId');
  } else if (input.op === 'source_remove') {
    if (!Array.isArray(input.membershipIds) || input.membershipIds.length > 64) throw protocolError('PROTOCOL_INVALID_REQUEST', 'membershipIds cannot contain more than 64 entries');
    request.membershipIds = input.membershipIds.map(value => requiredString(value, 'membershipId'));
  }
  return request;
}

function errorResponse(error, id = error?.requestId ?? null) {
  return {
    id,
    ok: false,
    error: {
      code: String(error?.code || 'PROTOCOL_INVALID_REQUEST'),
      message: String(error?.message || 'invalid request').slice(0, 240),
      retryable: false,
    },
  };
}

export function createRequestParser({ onRequest, onError, maxBytes = MAX_PROTOCOL_LINE_BYTES }) {
  let buffer = Buffer.alloc(0);
  let discarding = false;
  const failLarge = () => onError(errorResponse(protocolError('PROTOCOL_LINE_TOO_LARGE', 'protocol line exceeds one MiB')));
  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (discarding) {
        const newline = incoming.indexOf(10);
        if (newline < 0) return;
        discarding = false;
        return this.push(incoming.subarray(newline + 1));
      }
      buffer = Buffer.concat([buffer, incoming]);
      while (true) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length > maxBytes) {
          failLarge();
          continue;
        }
        if (!line.length) continue;
        let parsed;
        try {
          parsed = JSON.parse(line.toString('utf8'));
          onRequest(validateRequest(parsed));
        } catch (error) {
          const id = parsed && (typeof parsed.id === 'string' || typeof parsed.id === 'number') ? parsed.id : null;
          onError(errorResponse(error, error?.requestId ?? id));
        }
      }
      if (buffer.length > maxBytes) {
        buffer = Buffer.alloc(0);
        discarding = true;
        failLarge();
      }
    },
    end() {
      if (buffer.length) onError(errorResponse(protocolError('PROTOCOL_INCOMPLETE_LINE', 'protocol stream ended before newline')));
      buffer = Buffer.alloc(0);
      discarding = false;
    },
  };
}
