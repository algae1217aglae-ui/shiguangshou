import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import { createImageMemoryClient } from '../../../image-memory.mjs';

const dir = mkdtempSync(join(tmpdir(), 'porch-image-close-real-'));
const inboxDir = join(dir, 'inbox');
mkdirSync(inboxDir);
const policyPath = join(dir, 'policy.json');
const manifestPath = join(dir, 'manifest.json');
writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
writeFileSync(manifestPath, JSON.stringify({ revision: 'fixture-revision', embeddingVersion: 'fake-v1' }));
const workerPath = fileURLToPath(new URL('../worker.mjs', import.meta.url));
const embeddingWorkerPath = fileURLToPath(new URL('./embedding-worker-path-modes.mjs', import.meta.url));
const client = createImageMemoryClient({ enabled: true, workerPath, embeddingWorkerPath, cwd: dir, inboxDir, dbPath: join(dir, 'index.sqlite'), policyPath, manifestPath, cacheDir: join(dir, 'cache'), timeoutMs: 500 });

try {
  await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(join(inboxDir, 'hang.png'));
  await client.stats();
  await new Promise(resolve => setTimeout(resolve, 300));
  await client.indexBatch([{ occurrenceId: 'hang', relativePath: 'inbox/hang.png', sourceTs: 1, sourceText: '' }]);
  await client.close();
  await client.close();
  process.stdout.write('closed\n');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
