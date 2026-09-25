import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { collectImageMemoryEntries } from './image-memory.mjs';
import { readAlbumImageSourceSnapshot, readChatImageSourceSnapshot, readLifeImageSourceSnapshot } from './image-memory-sources.mjs';

const EMPTY_COUNTS = { indexed: 0, unchanged: 0, pendingEmbedding: 0, pendingRegions: 0, failed: 0, codes: [] };

function readCursor(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.version !== 1 || !Number.isFinite(value.historyBytes) || !Number.isFinite(value.latestSourceTs) || !Number.isFinite(value.lastFullAt)) return null;
    return value;
  } catch { return null; }
}

async function writeCursor(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value)}\n`, 'utf8');
  await rename(temp, path);
}

export async function prepareCollectedImageMemoryBackfill({ collected, client, sources = collected?.sources || [] }) {
  let preparedSources = [...sources];
  let revokeFailed = false;
  if (collected.denied.length) {
    if (typeof client?.revoke !== 'function') {
      collected.issues.push({ code: 'IMAGE_REVOKE_UNAVAILABLE' });
      revokeFailed = true;
    } else {
      try {
        const revoked = await client.revoke(collected.denied);
        const revokedPaths = new Set(revoked?.revokedPaths || []);
        preparedSources = preparedSources.filter(source => !revokedPaths.has(source.relativePath));
      } catch (error) {
        collected.issues.push({ code: String(error?.code || 'IMAGE_REVOKE_FAILED') });
        revokeFailed = true;
      }
    }
  }
  return { sources: preparedSources, revokeFailed };
}

export function createImageMemoryBackfillRunner({
  historyPath, statePath, lifePath, albumsPath, inboxDir, policyPath, cursorPath, client, getClient,
  collect = collectImageMemoryEntries, now = Date.now, fullIntervalMs = 24 * 3600000,
  getFeatureFingerprint = () => 'image-memory-whole-v1',
} = {}) {
  if (!getClient && (!client || typeof client.backfill !== 'function' || typeof client.reconcile !== 'function')) throw new TypeError('backfill client is required');
  return {
    async run() {
      const activeClient = getClient ? getClient() : client;
      if (!activeClient || typeof activeClient.backfill !== 'function' || typeof activeClient.reconcile !== 'function') throw new TypeError('backfill client is required');
      const startedAt = now();
      const prior = readCursor(cursorPath);
      const featureFingerprint = String(await getFeatureFingerprint());
      let historyBytes = 0;
      try { historyBytes = (await stat(historyPath)).size; } catch {}
      const full = !prior || historyBytes < prior.historyBytes || prior.featureFingerprint !== featureFingerprint || startedAt - prior.lastFullAt >= fullIntervalMs;
      const collected = await collect({
        historyPath, statePath, inboxDir, policyPath,
        historyStart: full ? 0 : prior.historyBytes,
        stateAfterTs: full ? null : prior.latestSourceTs,
      });
      const prepared = await prepareCollectedImageMemoryBackfill({ collected, client: activeClient });
      const sources = prepared.sources;
      const { revokeFailed } = prepared;
      let sourceSynced = 0;
      let chatCursor = prior?.chatCursor || null;
      if (typeof activeClient.syncSourceSnapshot === 'function') {
        let sourceBases = new Map();
        if (typeof activeClient.stats === 'function') {
          try {
            const stats = await activeClient.stats();
            sourceBases = new Map((Array.isArray(stats?.sourceSnapshots) ? stats.sourceSnapshots : [])
              .map(row => [row.sourceType, { generation: Number(row.generation), revision: row.revision ?? null }]));
          } catch (error) {
            collected.issues.push({ code: String(error?.code || 'IMAGE_SOURCE_BASELINE_FAILED') });
          }
        }
        const chatSnapshot = readChatImageSourceSnapshot({ historyPath, statePath, cursor: prior?.chatCursor || null });
        const snapshots = [
          chatSnapshot,
          ...(lifePath ? [readLifeImageSourceSnapshot(lifePath)] : []),
          ...(albumsPath ? [readAlbumImageSourceSnapshot(albumsPath)] : []),
        ];
        for (const snapshot of snapshots) {
          if (snapshot.status !== 'complete') {
            collected.issues.push(snapshot.issue || { code: 'IMAGE_SOURCE_UNREADABLE', sourceType: snapshot.sourceType });
            continue;
          }
          try {
            await activeClient.syncSourceSnapshot({ ...snapshot, base: sourceBases.get(snapshot.sourceType) || { generation: 0, revision: null } });
            sourceSynced++;
            if (snapshot.sourceType === 'chat') chatCursor = snapshot.cursor;
          }
          catch (error) { collected.issues.push({ code: String(error?.code || 'IMAGE_SOURCE_SYNC_FAILED'), sourceType: snapshot.sourceType }); }
        }
      }
      let counts = sources.length ? await activeClient.backfill(sources) : { ...EMPTY_COUNTS };
      if (typeof activeClient.stats === 'function') {
        try {
          const finalStats = await activeClient.stats();
          counts = {
            ...counts,
            ...(Number.isFinite(finalStats?.pendingEmbedding) ? { pendingEmbedding: Number(finalStats.pendingEmbedding) } : {}),
            ...(Number.isFinite(finalStats?.pendingRegions) ? { pendingRegions: Number(finalStats.pendingRegions) } : {}),
          };
        } catch (error) {
          collected.issues.push({ code: String(error?.code || 'IMAGE_SOURCE_STATS_FAILED') });
        }
      }
      const processed = Number(counts.indexed || 0) + Number(counts.unchanged || 0) + Number(counts.failed || 0);
      const cursorAdvanced = processed === sources.length && counts.failed === 0 && counts.pendingEmbedding === 0 && Number(counts.pendingRegions || 0) === 0 && collected.issues.length === 0 && !revokeFailed;
      if (full) await activeClient.reconcile();
      if (cursorAdvanced) {
        const next = {
          version: 1,
          historyBytes: Number.isFinite(collected.cursor?.historyBytes) ? collected.cursor.historyBytes : historyBytes,
          latestSourceTs: Math.max(prior?.latestSourceTs || 0, collected.cursor?.latestSourceTs || 0),
          lastFullAt: full ? startedAt : prior.lastFullAt,
          featureFingerprint,
          chatCursor,
          updatedAt: startedAt,
        };
        await writeCursor(cursorPath, next);
      }
      return { ...counts, selected: sources.length, denied: collected.denied.length, issues: collected.issues, sourceSynced, full, cursorAdvanced, retryAfterMs: cursorAdvanced ? null : 60000 };
    },
  };
}
