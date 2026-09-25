import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { executeImageRetention } from './image-retention-executor.mjs';
import { previewImageRetention } from './image-retention.mjs';
import {
  ensureImageRetentionRuntime, imageRetentionRuntimeFile, readImageRetentionRuntimeFile, writeImageRetentionRuntimeFileAtomic,
} from './image-retention-runtime.mjs';

const TOKEN_FILE = 'operator-token';

function issueCode(error, fallback) { return String(error?.code || fallback).slice(0, 96); }

function recordLastRun(runtimeRoot, value) {
  if (!runtimeRoot) return;
  writeImageRetentionRuntimeFileAtomic(runtimeRoot, 'last-run.json', JSON.stringify({ version: 1, ...value }));
}

export function initializeImageRetentionOperatorToken(runtimeRoot) {
  const runtime = ensureImageRetentionRuntime(runtimeRoot);
  const path = imageRetentionRuntimeFile(runtime, TOKEN_FILE);
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  ensureImageRetentionRuntime(runtime);
  return readFileSync(path, 'utf8').trim();
}

export function readImageRetentionOperatorToken(runtimeRoot) {
  try { return readImageRetentionRuntimeFile(runtimeRoot, TOKEN_FILE).trim(); } catch { return ''; }
}

function equalToken(actual, expected) {
  const a = Buffer.from(String(actual || '')); const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length >= 32 && timingSafeEqual(a, b);
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(body);
}

function loopback(address) { return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || '')); }

export function createImageRetentionHttpHandler({
  root, runtimeRoot, getConfig = () => ({}), isImageBusy = () => false, allowedHosts = () => [],
  preview = options => previewImageRetention(options),
  execute = options => executeImageRetention(options),
  getClient = null,
} = {}) {
  return function imageRetentionHttpHandler(req, res) {
    let path;
    try { path = new URL(req.url, 'http://local.invalid').pathname; } catch { path = ''; }
    if (path !== '/api/image-retention') { send(res, 404, { error: 'not found' }); return; }
    if (req.method !== 'POST') { send(res, 405, { error: 'method not allowed' }); return; }
    const host = String(req.headers.host || '').toLowerCase();
    const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'].some(name => req.headers[name] != null);
    if (!loopback(req.socket?.remoteAddress) || forwarded || !allowedHosts().map(x => String(x).toLowerCase()).includes(host) || req.headers.origin) {
      send(res, 403, { error: 'local authenticated CLI only' }); return;
    }
    if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) { send(res, 415, { error: 'json required' }); return; }
    const expected = readImageRetentionOperatorToken(runtimeRoot);
    const actual = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''))?.[1] || '';
    if (!expected || !equalToken(actual, expected)) { send(res, 401, { error: 'unauthorized' }); return; }
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 16384) req.destroy(); });
    req.on('end', async () => {
      let body; try { body = JSON.parse(raw || '{}'); } catch { send(res, 400, { error: 'invalid json' }); return; }
      const cfg = getConfig();
      try {
        if (body.mode === 'preview') { send(res, 200, await preview({ root, days: 90 })); return; }
        if (body.mode !== 'execute') { send(res, 400, { error: 'mode must be preview or execute' }); return; }
        if (cfg.imageRetentionEnabled !== true || Number(cfg.imageRetentionDays) !== 90) { send(res, 409, { error: 'retention execution is disabled' }); return; }
        if (isImageBusy()) { send(res, 409, { error: 'image work is busy' }); return; }
        const client = getClient?.();
        const result = await execute({
          root, runtimeRoot, enabled: true, days: 90,
          reconcile: client ? () => client.reconcile() : undefined,
        });
        send(res, 200, result);
      } catch (error) { send(res, 409, { error: String(error?.code || error?.message || error) }); }
    });
  };
}

