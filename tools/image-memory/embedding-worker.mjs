import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createClipEmbedder } from './embedder.mjs';
import { createImageMemoryRoots, decodeImageMemoryImage, resolveImageMemoryImage } from './image-input.mjs';
import { cropRegionBlobs } from './regions.mjs';
import { immutableRevision } from './prepare-model.mjs';

function modelError(message, code = 'MODEL_UNAVAILABLE', cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code, retryable: true });
}

function loadManifest(path) {
  if (!path || !existsSync(path)) throw modelError('model manifest is missing');
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    immutableRevision(value.revision);
    if (!value.modelId || !value.dtype || !value.embeddingVersion || !value.preprocessVersion) throw new Error('required fields are missing');
    return value;
  } catch (error) {
    if (error?.code === 'MODEL_REVISION_NOT_IMMUTABLE') throw modelError('model manifest revision is not immutable', 'MODEL_UNAVAILABLE', error);
    throw modelError('model manifest is invalid', 'MODEL_UNAVAILABLE', error);
  }
}

export function createEmbeddingWorker({ inboxDir, lifePhotosDir, galleryDir, imageRoots = null, manifestPath, cacheDir, embedderFactory = createClipEmbedder } = {}) {
  const roots = imageRoots || createImageMemoryRoots({ inboxDir, lifePhotosDir, galleryDir });
  const manifest = loadManifest(manifestPath);
  const embedder = embedderFactory({
    modelId: manifest.modelId, revision: manifest.revision, dtype: manifest.dtype,
    cacheDir, localFilesOnly: true,
  });
  if (!embedder || typeof embedder.embed !== 'function') throw modelError('embedder could not be created');
  return {
    async warm() { await embedder.warm?.(); },
    async handle(request) {
      if (request?.op === 'stats') return { loaded: embedder.loaded === true, embeddingVersion: manifest.embeddingVersion };
      if (request?.op === 'shutdown') return { shuttingDown: true };
      if (request.embeddingVersion !== manifest.embeddingVersion) throw modelError('embedding version does not match manifest', 'MODEL_VERSION_MISMATCH');
      if (request?.op === 'embed_regions') {
        if (!/^[0-9a-f]{64}$/i.test(String(request.expectedSha256 || ''))) throw modelError('expected image SHA is invalid', 'PROTOCOL_INVALID_REQUEST');
        if (!Array.isArray(request.descriptors) || request.descriptors.length < 1 || request.descriptors.length > 5) throw modelError('region request must contain one to five descriptors', 'IMAGE_REGION_INVALID');
        const decoded = await decodeImageMemoryImage(request.relativePath, roots);
        if (decoded.sha256 !== request.expectedSha256.toLowerCase()) throw modelError('image changed while region embeddings were prepared', 'IMAGE_CHANGED_DURING_READ');
        const blobs = await cropRegionBlobs(decoded, request.descriptors);
        const embeddings = [];
        for (const bytes of blobs) {
          const vector = await embedder.embed(new Blob([bytes], { type: 'image/png' }));
          embeddings.push([...vector]);
        }
        return { embeddings, embeddingVersion: manifest.embeddingVersion, sourceSha256: decoded.sha256 };
      }
      if (request?.op !== 'embed') throw modelError('unknown embedding operation', 'PROTOCOL_UNKNOWN_OP');
      const image = await resolveImageMemoryImage(request.relativePath, roots);
      const embedding = await embedder.embed(image.absolutePath);
      return { embedding: [...embedding], embeddingVersion: manifest.embeddingVersion };
    },
    get manifest() { return { ...manifest }; },
  };
}

function publicError(error) {
  return { code: String(error?.code || 'MODEL_UNAVAILABLE'), message: String(error?.message || 'embedding failed').replace(/[A-Za-z]:\\[^\s]+|\/[\w./-]+/g, '[path]').slice(0, 200), retryable: error?.retryable !== false };
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) out[String(argv[index] || '').replace(/^--/, '')] = argv[index + 1];
  return out;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const worker = createEmbeddingWorker({ inboxDir: args.inbox, lifePhotosDir: args['life-photos'], galleryDir: args.gallery, manifestPath: args.manifest, cacheDir: args.cache });
  worker.warm().catch(error => process.stderr.write(`[embedding-worker] ${String(error?.code || 'MODEL_UNAVAILABLE')}\n`));
  let buffer = '';
  let chain = Promise.resolve();
  const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 1024 * 1024) {
      buffer = '';
      write({ id: null, ok: false, error: { code: 'PROTOCOL_LINE_TOO_LARGE', message: 'protocol line exceeds one MiB', retryable: false } });
      return;
    }
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      chain = chain.then(async () => {
        let request = null;
        try {
          request = JSON.parse(line);
          if (request.id == null || !['embed', 'embed_regions', 'stats', 'shutdown'].includes(request.op)) throw modelError('invalid embedding request', 'PROTOCOL_INVALID_REQUEST');
          const result = await worker.handle(request);
          write({ id: request.id, ok: true, result });
          if (request.op === 'shutdown') { process.stdin.pause(); setImmediate(() => process.exit(0)); }
        } catch (error) { write({ id: request?.id ?? null, ok: false, error: publicError(error) }); }
      });
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log = (...args) => process.stderr.write(`${args.join(' ')}\n`);
  runCli().catch(error => {
    process.stderr.write(`[embedding-worker] ${String(error?.code || 'MODEL_UNAVAILABLE')}\n`);
    process.exitCode = 1;
  });
}
