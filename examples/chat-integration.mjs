// A complete neutral chat flow. Synthetic data only; no server, model API, or credentials.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createImageMemoryClient } from '../image-memory.mjs';
import { createImageMemoryBackfillRunner } from '../image-memory-backfill.mjs';
import { initializeImageMemoryPolicyAsync } from '../image-memory-policy.mjs';
import { prepareImageRecallBridgeDispatch } from '../image-memory-chat.mjs';
import { createImageMemoryRoots } from '../tools/image-memory/source-paths.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'shiguangshou-chat-'));
const inboxDir = join(root, 'inbox'), policyPath = join(root, 'policy.json');
const paths = { statePath: join(root, 'state.json'), historyPath: join(root, 'chat-history.jsonl'), lifePath: join(root, 'life.json'), albumsPath: join(root, 'albums.json') };
let client;
try {
  mkdirSync(inboxDir);
  await sharp({ create: { width: 128, height: 128, channels: 3, background: '#36a0cc' } }).png().toFile(join(inboxDir, 'past.png'));
  copyFileSync(join(inboxDir, 'past.png'), join(inboxDir, 'query.png'));
  const start = Date.now() - 600000;
  const records = [
    { messageId: 'one', conversationId: 'chat', role: 'assistant', ts: new Date(start).toISOString(), text: 'Here is the earlier conversation.', memorySafe: true },
    { messageId: 'two', conversationId: 'chat', role: 'user', ts: new Date(start + 60000).toISOString(), text: 'A photo I shared.', images: ['inbox/past.png'], memorySafe: true },
    { messageId: 'three', conversationId: 'chat', role: 'user', ts: new Date(start + 120000).toISOString(), text: 'PRIVATE_EXAMPLE', memorySafe: false },
  ];
  writeFileSync(paths.statePath, JSON.stringify({ log: records }));
  writeFileSync(paths.historyPath, ''); writeFileSync(paths.lifePath, '[]'); writeFileSync(paths.albumsPath, '{"albums":[]}');
  await initializeImageMemoryPolicyAsync(policyPath);
  client = createImageMemoryClient({ enabled: true, cwd: packageRoot, workerPath: join(packageRoot, 'tools/image-memory/worker.mjs'), inboxDir, dbPath: join(root, 'index.sqlite'), policyPath });
  // Real source snapshots and SQLite. This example has no cleanup or concurrent writer.
  const indexed = await createImageMemoryBackfillRunner({ ...paths, inboxDir, policyPath, cursorPath: join(root, 'cursor.json'), client }).run();
  if (indexed.failed || indexed.issues.length) throw Error('Example indexing failed');
  const beforeTs = Date.now(), deadlineAt = beforeTs + 2500;
  const recallResult = await client.recallBatch({ queries: [{ queryId: 'now', occurrenceId: 'now', relativePath: 'inbox/query.png' }], beforeTs, deadlineAt });
  const delivery = await prepareImageRecallBridgeDispatch({
    supportsImageAttachments: true, angleFallbackEnabled: true,
    photoPaths: [join(inboxDir, 'query.png')],
    revalidation: { recallResult, beforeTs, deadlineAt, roots: createImageMemoryRoots({ inboxDir }), policyPath, ...paths },
  });
  // Your application can now send delivery.images + delivery.context to its chosen image-capable consumer.
  // This demo only reports the result locally, then removes its own synthetic files.
  console.log(JSON.stringify({
    matchKind: delivery.liveRecall.matches[0]?.kind,
    imageCount: delivery.images.length,
    includesAssistantContext: delivery.context.includes('Here is the earlier conversation.'),
    includesPrivateText: delivery.context.includes('PRIVATE_EXAMPLE'),
  }));
} finally { await client?.close(); rmSync(root, { recursive: true, force: true }); }