export function createImageRetentionScheduler({
  runtimeRoot, getConfig, isImageBusy = () => false, run, onIssue = () => {}, now = Date.now, setIntervalFn = setInterval,
} = {}) {
  let timer = null;
  const persist = value => {
    try { recordLastRun(runtimeRoot, value); return true; }
    catch {
      try { onIssue({ operation: value.operation || 'cleanup', code: 'RETENTION_LAST_RUN_WRITE_FAILED' }); } catch {}
      return false;
    }
  };
  const tick = async () => {
    const cfg = getConfig();
    if (cfg.imageRetentionEnabled !== true || Number(cfg.imageRetentionDays) !== 90 || isImageBusy()) return { skipped: true };
    try {
      const result = await run();
      const failedCount = Number(result?.failedCount) || 0;
      const pendingRepairCount = Number(result?.pendingRepairCount) || 0;
      persist({
        operation: 'cleanup', status: failedCount || pendingRepairCount ? 'attention' : 'ok', at: new Date(now()).toISOString(),
        deletedCount: Number(result?.deletedCount) || 0, synchronizedCount: Number(result?.synchronizedCount) || 0,
        pendingRepairCount, failedCount,
      });
      return result;
    } catch (error) {
      const code = issueCode(error, 'RETENTION_SCHEDULE_FAILED');
      persist({ operation: 'cleanup', status: 'error', at: new Date(now()).toISOString(), code });
      try { onIssue({ operation: 'cleanup', code }); } catch {}
      return { failed: true, code };
    }
  };
  return {
    tick,
    start() {
      const cfg = getConfig();
      if (cfg.imageRetentionEnabled !== true) return false;
      const interval = Math.max(6 * 3600000, Number(cfg.imageRetentionIntervalMs) || 6 * 3600000);
      timer = setIntervalFn(() => { tick().catch(() => {}); }, interval);
      timer?.unref?.(); return true;
    },
    get timer() { return timer; },
  };
}

export function createImageRetentionRepairScheduler({
  runtimeRoot, repair, retryMs = 5 * 60000, onIssue = () => {}, now = Date.now, setTimeoutFn = setTimeout,
} = {}) {
  const boundedRetryMs = Math.max(1000, Math.min(6 * 3600000, Number(retryMs) || 5 * 60000));
  let timer = null;
  const persist = value => {
    try { recordLastRun(runtimeRoot, value); return true; }
    catch {
      try { onIssue({ operation: 'repair', code: 'RETENTION_LAST_RUN_WRITE_FAILED' }); } catch {}
      return false;
    }
  };
  const schedule = delay => {
    timer = setTimeoutFn(() => { tick().catch(() => {}); }, Math.max(0, delay));
    timer?.unref?.();
    return timer;
  };
  const tick = async () => {
    let result;
    try {
      result = await repair();
      if (result?.pending) {
        const rawReason = String(result.reason || '');
        const code = rawReason === 'policy_paused' ? 'RETENTION_REPAIR_POLICY_PAUSED'
          : /^[A-Z][A-Z0-9_:-]{2,95}$/.test(rawReason) ? rawReason : 'RETENTION_REPAIR_PENDING';
        persist({ operation: 'repair', status: 'pending', at: new Date(now()).toISOString(), code });
        try { onIssue({ operation: 'repair', code }); } catch {}
      } else if (result?.repaired) {
        persist({ operation: 'repair', status: 'ok', at: new Date(now()).toISOString(), removed: Number(result.removed) || 0, wasCorrupt: result.wasCorrupt === true });
      }
      return result || { pending: false, repaired: false };
    } catch (error) {
      const code = issueCode(error, 'RETENTION_REPAIR_FAILED');
      persist({ operation: 'repair', status: 'error', at: new Date(now()).toISOString(), code });
      try { onIssue({ operation: 'repair', code }); } catch {}
      return { pending: true, repaired: false, failed: true, reason: code };
    } finally {
      schedule(boundedRetryMs);
    }
  };
  return { tick, start(delayMs = 0) { return schedule(delayMs); }, get timer() { return timer; } };
}
