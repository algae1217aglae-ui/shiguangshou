import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createImageMemoryClient } from '../image-memory.mjs';
import { acquireImageRetentionCleanupFence, withImageRetentionClaim } from '../image-retention-fence.mjs';

const fixtureWorker = fileURLToPath(new URL('./image-memory-worker.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'porch-image-close-epipe-'));
const client = createImageMemoryClient({
  enabled: true,
  workerPath: fixtureWorker,
  cwd: dir,
  inboxDir: join(dir, 'inbox'),
  dbPath: join(dir, 'db.sqlite'),
  policyPath: join(dir, 'policy.json'),
  timeoutMs: 1000,
  closeGraceMs: 10,
  cooldownMs: 0,
  terminationWarningMs: 10,
  terminateProcess: async () => {},
});

async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('bounded wait exceeded');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const runtimeRoot = join(dir, 'data', 'image-retention');
const source = name => ({ occurrenceId: name, queryId: name, relativePath: `inbox/${name}.jpg`, sourceTs: 1, sourceText: '' });
const writer = name => withImageRetentionClaim({ runtimeRoot, relativePath: '__index__' }, () => client.indexBatch([source(name)]));

try {
  const old = writer('close-generation-old');
  await until(() => existsSync(join(dir, 'db.sqlite.close-generation-old-ready')));
  const closing = client.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  const replacement = writer('close-generation-new');
  await until(() => existsSync(join(dir, 'db.sqlite.close-generation-new-ready')));
  await closing;
  await old;
  try {
    const fence = await acquireImageRetentionCleanupFence({ runtimeRoot, timeoutMs: 40, pollMs: 5 });
    await until(() => existsSync(join(dir, 'db.sqlite.close-generation-new-commit')));
    await fence.release();
  } catch (error) {
    if (error.code !== 'RETENTION_FENCE_TIMEOUT') throw error;
  }
  await replacement;
  await client.close();
  process.stdout.write(JSON.stringify({ closed: true }));
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
