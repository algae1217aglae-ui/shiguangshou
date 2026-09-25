import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { acquireImageRetentionCleanupFence } from './image-retention-fence.mjs';
import {
  imageRetentionRuntimeFile, readImageRetentionRuntimeFile, writeImageRetentionRuntimeFileAtomic,
} from './image-retention-runtime.mjs';
import {
  collectRetentionEvidence, IMAGE_RETENTION_DAYS, readImageFileIdentity, sameFileIdentity,
} from './image-retention.mjs';

function executorError(code, message = code) {
  const error = new Error(`${code}: ${message}`); error.code = code; return error;
}

function markerPath(runtimeRoot) { return imageRetentionRuntimeFile(runtimeRoot, 'reconcile-pending.json'); }

function atomicMarker(runtimeRoot, value) {
  writeImageRetentionRuntimeFileAtomic(runtimeRoot, 'reconcile-pending.json', JSON.stringify(value));
}

function readMarker(runtimeRoot) {
  try {
    const value = JSON.parse(readImageRetentionRuntimeFile(runtimeRoot, 'reconcile-pending.json'));
    if (!value || value.pending !== true) return { pending: true, corrupt: true };
    return { ...value, corrupt: false };
  } catch (error) {
    if (error?.code === 'RETENTION_RUNTIME_UNSAFE') throw error;
    if (error?.code === 'ENOENT') return null;
    return { pending: true, corrupt: true };
  }
}

export function inspectPendingImageRetention({ runtimeRoot } = {}) {
  const marker = readMarker(runtimeRoot);
  return marker ? { pending: true, corrupt: marker.corrupt === true } : { pending: false, corrupt: false };
}

function clearMarker(runtimeRoot) { try { unlinkSync(markerPath(runtimeRoot)); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }

export async function repairPendingImageRetention({ runtimeRoot, reconcile } = {}) {
  const marker = readMarker(runtimeRoot);
  if (!marker) return { pending: false, repaired: false };
  try {
    const result = await reconcile();
    if (!result || result.paused === true) return { pending: true, repaired: false, reason: 'policy_paused' };
    clearMarker(runtimeRoot);
    return { pending: false, repaired: true, wasCorrupt: marker.corrupt === true, removed: Number(result.removed) || 0 };
  } catch (error) {
    return { pending: true, repaired: false, reason: String(error?.code || error?.message || error) };
  }
}

export async function executeImageRetention({
  root, runtimeRoot = join(root, 'data', 'image-retention'), now = Date.now(), days = IMAGE_RETENTION_DAYS,
  enabled = false, maxCandidates = 100, timeoutMs = 5000, beforeCandidate, reconcile,
  unlinkFile = unlinkSync,
} = {}) {
  if (enabled !== true) throw executorError('RETENTION_DISABLED');
  if (days !== IMAGE_RETENTION_DAYS) throw executorError('RETENTION_DAYS_INVALID');
  if (typeof reconcile !== 'function') throw executorError('RETENTION_RECONCILE_REQUIRED');
  const fence = await acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs });
  let deletedCount = 0, failedCount = 0, skippedChangedCount = 0;
  let markerWasPending = !!readMarker(runtimeRoot);
  try {
    const evidence = await collectRetentionEvidence({ root, now, days, maxCandidates });
    for (const candidate of evidence.candidates) {
      await new Promise(resolveImmediate => setImmediate(resolveImmediate));
      await beforeCandidate?.(candidate);
      const fresh = await collectRetentionEvidence({ root, now, days, maxCandidates });
      const current = fresh.candidates.find(row => row.relativePath === candidate.relativePath);
      if (!current || !sameFileIdentity(current.identity, candidate.identity)) { skippedChangedCount++; continue; }
      let finalIdentity;
      try { finalIdentity = readImageFileIdentity(candidate.absolutePath); }
      catch { skippedChangedCount++; continue; }
      if (!sameFileIdentity(finalIdentity, candidate.identity)) { skippedChangedCount++; continue; }
      if (!markerWasPending && deletedCount === 0) {
        atomicMarker(runtimeRoot, { version: 1, pending: true, count: 1, createdAt: new Date().toISOString() });
      }
      try {
        unlinkFile(candidate.absolutePath);
        deletedCount++;
        atomicMarker(runtimeRoot, { version: 1, pending: true, count: deletedCount, updatedAt: new Date().toISOString() });
      } catch {
        failedCount++;
        if (!markerWasPending && deletedCount === 0) clearMarker(runtimeRoot);
      }
    }
    let synchronizedCount = 0;
    if (deletedCount > 0 || markerWasPending) {
      const repair = await repairPendingImageRetention({ runtimeRoot, reconcile });
      if (repair.repaired) synchronizedCount = deletedCount;
    }
    const pending = readMarker(runtimeRoot);
    return {
      mode: 'execute', days, deletedCount, failedCount, skippedChangedCount, synchronizedCount,
      pendingRepairCount: pending ? Math.max(1, Number(pending.count) || 1) : 0,
    };
  } finally {
    await fence.release();
  }
}
