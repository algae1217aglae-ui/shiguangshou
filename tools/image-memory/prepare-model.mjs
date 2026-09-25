import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MODEL_ID = 'Xenova/clip-vit-base-patch32';
export const PREPROCESS_VERSION = 'clip-center224-v1';

export function immutableRevision(value) {
  const revision = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw Object.assign(new Error('model revision must be an immutable 40-character commit SHA'), { code: 'MODEL_REVISION_NOT_IMMUTABLE' });
  return revision;
}

export function buildModelManifest({ modelId = DEFAULT_MODEL_ID, revision, dtype = 'fp32', libraryVersion, preprocessVersion = PREPROCESS_VERSION }) {
  const stable = {
    modelId: String(modelId || '').trim(),
    revision: immutableRevision(revision),
    dtype: String(dtype || '').trim(),
    libraryVersion: String(libraryVersion || '').trim(),
    preprocessVersion: String(preprocessVersion || '').trim(),
  };
  if (!stable.modelId || !stable.dtype || !stable.libraryVersion || !stable.preprocessVersion) throw Object.assign(new Error('model manifest fields cannot be empty'), { code: 'MODEL_MANIFEST_INVALID' });
  const digest = createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 24);
  return { ...stable, embeddingVersion: `clip-${digest}` };
}

async function defaultResolveRevision(modelId) {
  const encoded = modelId.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://huggingface.co/api/models/${encoded}/revision/main`, { redirect: 'follow' });
  if (!response.ok) throw Object.assign(new Error(`model revision lookup failed (${response.status})`), { code: 'MODEL_REVISION_LOOKUP_FAILED' });
  const body = await response.json();
  return immutableRevision(body?.sha);
}

async function defaultLoadPipeline({ modelId, revision, dtype, cacheDir, localFilesOnly, progressCallback }) {
  const transformers = await import('@huggingface/transformers');
  return transformers.pipeline('image-feature-extraction', modelId, {
    revision, dtype, cache_dir: cacheDir, local_files_only: localFilesOnly, progress_callback: progressCallback,
  });
}

function installedLibraryVersion() {
  const packageJson = new URL('../../node_modules/@huggingface/transformers/package.json', import.meta.url);
  return JSON.parse(readFileSync(packageJson, 'utf8')).version;
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

export async function prepareModel({
  manifestPath, cacheDir, modelId = DEFAULT_MODEL_ID, dtype = 'fp32',
  resolveRevision = defaultResolveRevision, loadPipeline = defaultLoadPipeline,
  libraryVersion = installedLibraryVersion(), progressCallback = null,
} = {}) {
  if (!manifestPath || !cacheDir) throw Object.assign(new Error('manifestPath and cacheDir are required'), { code: 'MODEL_PREPARE_ARGUMENTS' });
  let manifest = null;
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); }
    catch (error) { throw Object.assign(new Error('model manifest is unreadable', { cause: error }), { code: 'MODEL_MANIFEST_INVALID' }); }
    manifest = buildModelManifest(manifest);
  } else {
    const revision = await resolveRevision(modelId);
    manifest = buildModelManifest({ modelId, revision, dtype, libraryVersion, preprocessVersion: PREPROCESS_VERSION });
  }
  await mkdir(cacheDir, { recursive: true });
  const loaded = await loadPipeline({ ...manifest, cacheDir, localFilesOnly: false, progressCallback });
  try { await loaded?.dispose?.(); } catch {}
  await atomicJson(manifestPath, manifest);
  return manifest;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (!name.startsWith('--')) continue;
    out[name.slice(2)] = argv[index + 1];
    index++;
  }
  return out;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const lastProgress = new Map();
  const manifest = await prepareModel({
    manifestPath: resolve(args.manifest || 'model-manifest.json'),
    cacheDir: resolve(args.cache || 'model-cache'),
    modelId: args.model || DEFAULT_MODEL_ID,
    dtype: args.dtype || 'fp32',
    progressCallback: event => {
      const key = String(event?.file || event?.name || 'model');
      const pct = Math.floor(Number(event?.progress || 0));
      if (pct >= (lastProgress.get(key) ?? -10) + 10 || pct === 100) {
        lastProgress.set(key, pct);
        process.stderr.write(`[image-memory-model] ${key} ${pct}%\n`);
      }
    },
  });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCli().catch(error => {
  process.stderr.write(`[image-memory-model] ${String(error?.code || 'MODEL_PREPARE_FAILED')}: ${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
