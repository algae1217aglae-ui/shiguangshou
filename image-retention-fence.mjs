import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureImageRetentionRuntime, ensureImageRetentionRuntimeDirectory } from './image-retention-runtime.mjs';

function fenceError(code, message = code) {
  const error = new Error(`${code}: ${message}`); error.code = code; return error;
}

const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));

function paths(runtimeRoot) {
  const runtime = ensureImageRetentionRuntime(runtimeRoot, { code: 'RETENTION_FENCE_ROOT_UNSAFE' });
  const claims = ensureImageRetentionRuntimeDirectory(runtime, 'claims', { code: 'RETENTION_FENCE_ROOT_UNSAFE' });
  return { claims, cleanup: join(runtime, 'cleanup.lock') };
}

function anonymousClaimName(kind, relativePath, token) {
  const digest = createHash('sha256').update(String(relativePath || kind || 'global')).digest('hex');
  return `${String(kind || 'writer').replace(/[^a-z0-9_-]/gi, '_')}-${digest}-${process.pid}-${token}.claim`;
}

function ownedUnlink(path, token) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.token !== token) return false;
    unlinkSync(path); return true;
  } catch { return false; }
}

async function createClaim({ runtimeRoot, relativePath = '', kind = 'writer', timeoutMs = 5000, pollMs = 10 }) {
  const fencePaths = paths(runtimeRoot);
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (existsSync(fencePaths.cleanup)) { await pause(pollMs); continue; }
    const token = randomUUID();
    const path = join(fencePaths.claims, anonymousClaimName(kind, relativePath, token));
    let descriptor;
    try {
      descriptor = openSync(path, 'wx');
      writeFileSync(descriptor, JSON.stringify({ version: 1, token, pid: process.pid, kind, createdAt: new Date().toISOString() }));
    } catch (error) {
      if (descriptor != null) try { closeSync(descriptor); } catch {}
      if (error?.code !== 'EEXIST') throw error;
      await pause(pollMs); continue;
    }
    closeSync(descriptor);
    if (existsSync(fencePaths.cleanup)) {
      ownedUnlink(path, token);
      await pause(pollMs); continue;
    }
    return { token, path, release: async () => ownedUnlink(path, token) };
  }
  throw fenceError('RETENTION_FENCE_TIMEOUT');
}

export async function withImageRetentionClaim(options, operation) {
  const claim = await createClaim(options);
  try { return await operation(claim); }
  finally { await claim.release(); }
}

export async function acquireImageRetentionClaim(options) {
  return createClaim(options);
}

export async function acquireImageRetentionClaims({ runtimeRoot, relativePaths = [], kind = 'writer', timeoutMs = 5000 } = {}) {
  const paths = [...new Set(relativePaths)].sort();
  if (!paths.length) return { claims: [], release: async () => true };
  const claims = [];
  try {
    claims.push(await createClaim({ runtimeRoot, relativePath: paths.join('\n'), kind, timeoutMs }));
    return {
      claims,
      release: async () => {
        let released = true;
        for (const claim of [...claims].reverse()) released = (await claim.release()) && released;
        return released;
      },
    };
  } catch (error) {
    for (const claim of [...claims].reverse()) await claim.release();
    throw error;
  }
}

export async function withImageRetentionClaims(options, operation) {
  const group = await acquireImageRetentionClaims(options);
  try { return await operation(group); }
  finally { await group.release(); }
}

export async function acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs = 5000, pollMs = 10 } = {}) {
  const fencePaths = paths(runtimeRoot);
  const token = randomUUID();
  let descriptor;
  try {
    descriptor = openSync(fencePaths.cleanup, 'wx');
    writeFileSync(descriptor, JSON.stringify({ version: 1, token, pid: process.pid, createdAt: new Date().toISOString() }));
    closeSync(descriptor); descriptor = null;
  } catch (error) {
    if (descriptor != null) try { closeSync(descriptor); } catch {}
    if (error?.code === 'EEXIST') throw fenceError('RETENTION_CLEANUP_BUSY');
    throw error;
  }
  const started = Date.now();
  try {
    while (Date.now() - started <= timeoutMs) {
      const active = readdirSync(fencePaths.claims).filter(name => name.endsWith('.claim'));
      if (!active.length) {
        return {
          token,
          release: async supplied => ownedUnlink(fencePaths.cleanup, supplied || token),
        };
      }
      await pause(pollMs);
    }
    throw fenceError('RETENTION_FENCE_TIMEOUT');
  } catch (error) {
    ownedUnlink(fencePaths.cleanup, token);
    throw error;
  }
}

export function inspectImageRetentionFence(runtimeRoot) {
  const fencePaths = paths(runtimeRoot);
  return {
    cleanupLocked: existsSync(fencePaths.cleanup),
    claimCount: readdirSync(fencePaths.claims).filter(name => name.endsWith('.claim')).length,
  };
}
