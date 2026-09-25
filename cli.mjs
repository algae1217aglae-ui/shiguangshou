#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createImageMemoryClient } from './image-memory.mjs';
import { createImageMemoryBackfillRunner } from './image-memory-backfill.mjs';
import { initializeImageMemoryPolicyAsync, readImageMemoryPolicy } from './image-memory-policy.mjs';
import { revalidateImageRecallForBridge } from './image-memory-chat.mjs';
import { createImageMemoryRoots, normalizeImageMemoryPath } from './tools/image-memory/source-paths.mjs';
import { previewImageRetention } from './image-retention.mjs';
import { executeImageRetention, repairPendingImageRetention } from './image-retention-executor.mjs';
import { withImageRetentionClaims } from './image-retention-fence.mjs';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const help = `拾光獸 (shiguangshou)
node cli.mjs init --root NEW_DIRECTORY
node cli.mjs index --root DIRECTORY [--clip] [--yolo]
node cli.mjs query --root DIRECTORY --image inbox/query.jpg [--before ISO_TIME] [--clip] [--yolo] [--candidates]
node cli.mjs preview --root DIRECTORY
node cli.mjs cleanup --root DIRECTORY --execute
node cli.mjs repair --root DIRECTORY
node cli.mjs revoke --root DIRECTORY --image inbox/photo.jpg
Models must be prepared separately. No server or automatic cleanup is started.
Use the README source formats. Close external writers or use the shared retention fence.`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') { console.log(help); return; }
  if (!['init', 'index', 'query', 'preview', 'cleanup', 'repair', 'revoke'].includes(command)) throw Error('Unknown command; use --help');
  const values = {}, flags = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--clip', '--yolo', '--candidates', '--execute'].includes(arg)) flags.add(arg);
    else if (['--root', '--image', '--before'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) values[arg] = args[++i];
    else throw Error('Unknown or incomplete option; use --help');
  }
  if (!values['--root']) throw Error('--root is required');
  if (command === 'cleanup' && !flags.has('--execute')) throw Error('Cleanup is disabled. Run preview first; --execute explicitly authorizes this one run.');
  const root = resolve(values['--root']);
  const policyPath = join(root, 'policy.json'), runtimeRoot = join(root, 'data', 'image-retention');
  const sources = { historyPath: join(root, 'chat-history.jsonl'), statePath: join(root, 'state.json'), lifePath: join(root, 'life.json'), albumsPath: join(root, 'albums.json') };
  const imageDirs = { inboxDir: join(root, 'inbox'), lifePhotosDir: join(root, 'life-photos'), galleryDir: join(root, 'gallery') };
  const output = result => console.log(JSON.stringify(result));
  if (command === 'init') {
    // mkdir without recursive/exist-ok refuses existing datasets and policies.
    mkdirSync(root);
    for (const directory of [...Object.values(imageDirs), join(root, 'data')]) mkdirSync(directory);
    for (const [file, data] of [[sources.historyPath, ''], [sources.statePath, '{"log":[]}'], [sources.lifePath, '[]'], [sources.albumsPath, '{"albums":[]}']]) writeFileSync(file, data, { flag: 'wx' });
    await initializeImageMemoryPolicyAsync(policyPath);
    output({ initialized: true, cleanupEnabled: false }); return;
  }
  // Never silently recreate missing source files or a lost revocation policy.
  for (const file of Object.values(sources)) readFileSync(file);
  readImageMemoryPolicy(policyPath);
  if (command === 'preview') { output(await previewImageRetention({ root })); return; }
  const clip = flags.has('--clip') || flags.has('--yolo');
  if (flags.has('--candidates') && !clip) throw Error('--candidates requires --clip or --yolo');
  if (clip && !existsSync(join(packageRoot, 'tools/image-memory/model-cache'))) throw Error('MODEL_NOT_PREPARED: prepare CLIP first; see README');
  if (flags.has('--yolo') && !existsSync(join(packageRoot, 'tools/image-region/runtime/detector-manifest.json'))) throw Error('MODEL_NOT_PREPARED: prepare YOLO first; see README');
  const client = createImageMemoryClient({
    enabled: true, cwd: packageRoot, workerPath: join(packageRoot, 'tools/image-memory/worker.mjs'),
    ...imageDirs, dbPath: join(root, 'data', 'index.sqlite'), policyPath,
    timeoutMs: command === 'query' ? 2500 : 10000,
    angleFallbackEnabled: flags.has('--candidates'), regionsEnabled: clip,
    ...(clip ? { manifestPath: join(packageRoot, 'tools/image-memory/model-manifest.json'), cacheDir: join(packageRoot, 'tools/image-memory/model-cache'), embeddingWorkerPath: join(packageRoot, 'tools/image-memory/embedding-worker.mjs') } : {}),
    ...(flags.has('--yolo') ? { detectorManifestPath: join(packageRoot, 'tools/image-region/runtime/detector-manifest.json'), detectorWorkerPath: join(packageRoot, 'tools/image-region/detector-worker.py') } : {}),
  });
  try {
    if (command === 'cleanup') {
      const result = await executeImageRetention({ root, enabled: true, reconcile: () => client.reconcile() });
      output(result); if (result.failedCount || result.pendingRepairCount) process.exitCode = 1;
    } else if (command === 'query') {
      const image = normalizeImageMemoryPath(values['--image']);
      const beforeTs = values['--before'] ? Date.parse(values['--before']) : Date.now();
      if (!Number.isFinite(beforeTs)) throw Error('--before must be an ISO timestamp');
      const deadlineAt = Date.now() + 2500;
      const raw = await client.recallBatch({ queries: [{ queryId: 'cli-query', occurrenceId: 'cli-query', relativePath: image }], beforeTs, deadlineAt });
      const result = await revalidateImageRecallForBridge({ recallResult: raw, beforeTs, deadlineAt, roots: createImageMemoryRoots(imageDirs), policyPath, ...sources, angleFallbackEnabled: flags.has('--candidates') });
      output({ ...result, channels: raw.channels, workerWarnings: raw.warnings });
    } else {
      await withImageRetentionClaims({ runtimeRoot, relativePaths: ['__index__'], kind: 'index' }, async () => {
        if (command === 'index') {
          const result = await createImageMemoryBackfillRunner({ ...sources, ...imageDirs, policyPath, cursorPath: join(root, 'data', 'cursor.json'), client, getFeatureFingerprint: () => `cli-v1:clip=${clip}:yolo=${flags.has('--yolo')}` }).run();
          output(result); if (result.failed || result.issues.length) process.exitCode = 1;
        } else if (command === 'repair') {
          const result = await repairPendingImageRetention({ runtimeRoot, reconcile: () => client.reconcile() });
          output(result); if (result.pending) process.exitCode = 1;
        } else output(await client.revoke([normalizeImageMemoryPath(values['--image'])]));
      });
    }
  } finally { await client.close(); }
}
main().catch(error => { console.error(JSON.stringify({ error: String(error.code || error.message) })); process.exitCode = 1; });
