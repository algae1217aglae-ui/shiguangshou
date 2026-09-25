import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { prepareModel } from './tools/image-memory/prepare-model.mjs';
import { formatImageRecallData } from './image-memory-context.mjs';

test('public model preparation resolves dependencies from the standalone package', async () => {
  const root = mkdtempSync(join(tmpdir(), 'photo-recall-package-test-'));
  try {
    const result = await prepareModel({
      manifestPath: join(root, 'manifest.json'), cacheDir: join(root, 'cache'),
      resolveRevision: async () => 'a'.repeat(40), loadPipeline: async () => ({ dispose() {} }),
    });
    assert.equal(result.libraryVersion, '4.3.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('public context uses generic speaker labels', () => {
  const text = formatImageRecallData([{
    relativePath: 'inbox/synthetic.png', sha256: 'a'.repeat(64),
    context: [{ sourceTs: 1, author: 'user', text: 'synthetic message', contextKind: 'photo', locator: { confidence: 'exact' } }],
  }]);
  assert.match(text, /使用者/);
});

for (const enabled of [false, true]) test(`standalone demo recalls a synthetic image; cleanup enabled=${enabled}`, () => {
  const script = fileURLToPath(new URL('./examples/local-demo.mjs', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [script, ...(enabled ? ['--cleanup'] : [])], { encoding: 'utf8', timeout: 20000, windowsHide: true }));
  assert.equal(result.recalledKind, 'exact');
  assert.equal(result.candidateCount, 1);
  assert.equal(result.deletedCount, enabled ? 1 : 0);
  assert.equal(result.savedPhotoExists, true);
  assert.equal(result.oldChatPhotoExists, !enabled);
  assert.equal(result.pendingRepairCount, 0);
});

test('minimal neutral chat integration indexes, recalls and validates image plus context', () => {
  const script = fileURLToPath(new URL('./examples/chat-integration.mjs', import.meta.url));
  const result = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 20000, windowsHide: true }));
  assert.equal(result.matchKind, 'exact');
  assert.equal(result.imageCount, 2);
  assert.equal(result.includesAssistantContext, true);
  assert.equal(result.includesPrivateText, false);
});
