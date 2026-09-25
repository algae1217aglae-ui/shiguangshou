import { dirname } from 'node:path';
import { createRequestParser } from '../protocol.mjs';
import { createEmbeddingProcessClient } from '../embedding-process.mjs';
import { createImageMemoryWorker } from '../worker.mjs';
import { REGION_V1 } from '../../image-region/detector-spec.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => index % 2 ? out : [...out, [value.replace(/^--/, ''), all[index + 1]]], []));
const embeddingClient = createEmbeddingProcessClient({
  workerPath: args['embedding-worker'], inboxDir: args.inbox, lifePhotosDir: args['life-photos'], galleryDir: args.gallery,
  manifestPath: args.manifest, cacheDir: args.cache, cwd: dirname(args['embedding-worker']), embeddingVersion: 'v1', pollMs: 10,
});
const detectorClient = {
  ready: true,
  stats: () => ({ ready: true, queued: 0 }),
  detect: async () => ({ detectorVersion: REGION_V1.detectorVersion, rawDetectionCount: 0, orientedWidth: 1, orientedHeight: 1, detections: [] }),
  close: async () => {},
};
const worker = createImageMemoryWorker({
  inboxDir: args.inbox, lifePhotosDir: args['life-photos'], galleryDir: args.gallery,
  dbPath: args.db, policyPath: args.policy, embeddingVersion: 'v1', embeddingClient,
  regionConfig: REGION_V1, detectorClient,
  embedRegions: async (_relativePath, descriptors) => descriptors.map((_, index) => {
    const vector = new Float32Array(512);
    vector[index % vector.length] = 1;
    return vector;
  }),
});
let chain = Promise.resolve();
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const parser = createRequestParser({
  onRequest(request) {
    chain = chain.then(async () => {
      try {
        const result = await worker.handle({ ...request, receivedAt: Date.now() });
        write({ id: request.id, ok: true, result });
        if (request.op === 'shutdown') {
          await worker.close();
          process.stdin.pause();
          setImmediate(() => process.exit(0));
        }
      } catch (error) {
        write({ id: request.id, ok: false, error: { code: String(error?.code || 'IMAGE_WORKER_FAILED'), message: String(error?.message || 'failed'), retryable: error?.retryable === true } });
      }
    });
  },
  onError: write,
});
process.stdin.on('data', chunk => parser.push(chunk));
process.stdin.on('end', () => parser.end());
