import test from 'node:test';
import assert from 'node:assert/strict';

import { createClipEmbedder, normalizeEmbedding } from './embedder.mjs';

test('normalizeEmbedding returns finite L2-normalized Float32 values', () => {
  const result = normalizeEmbedding([3, 4]);
  assert.ok(result instanceof Float32Array);
  assert.ok(Math.abs(result[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(result[1] - 0.8) < 1e-6);
  assert.throws(() => normalizeEmbedding([0, 0]), /zero/i);
  assert.throws(() => normalizeEmbedding([1, Number.NaN]), /finite/i);
});

test('embedder lazy-loads one pipeline and normalizes concurrent results', async () => {
  let loads = 0;
  const embedder = createClipEmbedder({
    modelId: 'test/model', revision: 'fixed', dtype: 'fp32', cacheDir: 'cache', localFilesOnly: true,
    pipelineFactory: async () => {
      loads++;
      return async input => ({ data: input === 'one' ? [3, 4] : [0, 5] });
    },
  });
  const [one, two] = await Promise.all([embedder.embed('one'), embedder.embed('two')]);
  assert.equal(loads, 1);
  assert.deepEqual([...one], [...new Float32Array([0.6, 0.8])]);
  assert.deepEqual([...two], [0, 1]);
});

test('a failed first pipeline load is cleared so a later request can retry', async () => {
  let loads = 0;
  const embedder = createClipEmbedder({
    modelId: 'test/model', revision: 'fixed', dtype: 'fp32', cacheDir: 'cache', localFilesOnly: true,
    pipelineFactory: async () => {
      loads++;
      if (loads === 1) throw new Error('missing');
      return async () => ({ data: [1, 0] });
    },
  });
  await assert.rejects(embedder.embed('one'), error => error.code === 'MODEL_UNAVAILABLE');
  assert.deepEqual([...(await embedder.embed('one'))], [1, 0]);
  assert.equal(loads, 2);
});
