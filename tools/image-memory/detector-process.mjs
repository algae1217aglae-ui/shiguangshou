import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createDetectorRuntimeEnvironment } from '../image-region/prepare-detector.mjs';

function detectorError(code, message, retryable = true) {
  return Object.assign(new Error(message), { code, retryable });
}

function classifyStderr(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return null;
  if (/out of memory|bad alloc|cannot allocate|paging file|memoryerror/.test(text)) return 'resource_exhausted';
  if (/modulenotfound|importerror|dll load failed/.test(text)) return 'dependency_error';
  if (/can't open file|no such file|filenotfound/.test(text)) return 'missing_file';
  if (/access denied|permission/.test(text)) return 'permission';
  if (/socket|network.+block/.test(text)) return 'network_guard';
  return 'other';
}

function validateResult(result, expectedVersion) {
  if (result?.detectorVersion !== expectedVersion || !Array.isArray(result?.detections) || result.detections.length > 20) throw detectorError('DETECTOR_PROTOCOL_ERROR', 'detector result is invalid');
  if (!Number.isInteger(result.rawDetectionCount) || result.rawDetectionCount < result.detections.length || !Number.isInteger(result.orientedWidth) || !Number.isInteger(result.orientedHeight)) throw detectorError('DETECTOR_PROTOCOL_ERROR', 'detector result metadata is invalid');
  for (const row of result.detections) {
    const box = row?.bbox;
    if (!box || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(box[key])) || box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1.000001 || box.y + box.height > 1.000001 || !Number.isInteger(row.classId) || typeof row.className !== 'string' || row.className.length > 80 || !Number.isFinite(row.confidence)) {
      throw detectorError('DETECTOR_PROTOCOL_ERROR', 'detector box is invalid');
    }
  }
  return result;
}

