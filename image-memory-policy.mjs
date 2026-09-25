import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import { refreshImageMatchQueryEvidence } from './image-memory-core.mjs';

function policyError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function normalizePath(value) {
  const path = String(value || '').trim().replaceAll('\\', '/').replace(/^\/+/, '');
  const match = /^(inbox|life-photos|gallery)\/[^/:]+$/i.exec(path);
  if (!match || path.includes('..')) throw policyError('invalid image memory path', 'IMAGE_MEMORY_POLICY_PATH_INVALID');
  return `${match[1].toLowerCase()}/${path.slice(path.indexOf('/') + 1)}`;
}

function normalizeSha(value) {
  const sha = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw policyError('invalid image memory sha256', 'IMAGE_MEMORY_POLICY_SHA_INVALID');
  return sha;
}

function validatePolicy(value) {
  if (!value || value.version !== 1 || !Number.isInteger(value.revision) || value.revision < 0 || !value.paths || !value.shas) {
    throw policyError('image memory policy is invalid', 'IMAGE_MEMORY_POLICY_INVALID');
  }
  for (const [path, revokedAt] of Object.entries(value.paths)) {
    normalizePath(path);
    if (!Number.isFinite(revokedAt)) throw policyError('image memory policy is invalid', 'IMAGE_MEMORY_POLICY_INVALID');
  }
  for (const [sha, revokedAt] of Object.entries(value.shas)) {
    normalizeSha(sha);
    if (!Number.isFinite(revokedAt)) throw policyError('image memory policy is invalid', 'IMAGE_MEMORY_POLICY_INVALID');
  }
  return value;
}

export function readImageMemoryPolicy(policyPath) {
  if (!existsSync(policyPath)) throw policyError('image memory policy is missing', 'IMAGE_MEMORY_POLICY_MISSING');
  try {
    return validatePolicy(JSON.parse(readFileSync(policyPath, 'utf8')));
  } catch (error) {
    if (error?.code?.startsWith('IMAGE_MEMORY_POLICY_')) throw error;
    throw policyError('image memory policy is invalid', 'IMAGE_MEMORY_POLICY_INVALID', error);
  }
}

export function filterImageMemoryMatchesByPolicy(policyPath, matches) {
  const status = imageMemoryPolicyStatus(policyPath);
  if (status.paused) return { matches: [], warning: status.code };
  try {
    const policy = readImageMemoryPolicy(policyPath);
    return {
      matches: (Array.isArray(matches) ? matches : []).flatMap(match => {
        try {
          const relativePath = normalizePath(match?.relativePath);
          const sha256 = normalizeSha(match?.sha256);
          if (policy.paths?.[relativePath] != null || policy.shas?.[sha256] != null) return [];
          const refreshed = refreshImageMatchQueryEvidence(match, evidence => {
            try {
              const queryPath = normalizePath(evidence?.queryRelativePath);
              const querySha = normalizeSha(evidence?.querySha256);
              return policy.paths?.[queryPath] == null && policy.shas?.[querySha] == null;
            } catch { return false; }
          });
          return refreshed ? [refreshed] : [];
        } catch { return []; }
      }),
      warning: null,
    };
  } catch (error) {
    return { matches: [], warning: String(error?.code || 'IMAGE_MEMORY_POLICY_INVALID') };
  }
}

export function initializeImageMemoryPolicy(policyPath) {
  return withPolicyWriteLock(policyPath, () => {
    if (!existsSync(policyPath)) atomicWritePolicy(policyPath, { version: 1, revision: 0, paths: {}, shas: {} });
    return flushPendingDenialsUnderLock(policyPath).policy;
  });
}

export async function initializeImageMemoryPolicyAsync(policyPath, { lockTimeoutMs = 250 } = {}) {
  return withPolicyWriteLockAsync(policyPath, () => {
    if (!existsSync(policyPath)) atomicWritePolicy(policyPath, { version: 1, revision: 0, paths: {}, shas: {} });
    return flushPendingDenialsUnderLock(policyPath).policy;
  }, lockTimeoutMs);
}

const quarantinedPolicies = new Set();
const unpersistedDenials = new Set();
const pendingDirectory = policyPath => `${policyPath}.pending`;

function pendingFiles(policyPath) {
  try {
    return readdirSync(pendingDirectory(policyPath), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => `${pendingDirectory(policyPath)}/${entry.name}`)
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    quarantinedPolicies.add(policyPath);
    throw policyError('image memory pending denial directory cannot be read', 'IMAGE_MEMORY_POLICY_PENDING_READ_FAILED', error);
  }
}

export function imageMemoryPolicyStatus(policyPath) {
  try {
    const count = pendingFiles(policyPath).length;
    const paused = quarantinedPolicies.has(policyPath) || count > 0;
    return { paused, pendingCount: count, code: paused ? 'IMAGE_MEMORY_POLICY_PENDING' : null };
  } catch (error) {
    return { paused: true, pendingCount: null, code: String(error?.code || 'IMAGE_MEMORY_POLICY_PENDING_READ_FAILED') };
  }
}

