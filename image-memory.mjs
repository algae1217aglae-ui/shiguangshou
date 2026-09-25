import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

import { selectImageMemorySources } from './image-memory-core.mjs';
import { imageMemoryPolicyStatus, readImageMemoryPolicy } from './image-memory-policy.mjs';
import { resolveInboxImage } from './tools/image-memory/image-input.mjs';

const emptyRecall = (hash = 'unavailable', skippedQueryCount = 0) => ({ matches: [], warnings: [], channels: { hash, visual: 'unavailable' }, skippedQueryCount });
const emptyCounts = (regionsEnabled = false) => ({ indexed: 0, unchanged: 0, pendingEmbedding: 0, ...(regionsEnabled ? { pendingRegions: 0 } : {}), failed: 0, codes: [] });

function clientError(code, message, retryable = true) {
  return Object.assign(new Error(message), { code, retryable });
}

function cleanIssue(error, stage) {
  return { code: String(error?.code || 'IMAGE_MEMORY_CLIENT_FAILED'), stage, retryable: error?.retryable !== false };
}

export async function collectImageMemoryEntries({ historyPath, statePath, inboxDir, policyPath, historyStart = 0, stateAfterTs = null }) {
  const records = [];
  const issues = [];
  let historyBytes = 0;
  let latestSourceTs = 0;
  const entryTimestamp = entry => {
    const raw = entry?.ts;
    const value = typeof raw === 'number' ? raw : Date.parse(String(raw || ''));
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  if (historyPath) {
    try {
      const options = { encoding: 'utf8' };
      if (Number.isInteger(historyStart) && historyStart > 0) options.start = historyStart;
      const lines = createInterface({ input: createReadStream(historyPath, options), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const ts = entryTimestamp(entry);
          if (ts != null) latestSourceTs = Math.max(latestSourceTs, ts);
          records.push({ entry, priority: 0 });
        }
        catch { issues.push({ code: 'HISTORY_BAD_JSON' }); }
      }
      historyBytes = (await stat(historyPath)).size;
    } catch (error) {
      if (error?.code !== 'ENOENT') issues.push({ code: 'HISTORY_READ_FAILED' });
    }
  }
  if (statePath) {
    try {
      const state = JSON.parse(await readFile(statePath, 'utf8'));
      for (const entry of (Array.isArray(state.log) ? state.log : [])) {
        const ts = entryTimestamp(entry);
        if (ts != null) latestSourceTs = Math.max(latestSourceTs, ts);
        if (stateAfterTs != null && (ts == null || ts <= stateAfterTs)) continue;
        records.push({ entry, priority: 1 });
      }
    } catch (error) {
      issues.push({ code: error instanceof SyntaxError ? 'STATE_BAD_JSON' : 'STATE_READ_FAILED' });
    }
  }

  const policyStatus = imageMemoryPolicyStatus(policyPath);
  if (policyStatus.paused) {
    issues.push({ code: policyStatus.code });
    return { sources: [], denied: [], issues, cursor: { historyBytes, latestSourceTs } };
  }
  let policy;
  try { policy = readImageMemoryPolicy(policyPath); }
  catch (error) {
    issues.push({ code: error.code || 'IMAGE_MEMORY_POLICY_INVALID' });
    return { sources: [], denied: [], issues, cursor: { historyBytes, latestSourceTs } };
  }
  const denied = new Set(Object.keys(policy.paths || {}));
  const candidates = new Map();
  for (let index = 0; index < records.length; index++) {
    const { entry, priority } = records[index];
    const selected = selectImageMemorySources([entry], { batchId: `history-${index}`, beforeTs: Infinity });
    for (const path of selected.denied) denied.add(path);
    for (const source of selected.allowed) {
      try {
        await resolveInboxImage(source.relativePath, inboxDir);
      } catch (error) {
        issues.push({ code: error.code || 'IMAGE_PATH_INVALID' });
        continue;
      }
      if (policy.paths?.[source.relativePath] != null) {
        denied.add(source.relativePath);
        continue;
      }
      const prior = candidates.get(source.occurrenceId);
      if (!prior || priority >= prior.priority) candidates.set(source.occurrenceId, { ...source, priority });
    }
  }
  for (const path of denied) {
    for (const [id, source] of candidates) if (source.relativePath === path) candidates.delete(id);
  }
  const sources = [...candidates.values()]
    .map(({ priority, ...source }) => source)
    .sort((left, right) => left.sourceTs - right.sourceTs || left.occurrenceId.localeCompare(right.occurrenceId));
  return { sources, denied: [...denied].sort(), issues, cursor: { historyBytes, latestSourceTs } };
}

export function createImageMemoryClient(options = {}) {
  const enabled = options.enabled === true;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 2500;
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 60000;
  const terminationWarningMs = Number.isFinite(options.terminationWarningMs) ? Math.max(1, options.terminationWarningMs) : 2000;
  const closeGraceMs = Number.isFinite(options.closeGraceMs) ? Math.max(1, options.closeGraceMs) : 2000;
  const maxHits = Number.isInteger(options.maxHits) && options.maxHits >= 1 && options.maxHits <= 3 ? options.maxHits : 3;
  const pHashMaxDistance = Number.isInteger(options.pHashMaxDistance) && options.pHashMaxDistance >= 0 && options.pHashMaxDistance <= 63 ? options.pHashMaxDistance : 8;
  const visualMinScore = Number.isFinite(options.visualMinScore) && options.visualMinScore >= 0 && options.visualMinScore <= 1 ? options.visualMinScore : 0.88;
  const angleFallbackEnabled = options.angleFallbackEnabled === true;
  const regionsEnabled = options.regionsEnabled === true;
  let child = null;
  let sequence = 0;
  let circuitUntil = 0;
  let closing = false;
  let generation = 0;
  const pending = new Map();
  const terminationTasks = new Set();
  const processGenerations = new WeakMap();
  const retiringGenerations = new Map();
  const protocolErrorsByGeneration = new Map();
  const timeoutsByGeneration = new Map();
  const inputFailuresByGeneration = new Set();
  const mutatingOps = new Set([
    'index', 'backfill', 'reconcile', 'revoke',
    'source_sync_begin', 'source_sync_batch', 'source_sync_commit', 'source_sync_abort', 'source_remove',
  ]);

  function defaultTerminateTree(processRef) {
    if (!processRef || processRef.killed) return Promise.resolve();
    if (process.platform === 'win32' && processRef.pid) {
      try {
        return new Promise(resolveExit => {
          const killer = spawn('taskkill', ['/pid', String(processRef.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => { try { processRef.kill('SIGKILL'); } catch {} resolveExit(); });
          killer.once('exit', code => { if (code !== 0) { try { processRef.kill('SIGKILL'); } catch {} } resolveExit(); });
        });
      } catch {}
    }
    try { processRef.kill('SIGKILL'); } catch {}
    return Promise.resolve();
  }
  const terminateTree = typeof options.terminateProcess === 'function' ? options.terminateProcess : defaultTerminateTree;

  function trackTermination(processRef, { requireExit = false, stage = 'termination' } = {}) {
    if (!processRef) return Promise.resolve();
    const exited = processRef.exitCode != null
      ? Promise.resolve()
      : new Promise(resolveExit => processRef.once('exit', resolveExit));
    const task = (async () => {
      try { await terminateTree(processRef); }
      catch { issue(clientError('IMAGE_WORKER_TERMINATION_FAILED', 'image worker termination command failed'), stage); }
      if (requireExit) {
        if (processRef.exitCode != null) return;
        let warningTimer = setTimeout(() => {
          issue(clientError('IMAGE_WORKER_TERMINATION_UNCONFIRMED', 'image worker termination is not yet confirmed'), stage);
        }, terminationWarningMs);
        try { await exited; } finally { clearTimeout(warningTimer); warningTimer = null; }
        return;
      }
      let timer;
      await Promise.race([exited, new Promise(resolveWait => { timer = setTimeout(resolveWait, 2000); })]);
      clearTimeout(timer);
    })();
    terminationTasks.add(task);
    task.finally(() => terminationTasks.delete(task));
    return task;
  }

  const issue = (error, stage) => {
    try { options.onIssue?.(cleanIssue(error, stage)); } catch {}
  };

  function safeFor(op, skipped = 0, hash = 'unavailable', attempted = 0, code = null) {
    if (op === 'recall') return emptyRecall(hash, skipped);
    if (op === 'index' || op === 'backfill') return { ...emptyCounts(regionsEnabled), failed: attempted, codes: code ? [code] : [] };
    if (op === 'reconcile') return { removed: 0, paused: true, unavailable: true };
    if (op === 'stats') return { images: 0, occurrences: 0, pendingEmbedding: 0 };
    return { shuttingDown: true };
  }

  function settleGeneration(error, targetGeneration, { circuit = false, predicate = () => true } = {}) {
    for (const [id, item] of pending) {
      if (item.generation !== targetGeneration || !predicate(item)) continue;
      clearTimeout(item.timer);
      pending.delete(id);
      if (item.safe) item.resolve(safeFor(item.op, item.skipped, item.fallbackHash || (circuit ? 'unavailable' : 'timeout'), item.attempted, error.code));
      else item.reject(error);
    }
  }

  function retireGeneration(processRef, targetGeneration, error, stage) {
    if (targetGeneration == null) return Promise.resolve();
    const existing = retiringGenerations.get(targetGeneration);
    if (existing) return existing;
    circuitUntil = Date.now() + cooldownMs;
    if (child === processRef && processGenerations.get(processRef) === targetGeneration) {
      child = null;
      generation++;
    }
    settleGeneration(error, targetGeneration, { circuit: true, predicate: item => !item.mutating });
    const hasMutating = [...pending.values()].some(item => item.generation === targetGeneration && item.mutating);
    const retirement = (async () => {
      await trackTermination(processRef, { requireExit: hasMutating, stage });
      settleGeneration(error, targetGeneration, { circuit: true });
    })();
    retiringGenerations.set(targetGeneration, retirement);
    retirement.finally(() => {
      retiringGenerations.delete(targetGeneration);
      protocolErrorsByGeneration.delete(targetGeneration);
      timeoutsByGeneration.delete(targetGeneration);
      inputFailuresByGeneration.delete(targetGeneration);
    });
    return retirement;
  }

  function handleGenerationInputFailure(processRef, targetGeneration, stage = 'input') {
    if (targetGeneration == null || inputFailuresByGeneration.has(targetGeneration)) return;
    inputFailuresByGeneration.add(targetGeneration);
    const failure = clientError('IMAGE_WORKER_INPUT_CLOSED', 'image worker input closed', true);
    issue(failure, stage);
    if ([...pending.values()].some(item => item.generation === targetGeneration && item.mutating)) {
      void retireGeneration(processRef, targetGeneration, failure, stage);
    }
  }

  function handleLine(line, processRef, sourceGeneration) {
    if (retiringGenerations.has(sourceGeneration)) return;
    let response;
    try { response = JSON.parse(line); }
    catch {
      const failures = (protocolErrorsByGeneration.get(sourceGeneration) || 0) + 1;
      protocolErrorsByGeneration.set(sourceGeneration, failures);
      const error = clientError('IMAGE_WORKER_BAD_JSON', 'image worker returned invalid JSON');
      issue(error, 'protocol');
      if (failures >= 2) void retireGeneration(processRef, sourceGeneration, error, 'protocol');
      return;
    }
    if (!response || response.id == null || typeof response.ok !== 'boolean') {
      const failures = (protocolErrorsByGeneration.get(sourceGeneration) || 0) + 1;
      protocolErrorsByGeneration.set(sourceGeneration, failures);
      const error = clientError('IMAGE_WORKER_BAD_RESPONSE', 'image worker returned an invalid response');
      issue(error, 'protocol');
      if (failures >= 2) void retireGeneration(processRef, sourceGeneration, error, 'protocol');
      return;
    }
    const item = pending.get(String(response.id));
    if (!item || item.generation !== sourceGeneration) return;
    pending.delete(String(response.id));
    clearTimeout(item.timer);
    protocolErrorsByGeneration.set(sourceGeneration, 0);
    timeoutsByGeneration.set(sourceGeneration, 0);
    if (response.ok) item.resolve(response.result);
    else {
      const error = clientError(response.error?.code || 'IMAGE_WORKER_ERROR', response.error?.message || 'image worker failed', response.error?.retryable === true);
      if (item.safe) item.resolve(safeFor(item.op, item.skipped, 'unavailable', item.attempted, error.code));
      else item.reject(error);
    }
  }

  function start() {
    if (!enabled) return null;
    if (child && !child.killed) return child;
    if (Date.now() < circuitUntil) throw clientError('IMAGE_WORKER_COOLDOWN', 'image worker is cooling down');
    closing = false;
    const args = [
      options.workerPath,
      '--inbox', options.inboxDir || '', '--life-photos', options.lifePhotosDir || '', '--gallery', options.galleryDir || '',
      '--db', options.dbPath || '', '--policy', options.policyPath || '',
      '--manifest', options.manifestPath || '', '--cache', options.cacheDir || '', '--embedding-worker', options.embeddingWorkerPath || '',
      '--regions-enabled', regionsEnabled ? '1' : '0', '--detector-manifest', options.detectorManifestPath || '', '--detector-worker', options.detectorWorkerPath || '',
    ];
    const spawned = spawn(process.execPath, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const spawnedGeneration = ++generation;
    processGenerations.set(spawned, spawnedGeneration);
    child = spawned;
    const lines = createInterface({ input: spawned.stdout });
    lines.on('line', line => handleLine(line, spawned, spawnedGeneration));
    spawned.stdin.on('error', () => handleGenerationInputFailure(spawned, spawnedGeneration));
    spawned.stderr.on('data', () => {});
    spawned.once('error', error => {
      if (child !== spawned || generation !== spawnedGeneration) return;
      child = null;
      generation++;
      const failure = clientError('IMAGE_WORKER_SPAWN_FAILED', 'image worker could not start', true);
      circuitUntil = Date.now() + cooldownMs;
      issue(failure, 'spawn');
      inputFailuresByGeneration.delete(spawnedGeneration);
      settleGeneration(failure, spawnedGeneration, { circuit: true });
    });
    spawned.once('exit', (code, signal) => {
      lines.close();
      if (retiringGenerations.has(spawnedGeneration)) return;
      if (child !== spawned || generation !== spawnedGeneration) return;
      child = null;
      generation++;
      inputFailuresByGeneration.delete(spawnedGeneration);
      if (closing && ![...pending.values()].some(item => item.generation === spawnedGeneration)) return;
      const error = clientError('IMAGE_WORKER_EXITED', `image worker exited (${code ?? signal ?? 'unknown'})`);
      circuitUntil = Date.now() + cooldownMs;
      issue(error, 'exit');
      settleGeneration(error, spawnedGeneration, { circuit: true });
    });
    return spawned;
  }

  function send(op, payload = {}, { safe = false, skipped = 0, timeout = timeoutMs } = {}) {
    if (!enabled) return Promise.resolve(safeFor(op, skipped));
    const attempted = Array.isArray(payload.sources) ? payload.sources.length : 0;
    if (pending.size >= 16) {
      const error = clientError('IMAGE_WORKER_QUEUE_FULL', 'image worker queue is full');
      issue(error, 'queue');
      return safe ? Promise.resolve(safeFor(op, skipped, 'unavailable', attempted, error.code)) : Promise.reject(error);
    }
    let processRef;
    try { processRef = start(); }
    catch (error) { return safe ? Promise.resolve(safeFor(op, skipped, 'unavailable', attempted, error.code)) : Promise.reject(error); }
    const id = `${process.pid}-${Date.now()}-${++sequence}`;
    const request = { id, op, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = pending.get(id);
        if (!item) return;
        clearTimeout(item.timer);
        item.timer = null;
        const failures = (timeoutsByGeneration.get(item.generation) || 0) + 1;
        timeoutsByGeneration.set(item.generation, failures);
        const error = clientError('IMAGE_WORKER_TIMEOUT', 'image worker request timed out');
        issue(error, op);
        if (item.mutating) {
          item.fallbackHash = 'timeout';
          void retireGeneration(processRef, item.generation, error, op);
          return;
        }
        pending.delete(id);
        if (safe) resolve(safeFor(op, skipped, 'timeout', attempted, error.code)); else reject(error);
        if (failures >= 2) void retireGeneration(processRef, item.generation, error, 'timeout');
      }, timeout);
      pending.set(id, { resolve, reject, timer, op, safe, skipped, attempted, generation: processGenerations.get(processRef), mutating: mutatingOps.has(op), fallbackHash: null });
      const handleInputError = error => {
        if (!error) return;
        const item = pending.get(id);
        if (!item) return;
        clearTimeout(timer);
        item.timer = null;
        const failure = clientError('IMAGE_WORKER_INPUT_CLOSED', 'image worker input closed', true);
        if (item.mutating) {
          handleGenerationInputFailure(processRef, item.generation);
          return;
        }
        pending.delete(id);
        if (safe) resolve(safeFor(op, skipped, 'unavailable', attempted, failure.code)); else reject(error);
      };
      try {
        processRef.stdin.write(`${JSON.stringify(request)}\n`, handleInputError);
      } catch (error) {
        handleInputError(error);
      }
    });
  }

  async function batchWrite(op, sources) {
    const total = emptyCounts(regionsEnabled);
    for (let index = 0; index < sources.length; index += 4) {
      const result = await send(op, { sources: sources.slice(index, index + 4), deadlineMs: timeoutMs }, { safe: true });
      total.indexed += result.indexed || 0;
      total.unchanged += result.unchanged || 0;
      total.pendingEmbedding += result.pendingEmbedding || 0;
      if (regionsEnabled) total.pendingRegions += result.pendingRegions || 0;
      total.failed += result.failed || 0;
      total.codes.push(...(result.codes || []));
    }
    total.codes = [...new Set(total.codes)];
    return total;
  }

  return {
    get enabled() { return enabled; },
    get running() { return !!(child && !child.killed); },
    async recallBatch({ queries = [], beforeTs, excludeOccurrenceIds = [], deadlineAt = Date.now() + timeoutMs, angleFallbackEnabled: requestAngleFallback = angleFallbackEnabled }) {
      const selected = queries.slice(0, 8);
      const skipped = Math.max(0, queries.length - selected.length);
      const remaining = Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now()));
      const result = await send('recall', {
        queries: selected, beforeTs, excludeOccurrenceIds, deadlineMs: remaining, deadlineAt,
        limits: { maxHits, pHashMaxDistance, visualMinScore, ...(angleFallbackEnabled && requestAngleFallback === true ? { angleFallbackEnabled: true } : {}) },
      }, { safe: true, skipped, timeout: remaining });
      return { ...result, skippedQueryCount: skipped };
    },
    indexBatch(sources = []) { return sources.length ? batchWrite('index', sources) : Promise.resolve(emptyCounts(regionsEnabled)); },
    backfill(sources = []) { return sources.length ? batchWrite('backfill', sources) : Promise.resolve(emptyCounts(regionsEnabled)); },
    revoke(relativePaths = []) { return relativePaths.length ? send('revoke', { relativePaths }) : Promise.resolve({ revision: null, revokedPaths: [], revokedShas: [], removed: 0 }); },
    reconcile() { return send('reconcile', { deadlineMs: timeoutMs }, { safe: true }); },
    async syncSourceSnapshot(snapshot) {
      if (!snapshot || snapshot.status !== 'complete') return { skipped: true, code: snapshot?.issue?.code || 'IMAGE_SOURCE_UNREADABLE' };
      const snapshotId = `${snapshot.sourceType}-${process.pid}-${Date.now()}-${++sequence}`;
      const base = snapshot.base || { generation: 0, revision: null };
      await send('source_sync_begin', { snapshotId, sourceType: snapshot.sourceType, revision: snapshot.revision, baseGeneration: base.generation, baseRevision: base.revision, mode: snapshot.mode || 'complete' });
      try {
        const memberships = snapshot.memberships || [];
        const messages = snapshot.messages || [];
        const chunks = Math.max(Math.ceil(memberships.length / 32), Math.ceil(messages.length / 64), 1);
        for (let index = 0; index < chunks; index++) await send('source_sync_batch', { snapshotId, memberships: memberships.slice(index * 32, index * 32 + 32), messages: messages.slice(index * 64, index * 64 + 64) });
        return await send('source_sync_commit', { snapshotId });
      } catch (error) {
        try { await send('source_sync_abort', { snapshotId }); } catch {}
        throw error;
      }
    },
    removeSourceMemberships(membershipIds = []) { return membershipIds.length ? send('source_remove', { membershipIds }) : Promise.resolve({ removed: 0 }); },
    stats() { return send('stats'); },
    async close() {
      const current = child;
      if (!current) {
        await Promise.allSettled([...terminationTasks]);
        return;
      }
      closing = true;
      const currentGeneration = processGenerations.get(current);
      const exit = new Promise(resolveExit => current.once('exit', resolveExit));
      const handleShutdownError = error => {
        if (error) handleGenerationInputFailure(current, currentGeneration, 'close-input');
      };
      try { current.stdin.write(`${JSON.stringify({ id: `shutdown-${++sequence}`, op: 'shutdown' })}\n`, handleShutdownError); }
      catch (error) { handleShutdownError(error); }
      let timer;
      await Promise.race([exit, new Promise(resolveWait => { timer = setTimeout(resolveWait, closeGraceMs); })]);
      clearTimeout(timer);
      if (child === current) {
        const error = clientError('IMAGE_WORKER_CLOSED', 'image worker closed');
        const hasMutating = [...pending.values()].some(item => item.generation === currentGeneration && item.mutating);
        if (hasMutating) await retireGeneration(current, currentGeneration, error, 'close');
        else {
          await trackTermination(current);
          if (child === current) { child = null; generation++; }
          settleGeneration(error, currentGeneration, { circuit: true });
        }
      }
      await Promise.allSettled([...terminationTasks]);
      settleGeneration(clientError('IMAGE_WORKER_CLOSED', 'image worker closed'), currentGeneration);
      closing = false;
    },
  };
}
