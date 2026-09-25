import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function processError(code, message, retryable = true) {
  return Object.assign(new Error(message), { code, retryable });
}

export function createEmbeddingProcessClient(options = {}) {
  const maxQueue = Number.isInteger(options.maxQueue) ? options.maxQueue : 8;
  const inferenceTimeoutMs = Number.isFinite(options.inferenceTimeoutMs) ? options.inferenceTimeoutMs : 10000;
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 60000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 250;
  const warmupTimeoutMs = Number.isFinite(options.warmupTimeoutMs) ? options.warmupTimeoutMs : 120000;
  let child = null;
  let sequence = 0;
  let active = null;
  let isReady = false;
  let closing = false;
  let cooldownUntil = 0;
  let pollTimer = null;
  let warmTimer = null;
  let generation = 0;
  const pending = new Map();
  const queue = [];

  function settlePending(error) {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(id);
      item.reject(error);
    }
  }

  function rejectQueue(error) {
    while (queue.length) queue.shift().reject(error);
  }

  function stopProcess(error, enterCooldown = true) {
    if (enterCooldown) cooldownUntil = Date.now() + cooldownMs;
    isReady = false;
    clearTimeout(pollTimer);
    pollTimer = null;
    clearTimeout(warmTimer);
    warmTimer = null;
    const current = child;
    child = null;
    generation++;
    if (current && !current.killed) current.kill();
    settlePending(error);
  }

  function onLine(line) {
    let response;
    try { response = JSON.parse(line); }
    catch { return stopProcess(processError('MODEL_PROTOCOL_ERROR', 'embedding worker returned invalid JSON')); }
    const item = pending.get(String(response?.id));
    if (!item) return;
    pending.delete(String(response.id));
    clearTimeout(item.timer);
    if (response.ok) item.resolve(response.result);
    else item.reject(processError(response.error?.code || 'MODEL_UNAVAILABLE', response.error?.message || 'embedding failed', response.error?.retryable !== false));
  }

  function request(op, payload = {}, timeoutMs = 1000) {
    if (!child || child.killed) return Promise.reject(processError('MODEL_PROCESS_EXITED', 'embedding worker is not running'));
    const id = `embed-${process.pid}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(processError(op === 'embed' || op === 'embed_regions' ? 'MODEL_TIMEOUT' : 'MODEL_WARMING', `${op} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`, error => {
        if (!error || !pending.delete(id)) return;
        clearTimeout(timer);
        reject(processError('MODEL_PROCESS_EXITED', 'embedding worker input closed'));
      });
    });
  }

  function scheduleReadyPoll() {
    clearTimeout(pollTimer);
    if (!child || closing || isReady) return;
    pollTimer = setTimeout(async () => {
      try {
        const status = await request('stats', {}, Math.max(100, pollMs * 4));
        isReady = status?.loaded === true && status?.embeddingVersion === options.embeddingVersion;
        if (isReady) { clearTimeout(warmTimer); warmTimer = null; }
      } catch {}
      if (!isReady) scheduleReadyPoll();
    }, pollMs);
    pollTimer.unref?.();
  }

  function start() {
    if (child && !child.killed) return;
    if (Date.now() < cooldownUntil) return;
    closing = false;
    const args = [
      options.workerPath,
      '--inbox', options.inboxDir || '', '--life-photos', options.lifePhotosDir || '', '--gallery', options.galleryDir || '',
      '--manifest', options.manifestPath || '', '--cache', options.cacheDir || '',
      ...(options.extraArgs || []),
    ];
    const spawned = spawn(process.execPath, args, { cwd: options.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const spawnedGeneration = ++generation;
    child = spawned;
    const lines = createInterface({ input: spawned.stdout });
    lines.on('line', onLine);
    spawned.stderr.on('data', () => {});
    spawned.once('error', () => {
      if (child !== spawned || generation !== spawnedGeneration) return;
      child = null;
      clearTimeout(pollTimer);
      pollTimer = null;
      clearTimeout(warmTimer);
      warmTimer = null;
      const error = processError('MODEL_PROCESS_EXITED', 'embedding worker could not start');
      settlePending(error); rejectQueue(error); isReady = false;
    });
    spawned.once('exit', () => {
      lines.close();
      if (child !== spawned || generation !== spawnedGeneration) return;
      child = null;
      isReady = false;
      clearTimeout(pollTimer);
      pollTimer = null;
      clearTimeout(warmTimer);
      warmTimer = null;
      if (closing) return;
      cooldownUntil = Date.now() + cooldownMs;
      const error = processError('MODEL_PROCESS_EXITED', 'embedding worker exited');
      settlePending(error); rejectQueue(error);
    });
    scheduleReadyPoll();
    warmTimer = setTimeout(() => {
      const error = processError('MODEL_WARM_TIMEOUT', 'embedding model warmup timed out');
      stopProcess(error, true);
      rejectQueue(error);
    }, warmupTimeoutMs);
    warmTimer.unref?.();
  }

  async function pump() {
    if (active || !queue.length) return;
    const job = queue.shift();
    active = job;
    try {
      const remaining = Number.isFinite(job.deadlineAt) ? job.deadlineAt - Date.now() : inferenceTimeoutMs;
      if (remaining <= 0) throw processError('MODEL_TIMEOUT', 'embedding deadline expired');
      const result = await request(job.op, job.payload, Math.min(inferenceTimeoutMs, remaining));
      if (result?.embeddingVersion !== options.embeddingVersion) throw processError('MODEL_VERSION_MISMATCH', 'embedding result version is invalid');
      if (job.op === 'embed_regions') {
        if (!Array.isArray(result.embeddings) || result.embeddings.length !== job.payload.descriptors.length || result.sourceSha256 !== job.payload.expectedSha256) throw processError('MODEL_PROTOCOL_ERROR', 'region embedding result is invalid');
        job.resolve(result.embeddings.map(vector => Float32Array.from(vector)));
      } else {
        if (!Array.isArray(result.embedding)) throw processError('MODEL_PROTOCOL_ERROR', 'embedding result is invalid');
        job.resolve(Float32Array.from(result.embedding));
      }
    } catch (error) {
      job.reject(error);
      if (error.code === 'MODEL_TIMEOUT' || error.code === 'MODEL_PROTOCOL_ERROR') stopProcess(error, true);
    } finally {
      if (active === job) active = null;
      queueMicrotask(pump);
    }
  }

  start();
  function enqueue(op, payload, { priority = 'background', deadlineAt = null } = {}) {
    if (Date.now() < cooldownUntil) return Promise.reject(processError('MODEL_COOLDOWN', 'embedding worker is cooling down'));
    if (!child) start();
    if (!isReady) return Promise.reject(processError('MODEL_WARMING', 'embedding model is still warming'));
    if (queue.length + (active ? 1 : 0) >= maxQueue) return Promise.reject(processError('MODEL_QUEUE_FULL', 'embedding queue is full'));
    return new Promise((resolve, reject) => {
      queue.push({ op, payload, priority: priority === 'query' ? 0 : 1, order: ++sequence, deadlineAt, resolve, reject });
      queue.sort((left, right) => left.priority - right.priority || left.order - right.order);
      pump();
    });
  }
  return {
    get ready() { return isReady; },
    get queued() { return queue.length + (active ? 1 : 0); },
    embed(relativePath, requestOptions = {}) {
      return enqueue('embed', { relativePath, embeddingVersion: options.embeddingVersion }, requestOptions);
    },
    embedRegions(relativePath, descriptors, { expectedSha256, ...requestOptions } = {}) {
      if (!Array.isArray(descriptors) || descriptors.length < 1 || descriptors.length > 5) return Promise.reject(processError('IMAGE_REGION_INVALID', 'region request must contain one to five descriptors', false));
      if (!/^[0-9a-f]{64}$/i.test(String(expectedSha256 || ''))) return Promise.reject(processError('IMAGE_REGION_INVALID', 'expected image SHA is invalid', false));
      return enqueue('embed_regions', { relativePath, descriptors, expectedSha256: expectedSha256.toLowerCase(), embeddingVersion: options.embeddingVersion }, requestOptions);
    },
    async close() {
      closing = true;
      clearTimeout(pollTimer);
      pollTimer = null;
      clearTimeout(warmTimer);
      warmTimer = null;
      const current = child;
      if (!current) return;
      const exit = new Promise(resolveExit => current.once('exit', resolveExit));
      try { await Promise.race([request('shutdown', {}, 500), new Promise(resolveWait => setTimeout(resolveWait, 500))]); } catch {}
      await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 500))]);
      if (child === current && !current.killed) {
        current.kill();
        await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 500))]);
      }
      if (child === current) { child = null; generation++; }
      settlePending(processError('MODEL_PROCESS_EXITED', 'embedding worker closed'));
      rejectQueue(processError('MODEL_PROCESS_EXITED', 'embedding worker closed'));
      isReady = false;
    },
  };
}