export function createDetectorProcessClient(options = {}) {
  const maxQueue = Number.isInteger(options.maxQueue) ? options.maxQueue : 4;
  const detectorTimeoutMs = Number.isFinite(options.detectorTimeoutMs) ? options.detectorTimeoutMs : 900;
  const backgroundTimeoutMs = Number.isFinite(options.backgroundTimeoutMs) ? options.backgroundTimeoutMs : Math.max(detectorTimeoutMs, 10000);
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 60000;
  const pollMs = Number.isFinite(options.pollMs) ? options.pollMs : 250;
  const warmupTimeoutMs = Number.isFinite(options.warmupTimeoutMs) ? options.warmupTimeoutMs : 120000;
  let child = null;
  let active = null;
  let sequence = 0;
  let generation = 0;
  let closing = false;
  let isReady = false;
  let cooldownUntil = 0;
  let lastErrorCode = null;
  let lastExitCode = null;
  let lastExitSignal = null;
  let lastStderrCategory = null;
  let lastSpawnErrorCode = null;
  let lastFatalErrorCode = null;
  let pollTimer = null;
  let warmTimer = null;
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

  function stop(error, enterCooldown = true) {
    lastErrorCode = String(error?.code || 'DETECTOR_UNAVAILABLE');
    lastFatalErrorCode = lastErrorCode;
    if (enterCooldown) cooldownUntil = Date.now() + cooldownMs;
    isReady = false;
    clearTimeout(pollTimer); pollTimer = null;
    clearTimeout(warmTimer); warmTimer = null;
    const current = child;
    child = null;
    generation++;
    if (current && !current.killed) current.kill();
    settlePending(error);
  }

  function onLine(line) {
    let response;
    try { response = JSON.parse(line); }
    catch { return stop(detectorError('DETECTOR_PROTOCOL_ERROR', 'detector worker returned invalid JSON')); }
    const item = pending.get(String(response?.id));
    if (!item) return;
    pending.delete(String(response.id));
    clearTimeout(item.timer);
    if (response.ok) item.resolve(response.result);
    else item.reject(detectorError(response.error?.code || 'DETECTOR_UNAVAILABLE', response.error?.message || 'detector failed', response.error?.retryable !== false));
  }

  function request(op, payload = {}, timeoutMs = 1000) {
    if (!child || child.killed) return Promise.reject(detectorError('DETECTOR_PROCESS_EXITED', 'detector worker is not running'));
    const id = `detector-${process.pid}-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        reject(detectorError(op === 'detect' ? 'DETECTOR_TIMEOUT' : 'DETECTOR_WARMING', `${op} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`, error => {
        if (!error || !pending.delete(id)) return;
        clearTimeout(timer);
        reject(detectorError('DETECTOR_PROCESS_EXITED', 'detector worker input closed'));
      });
    });
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!child || closing || isReady) return;
    pollTimer = setTimeout(async () => {
      try {
        const result = await request('stats', {}, Math.max(100, pollMs * 4));
        isReady = result?.loaded === true && result?.detectorVersion === options.detectorVersion;
        if (isReady) { clearTimeout(warmTimer); warmTimer = null; lastSpawnErrorCode = null; }
      } catch {}
      if (!isReady) schedulePoll();
    }, pollMs);
    pollTimer.unref?.();
  }

  function start() {
    if (child && !child.killed) return;
    if (Date.now() < cooldownUntil) return;
    closing = false;
    const runtimeDir = options.runtimeDir ? resolve(options.runtimeDir) : null;
    const runtimeEnv = runtimeDir ? createDetectorRuntimeEnvironment(runtimeDir, options.env || process.env) : (options.env || process.env);
    if (runtimeDir) {
      for (const key of ['YOLO_CONFIG_DIR', 'MPLCONFIGDIR', 'TORCH_HOME', 'HF_HOME', 'TRANSFORMERS_CACHE']) mkdirSync(runtimeEnv[key], { recursive: true });
    }
    const args = [
      options.workerPath, '--inbox', options.inboxDir || '', '--life-photos', options.lifePhotosDir || '', '--gallery', options.galleryDir || '',
      '--weight', options.weightPath || '', '--detector-version', options.detectorVersion || '',
      ...(runtimeDir ? ['--runtime', runtimeDir] : []),
      ...(options.extraArgs || []),
    ];
    const spawned = spawn(options.command, args, { cwd: options.cwd, env: runtimeEnv, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const spawnedGeneration = ++generation;
    let stderrTail = '';
    child = spawned;
    const lines = createInterface({ input: spawned.stdout });
    lines.on('line', onLine);
    spawned.stderr.on('data', chunk => { stderrTail = `${stderrTail}${String(chunk)}`.slice(-4096); });
    spawned.once('error', spawnError => {
      if (child !== spawned || generation !== spawnedGeneration) return;
      child = null; isReady = false;
      clearTimeout(pollTimer); clearTimeout(warmTimer);
      lastSpawnErrorCode = /^[A-Z0-9_]+$/.test(String(spawnError?.code || '')) ? String(spawnError.code) : 'SPAWN_ERROR';
      lastFatalErrorCode = 'DETECTOR_PROCESS_EXITED';
      const error = detectorError('DETECTOR_PROCESS_EXITED', 'detector worker could not start');
      settlePending(error); rejectQueue(error);
    });
    spawned.once('exit', (code, signal) => {
      lines.close();
      if (child !== spawned || generation !== spawnedGeneration) return;
      child = null; isReady = false;
      clearTimeout(pollTimer); clearTimeout(warmTimer);
      if (closing) return;
      lastExitCode = Number.isInteger(code) ? code : null;
      lastExitSignal = signal ? String(signal) : null;
      lastStderrCategory = classifyStderr(stderrTail);
      lastFatalErrorCode = 'DETECTOR_PROCESS_EXITED';
      cooldownUntil = Date.now() + cooldownMs;
      const error = detectorError('DETECTOR_PROCESS_EXITED', 'detector worker exited');
      settlePending(error); rejectQueue(error);
    });
    schedulePoll();
    warmTimer = setTimeout(() => {
      const error = detectorError('DETECTOR_WARM_TIMEOUT', 'detector warmup timed out');
      stop(error, true); rejectQueue(error);
    }, warmupTimeoutMs);
    warmTimer.unref?.();
  }

  async function pump() {
    if (active || !queue.length) return;
    const job = queue.shift();
    active = job;
    try {
      const hardTimeoutMs = job.priority === 0 ? detectorTimeoutMs : backgroundTimeoutMs;
      const remaining = Number.isFinite(job.deadlineAt) ? job.deadlineAt - Date.now() : hardTimeoutMs;
      if (remaining <= 0) throw detectorError('DETECTOR_TIMEOUT', 'detector deadline expired');
      const result = await request('detect', {
        relativePath: job.relativePath, expectedSha256: job.expectedSha256,
      }, Math.min(hardTimeoutMs, remaining));
      lastErrorCode = null;
      job.resolve(validateResult(result, options.detectorVersion));
    } catch (error) {
      lastErrorCode = String(error?.code || 'DETECTOR_UNAVAILABLE');
      job.reject(error);
      if (error.code === 'DETECTOR_TIMEOUT' || error.code === 'DETECTOR_PROTOCOL_ERROR') stop(error, true);
    } finally {
      if (active === job) active = null;
      queueMicrotask(pump);
    }
  }

  start();
  return {
    get ready() { return isReady; },
    get queued() { return queue.length + (active ? 1 : 0); },
    detect(relativePath, { expectedSha256, deadlineAt = null, priority = 'background' } = {}) {
      if (!/^[0-9a-f]{64}$/i.test(String(expectedSha256 || ''))) return Promise.reject(detectorError('DETECTOR_REQUEST_INVALID', 'expected image SHA is invalid', false));
      if (Number.isFinite(deadlineAt) && deadlineAt <= Date.now()) return Promise.reject(detectorError('DETECTOR_TIMEOUT', 'detector deadline expired'));
      if (Date.now() < cooldownUntil) return Promise.reject(detectorError('DETECTOR_COOLDOWN', 'detector worker is cooling down'));
      if (!child) start();
      if (!isReady) return Promise.reject(detectorError('DETECTOR_WARMING', 'detector model is still warming'));
      if (queue.length + (active ? 1 : 0) >= maxQueue) return Promise.reject(detectorError('DETECTOR_QUEUE_FULL', 'detector queue is full'));
      return new Promise((resolve, reject) => {
        queue.push({ relativePath, expectedSha256: expectedSha256.toLowerCase(), deadlineAt, priority: priority === 'query' ? 0 : 1, order: ++sequence, resolve, reject });
        queue.sort((left, right) => left.priority - right.priority || left.order - right.order);
        pump();
      });
    },
    stats() {
      return {
        ready: isReady, queued: queue.length + (active ? 1 : 0), cooldownUntil, lastErrorCode,
        lastExitCode, lastExitSignal, lastStderrCategory, lastSpawnErrorCode, lastFatalErrorCode,
      };
    },
    async close() {
      closing = true;
      clearTimeout(pollTimer); pollTimer = null;
      clearTimeout(warmTimer); warmTimer = null;
      const current = child;
      if (!current) return;
      const exit = new Promise(resolveExit => current.once('exit', resolveExit));
      try { await Promise.race([request('shutdown', {}, 500), new Promise(resolveWait => setTimeout(resolveWait, 500))]); } catch {}
      await Promise.race([exit, new Promise(resolveWait => setTimeout(resolveWait, 500))]);
      if (child === current && !current.killed) current.kill();
      if (child === current) { child = null; generation++; }
      settlePending(detectorError('DETECTOR_PROCESS_EXITED', 'detector worker closed'));
      rejectQueue(detectorError('DETECTOR_PROCESS_EXITED', 'detector worker closed'));
      isReady = false;
    },
  };
}
