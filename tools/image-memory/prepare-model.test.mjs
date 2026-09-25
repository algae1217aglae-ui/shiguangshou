import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildModelManifest, prepareModel } from './prepare-model.mjs';

const REVISION = '0123456789abcdef0123456789abcdef01234567';

test('manifest requires an immutable revision and changes version with model inputs', () => {
  assert.throws(() => buildModelManifest({ modelId: 'Xenova/clip-vit-base-patch32', revision: 'main', dtype: 'fp32', libraryVersion: '4.3.0' }), /immutable/i);
  const one = buildModelManifest({ modelId: 'Xenova/clip-vit-base-patch32', revision: REVISION, dtype: 'fp32', libraryVersion: '4.3.0' });
  const two = buildModelManifest({ modelId: 'Xenova/clip-vit-base-patch32', revision: REVISION, dtype: 'q8', libraryVersion: '4.3.0' });
  assert.equal(one.preprocessVersion, 'clip-center224-v1');
  assert.match(one.embeddingVersion, /^clip-[a-f0-9]{24}$/);
  assert.notEqual(one.embeddingVersion, two.embeddingVersion);
});

test('prepare command resolves once, warms the exact revision, and reproduces its manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-prepare-model-'));
  const manifestPath = join(dir, 'model-manifest.json');
  const cacheDir = join(dir, 'cache');
  const loads = [];
  let resolves = 0;
  try {
    const first = await prepareModel({
      manifestPath, cacheDir,
      resolveRevision: async () => { resolves++; return REVISION; },
      loadPipeline: async options => { loads.push(options); return { dispose: async () => {} }; },
      libraryVersion: '4.3.0',
    });
    const second = await prepareModel({
      manifestPath, cacheDir,
      resolveRevision: async () => { resolves++; return 'f'.repeat(40); },
      loadPipeline: async options => { loads.push(options); return null; },
      libraryVersion: '4.3.0',
    });
    assert.equal(resolves, 1);
    assert.equal(loads.length, 2);
    assert.equal(loads[0].revision, REVISION);
    assert.equal(loads[0].localFilesOnly, false);
    assert.equal(second.embeddingVersion, first.embeddingVersion);
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')), first);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