function recordPendingDenial(policyPath, paths, shas, revokedAt) {
  quarantinedPolicies.add(policyPath);
  const directory = pendingDirectory(policyPath);
  const file = `${directory}/${Date.now()}-${process.pid}-${randomUUID()}.json`;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ version: 1, paths, shas, revokedAt })}\n`, { encoding: 'utf8', flag: 'wx' });
    return file;
  } catch (error) {
    unpersistedDenials.add(policyPath);
    throw policyError('image memory pending denial write failed', 'IMAGE_MEMORY_POLICY_PENDING_WRITE_FAILED', error);
  }
}

function readPendingDenial(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.version !== 1 || !Number.isFinite(value.revokedAt) || value.revokedAt < 0 || !Array.isArray(value.paths) || !Array.isArray(value.shas)) throw new Error('invalid');
    return { file, paths: value.paths.map(normalizePath), shas: value.shas.map(normalizeSha), revokedAt: value.revokedAt };
  } catch (error) {
    throw policyError('image memory pending denial is invalid', 'IMAGE_MEMORY_POLICY_PENDING_INVALID', error);
  }
}

function acquirePolicyWriteLock(policyPath) {
  const lockPath = `${policyPath}.lock`;
  const token = randomUUID();
  let descriptor = null;
  mkdirSync(dirname(policyPath), { recursive: true });
  try {
    descriptor = openSync(lockPath, 'wx', 0o600);
    writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }), 'utf8');
    closeSync(descriptor);
    descriptor = null;
  } catch (error) {
    if (descriptor != null) try { closeSync(descriptor); } catch {}
    if (error?.code === 'EEXIST' || (process.platform === 'win32' && error?.code === 'EPERM')) {
      throw policyError('image memory policy lock is busy', 'IMAGE_MEMORY_POLICY_LOCK_BUSY', error);
    }
    throw policyError('image memory policy lock failed', 'IMAGE_MEMORY_POLICY_LOCK_FAILED', error);
  }
  return () => {
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (current.token === token) rmSync(lockPath, { force: true });
    } catch {}
  };
}

function withPolicyWriteLock(policyPath, operation) {
  const release = acquirePolicyWriteLock(policyPath);
  try { return operation(); }
  finally { release(); }
}

async function withPolicyWriteLockAsync(policyPath, operation, lockTimeoutMs = 250) {
  const deadline = Date.now() + Math.max(0, Number(lockTimeoutMs) || 0);
  while (true) {
    try {
      const release = acquirePolicyWriteLock(policyPath);
      try { return operation(); }
      finally { release(); }
    } catch (error) {
      if (error?.code !== 'IMAGE_MEMORY_POLICY_LOCK_BUSY') throw error;
      if (Date.now() >= deadline) throw policyError('image memory policy lock timed out', 'IMAGE_MEMORY_POLICY_LOCK_TIMEOUT', error);
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
  }
}

function atomicWritePolicy(policyPath, value) {
  const temporary = `${policyPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(policyPath), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, policyPath);
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch {}
    throw policyError('image memory policy write failed', 'IMAGE_MEMORY_POLICY_WRITE_FAILED', error);
  }
}

export function revokeImageMemory({ policyPath, relativePaths = [], knownShas = [], revokedAt = Date.now() }) {
  if (!Number.isFinite(revokedAt) || revokedAt < 0) throw policyError('invalid revocation time', 'IMAGE_MEMORY_POLICY_TIME_INVALID');
  const paths = [...new Set(relativePaths.map(normalizePath))].sort();
  const shas = [...new Set(knownShas.map(normalizeSha))].sort();
  recordPendingDenial(policyPath, paths, shas, revokedAt);
  return withPolicyWriteLock(policyPath, () => {
    const result = flushPendingDenialsUnderLock(policyPath);
    return { revision: result.revision, revokedPaths: paths, revokedShas: shas };
  });
}

export async function revokeImageMemoryAsync({ policyPath, relativePaths = [], knownShas = [], revokedAt = Date.now(), lockTimeoutMs = 250 }) {
  if (!Number.isFinite(revokedAt) || revokedAt < 0) throw policyError('invalid revocation time', 'IMAGE_MEMORY_POLICY_TIME_INVALID');
  const paths = [...new Set(relativePaths.map(normalizePath))].sort();
  const shas = [...new Set(knownShas.map(normalizeSha))].sort();
  recordPendingDenial(policyPath, paths, shas, revokedAt);
  return withPolicyWriteLockAsync(policyPath, () => {
    const result = flushPendingDenialsUnderLock(policyPath);
    return { revision: result.revision, revokedPaths: paths, revokedShas: shas };
  }, lockTimeoutMs);
}

export async function recoverPendingImageMemoryPolicy(policyPath, { lockTimeoutMs = 250 } = {}) {
  if (!imageMemoryPolicyStatus(policyPath).paused) return { recovered: false, policy: readImageMemoryPolicy(policyPath) };
  const result = await withPolicyWriteLockAsync(policyPath, () => flushPendingDenialsUnderLock(policyPath), lockTimeoutMs);
  return { recovered: true, ...result };
}

function flushPendingDenialsUnderLock(policyPath) {
  const files = pendingFiles(policyPath);
  let policy = readImageMemoryPolicy(policyPath);
  let changed = false;
  for (const record of files.map(readPendingDenial)) {
    let recordChanged = false;
    for (const path of record.paths) {
      if (policy.paths[path] == null) { policy.paths[path] = record.revokedAt; recordChanged = true; }
    }
    for (const sha of record.shas) {
      if (policy.shas[sha] == null) { policy.shas[sha] = record.revokedAt; recordChanged = true; }
    }
    if (recordChanged) { policy.revision++; changed = true; }
  }
  if (changed) {
    atomicWritePolicy(policyPath, policy);
    policy = readImageMemoryPolicy(policyPath);
  }
  for (const file of files) {
    try { rmSync(file, { force: true }); }
    catch (error) { throw policyError('image memory pending denial cleanup failed', 'IMAGE_MEMORY_POLICY_PENDING_CLEANUP_FAILED', error); }
  }
  try { rmSync(pendingDirectory(policyPath)); } catch {}
  if (pendingFiles(policyPath).length === 0 && !unpersistedDenials.has(policyPath)) quarantinedPolicies.delete(policyPath);
  return { revision: policy.revision, policy };
}
