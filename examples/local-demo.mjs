// SPDX-License-Identifier: AGPL-3.0-only
// Synthetic temporary data only. No server, credentials, photos or models needed.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createImageMemoryClient } from '../image-memory.mjs';
import { initializeImageMemoryPolicyAsync } from '../image-memory-policy.mjs';
import { previewImageRetention } from '../image-retention.mjs';
import { executeImageRetention } from '../image-retention-executor.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'photo-recall-demo-'));
const inboxDir = join(root, 'inbox');
const now = Date.now(), day = 86400000;
let client;
try {
  mkdirSync(inboxDir);
  const pixels = Buffer.alloc(128 * 128 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 13 + Math.floor(i / 128)) % 256;
  await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toFile(join(inboxDir, 'old.png'));
  await sharp({ create: { width: 128, height: 128, channels: 3, background: '#2060dd' } }).png().toFile(join(inboxDir, 'saved.png'));
  copyFileSync(join(inboxDir, 'old.png'), join(inboxDir, 'query.png'));
  const sources = ['old.png', 'saved.png'].map((name, index) => ({
    occurrenceId: `message-${index}`, relativePath: `inbox/${name}`,
    sourceTs: now - 120 * day, sourceText: `Synthetic photo ${index}`,
  }));
  for (const source of sources) utimesSync(join(root, source.relativePath), new Date(now - 200 * day), new Date(now - 200 * day));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ log: sources.map(s => ({ role: 'user', messageId: s.occurrenceId, ts: new Date(s.sourceTs).toISOString(), images: [s.relativePath], text: s.sourceText })) }));
  writeFileSync(join(root, 'chat-history.jsonl'), '');
  writeFileSync(join(root, 'life.json'), '[]');
  writeFileSync(join(root, 'albums.json'), JSON.stringify({ albums: [{ id: 'saved', items: [{ src: 'inbox/saved.png' }] }] }));
  const policyPath = join(root, 'policy.json');
  await initializeImageMemoryPolicyAsync(policyPath);
  client = createImageMemoryClient({
    enabled: true, workerPath: join(packageRoot, 'tools/image-memory/worker.mjs'), cwd: packageRoot,
    inboxDir, dbPath: join(root, 'index.sqlite'), policyPath, timeoutMs: 10000,
  });
  const indexed = await client.indexBatch(sources);
  if (indexed.failed) throw Error('Synthetic indexing failed');
  const recalled = await client.recallBatch({
    queries: [{ queryId: 'query', occurrenceId: 'query', relativePath: 'inbox/query.png' }],
    beforeTs: now, excludeOccurrenceIds: ['query'],
  });
  const preview = await previewImageRetention({ root, now });
  const result = process.argv.includes('--cleanup')
    ? await executeImageRetention({ root, now, enabled: true, reconcile: () => client.reconcile() })
    : { deletedCount: 0, pendingRepairCount: 0 };
  console.log(JSON.stringify({
    recalledKind: recalled.matches[0]?.kind, candidateCount: preview.candidateCount,
    deletedCount: result.deletedCount, pendingRepairCount: result.pendingRepairCount,
    oldChatPhotoExists: existsSync(join(inboxDir, 'old.png')),
    savedPhotoExists: existsSync(join(inboxDir, 'saved.png')),
  }));
} finally {
  await client?.close();
  rmSync(root, { recursive: true, force: true });
}
