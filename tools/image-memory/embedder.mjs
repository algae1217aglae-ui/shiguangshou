import { resolve } from 'node:path';

function modelError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: 'MODEL_UNAVAILABLE', retryable: true });
}

export function normalizeEmbedding(value) {
  const source = value instanceof Float32Array ? value : Float32Array.from(value || []);
  if (!source.length) throw modelError('embedding is empty');
  let norm = 0;
  for (const item of source) {
    if (!Number.isFinite(item)) throw modelError('embedding values must be finite');
    norm += item * item;
  }
  norm = Math.sqrt(norm);
  if (!(norm > 0)) throw modelError('embedding cannot be a zero vector');
  const normalized = new Float32Array(source.length);
  for (let index = 0; index < source.length; index++) normalized[index] = source[index] / norm;
  return normalized;
}

export function createClipEmbedder({ modelId, revision, dtype = 'fp32', cacheDir, localFilesOnly = true, pipelineFactory } = {}) {
  let pipelinePromise = null;
  let ready = false;
  const load = () => {
    if (!pipelinePromise) {
      pipelinePromise = (async () => {
        if (pipelineFactory) return pipelineFactory();
        const transformers = await import('@huggingface/transformers');
        transformers.env.allowRemoteModels = localFilesOnly !== true;
        const modelSource = localFilesOnly
          ? resolve(cacheDir, ...String(modelId || '').split('/'), String(revision || ''))
          : modelId;
        const options = {
          revision, dtype, cache_dir: cacheDir, local_files_only: localFilesOnly,
        };
        const extractor = await transformers.pipeline('image-feature-extraction', modelSource, options);
        // transformers.js 4.3 does not list the legacy Xenova CLIP processor in
        // get_pipeline_files(), so the generic pipeline can arrive with processor=null.
        // Load the same pinned processor explicitly while keeping inference in the
        // documented image-feature-extraction pipeline.
        if (typeof extractor.processor !== 'function') extractor.processor = await transformers.AutoProcessor.from_pretrained(modelSource, options);
        return extractor;
      })().then(pipeline => {
        ready = true;
        return pipeline;
      }).catch(error => {
        pipelinePromise = null;
        ready = false;
        throw modelError('CLIP model is unavailable', error);
      });
    }
    return pipelinePromise;
  };
  return {
    async warm() { await load(); },
    async embed(input) {
      try {
        const extractor = await load();
        const output = await extractor(input);
        return normalizeEmbedding(output?.data ?? output?.tolist?.()?.flat?.() ?? output);
      } catch (error) {
        if (error?.code === 'MODEL_UNAVAILABLE') throw error;
        throw modelError('CLIP inference failed', error);
      }
    },
    get loaded() { return ready; },
  };
}
