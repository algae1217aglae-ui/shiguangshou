import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DETECTOR_ASSETS, REGION_V1, verifyDetectorManifest } from './detector-spec.mjs';

const toolDir = dirname(fileURLToPath(import.meta.url));

function samePath(left, right) {
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function assertOwnedRuntimeScope(runtimeDir, rootDir) {
  const root = resolve(rootDir);
  const target = resolve(runtimeDir);
  if (!samePath(target, join(root, 'runtime'))) throw new Error('detector prepare path is outside the owned runtime');
  return { root, target };
}

export function createDetectorRuntimeEnvironment(runtimeDir, baseEnv = process.env) {
  const runtime = resolve(runtimeDir);
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (/^(?:PIP_|UV_(?:INDEX|EXTRA_INDEX|DEFAULT_INDEX|KEYRING|NATIVE_TLS))/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    PORCH_DETECTOR_RUNTIME: runtime,
    PORCH_DETECTOR_NETWORK_DISABLED: '1',
    YOLO_CONFIG_DIR: join(runtime, 'config', 'ultralytics'),
    YOLO_AUTOINSTALL: 'false',
    YOLO_OFFLINE: 'true',
    MPLCONFIGDIR: join(runtime, 'cache', 'matplotlib'),
    TORCH_HOME: join(runtime, 'cache', 'torch'),
    XDG_CACHE_HOME: join(runtime, 'cache'),
    HF_HOME: join(runtime, 'cache', 'huggingface'),
    TRANSFORMERS_CACHE: join(runtime, 'cache', 'huggingface', 'transformers'),
    PYTHONNOUSERSITE: '1',
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_CACHE_DIR: '1',
    PIP_NO_INPUT: '1',
    PIP_REQUIRE_VIRTUALENV: '1',
    PIP_INDEX_URL: 'https://pypi.org/simple',
  };
}

async function assertPlainDirectory(path, label) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link, junction, or reparse point`);
  const resolved = await realpath(path);
  if (!samePath(resolved, path)) throw new Error(`${label} cannot resolve through a symbolic link, junction, or reparse point`);
}

export async function validateDetectorPreparePaths({ runtimeDir = join(toolDir, 'runtime'), tempDir = null, toolRoot = toolDir } = {}) {
  const { root, target } = assertOwnedRuntimeScope(runtimeDir, toolRoot);
  await assertPlainDirectory(root, 'detector tool root');
  if (existsSync(target)) await assertPlainDirectory(target, 'detector runtime');
  let temp = null;
  if (tempDir != null) {
    temp = resolve(tempDir);
    if (!samePath(dirname(temp), root) || !/^runtime\.tmp-\d+-\d+$/.test(basename(temp))) {
      throw new Error('detector prepare temp path is outside the owned runtime sibling range');
    }
    if (existsSync(temp)) await assertPlainDirectory(temp, 'detector prepare temp');
  }
  return { toolRoot: root, runtimeDir: target, tempDir: temp };
}

export async function removeDetectorPrepareTemp(options = {}) {
  const checked = await validateDetectorPreparePaths(options);
  if (!checked.tempDir || !existsSync(checked.tempDir)) return false;
  await assertPlainDirectory(checked.tempDir, 'detector prepare temp');
  await rm(checked.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return true;
}

function argsFrom(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index++) {
    const key = String(argv[index] || '');
    if (!key.startsWith('--')) continue;
    if (['--dry-run', '--json'].includes(key)) out[key.slice(2)] = true;
    else out[key.slice(2)] = argv[++index];
  }
  return out;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function lockedRequirement(wheel) {
  const parts = wheel.name.replace(/\.whl$/i, '').split('-');
  if (parts.length < 5 || !parts[0] || !parts[1]) throw new Error(`cannot derive a locked requirement from ${wheel.name}`);
  return `${parts[0].replaceAll('_', '-')}==${parts[1]} --hash=sha256:${wheel.sha256}`;
}

function command(path, argv, options = {}) {
  return execFileSync(path, argv, { cwd: options.cwd, env: options.env, windowsHide: true, encoding: 'utf8', stdio: options.capture === false ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
}

export function parseDetectorProbeOutput(output) {
  const prefix = 'PORCH_DETECTOR_JSON=';
  const line = String(output || '').split(/\r?\n/).findLast(item => item.startsWith(prefix));
  if (!line) throw new Error('detector package probe did not emit its JSON sentinel');
  return JSON.parse(line.slice(prefix.length));
}

async function download(url, path) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(path, bytes);
  return bytes;
}

export function detectorPreparePlan({ python, runtimeDir = join(toolDir, 'runtime') } = {}) {
  const { target } = assertOwnedRuntimeScope(runtimeDir, toolDir);
  return {
    dryRun: true,
    python,
    runtimeDir: target,
    packages: {
      ultralytics: DETECTOR_ASSETS.ultralytics.version,
      torch: DETECTOR_ASSETS.torch.version,
      torchvision: DETECTOR_ASSETS.torchvision.version,
    },
    model: { name: DETECTOR_ASSETS.weight.name, bytes: DETECTOR_ASSETS.weight.bytes, sha256: DETECTOR_ASSETS.weight.sha256, url: DETECTOR_ASSETS.weight.url },
    actions: ['create-venv', 'download', 'verify-sha256', 'generate-transitive-hash-lock', 'offline-install-require-hashes', 'save-upstream-license', 'warm-import', 'atomic-rename'],
  };
}

export async function prepareDetector({ python, runtimeDir = join(toolDir, 'runtime') } = {}) {
  if (!python) throw new Error('--python is required');
  const { runtimeDir: target } = await validateDetectorPreparePaths({ runtimeDir });
  const existingManifestPath = join(target, 'detector-manifest.json');
  if (existsSync(existingManifestPath)) {
    const existing = JSON.parse(readFileSync(existingManifestPath, 'utf8'));
    verifyDetectorManifest(existing, { runtimeDir: target, verifyFiles: true });
    return { prepared: false, reused: true, manifestPath: existingManifestPath, manifest: existing };
  }
  if (existsSync(target)) throw new Error('detector runtime exists without a verified manifest; move it aside before preparing');
  const version = JSON.parse(command(python, ['-c', 'import json,platform,struct; print(json.dumps({"version":platform.python_version(),"bits":struct.calcsize("P")*8}))']));
  if (!/^3\.12\./.test(version.version) || version.bits !== 64) throw new Error('detector prepare requires 64-bit Python 3.12');
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await validateDetectorPreparePaths({ runtimeDir: target, tempDir: temp });
  const venv = join(temp, '.venv');
  const venvPython = join(venv, 'Scripts', 'python.exe');
  const wheelhouse = join(temp, 'wheelhouse');
  const modelDir = join(temp, 'model');
  const licensesDir = join(temp, 'licenses');
  const finalPython = join(target, '.venv', 'Scripts', 'python.exe');
  const finalWeight = join(target, 'model', DETECTOR_ASSETS.weight.name);
  const finalLicense = join(target, 'licenses', 'ultralytics-LICENSE');
  const runtimeEnv = createDetectorRuntimeEnvironment(temp);
  try {
    await mkdir(wheelhouse, { recursive: true });
    await mkdir(modelDir, { recursive: true });
    await mkdir(licensesDir, { recursive: true });
    for (const path of [runtimeEnv.YOLO_CONFIG_DIR, runtimeEnv.MPLCONFIGDIR, runtimeEnv.TORCH_HOME, runtimeEnv.HF_HOME, runtimeEnv.TRANSFORMERS_CACHE]) await mkdir(path, { recursive: true });
    command(python, ['-m', 'venv', venv], { capture: false, env: runtimeEnv });
    command(venvPython, ['-m', 'pip', 'download', '--only-binary=:all:', '--dest', wheelhouse, '--index-url', 'https://pypi.org/simple', '-r', join(toolDir, 'requirements.direct.txt')], { capture: false, env: runtimeEnv });
    const wheels = readdirSync(wheelhouse).sort().map(name => {
      const path = join(wheelhouse, name);
      return { name, bytes: statSync(path).size, sha256: sha256(path) };
    });
    for (const asset of [DETECTOR_ASSETS.ultralytics, DETECTOR_ASSETS.torch, DETECTOR_ASSETS.torchvision]) {
      const wheel = wheels.find(item => item.name.toLowerCase().startsWith(`${asset.name.replace('-', '_')}-${asset.version}`.toLowerCase()));
      if (!wheel || wheel.bytes !== asset.bytes || wheel.sha256 !== asset.sha256) throw new Error(`${asset.name} wheel does not match pinned size/hash`);
    }
    const lockPath = join(temp, 'requirements-win-py312.lock');
    await writeFile(lockPath, `${wheels.map(lockedRequirement).sort().join('\n')}\n`, 'utf8');
    command(venvPython, ['-m', 'pip', 'install', '--no-index', '--find-links', wheelhouse, '--require-hashes', '-r', lockPath], { capture: false, env: runtimeEnv });
    const weightPath = join(modelDir, DETECTOR_ASSETS.weight.name);
    const weight = await download(DETECTOR_ASSETS.weight.url, weightPath);
    if (weight.length !== DETECTOR_ASSETS.weight.bytes || sha256(weightPath) !== DETECTOR_ASSETS.weight.sha256) throw new Error('YOLO weight does not match pinned size/hash');
    const licensePath = join(licensesDir, 'ultralytics-LICENSE');
    await download('https://raw.githubusercontent.com/ultralytics/ultralytics/main/LICENSE', licensePath);
    if (!/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(readFileSync(licensePath, 'utf8'))) throw new Error('upstream LICENSE verification failed');
    const packages = parseDetectorProbeOutput(command(venvPython, ['-c', 'import json,torch,torchvision,ultralytics; from ultralytics import settings; settings.update({"sync":False}); print("PORCH_DETECTOR_JSON="+json.dumps({"torch":torch.__version__.split("+")[0],"torchvision":torchvision.__version__.split("+")[0],"ultralytics":ultralytics.__version__,"settingsSync":settings.get("sync")}))'], { env: runtimeEnv }));
    if (packages.settingsSync !== false) throw new Error('Ultralytics settings sync must be disabled');
    delete packages.settingsSync;
    const manifest = {
      schemaVersion: 1,
      preparedAt: new Date().toISOString(),
      pythonVersion: version.version,
      pythonPath: finalPython,
      weightPath: finalWeight,
      weightBytes: DETECTOR_ASSETS.weight.bytes,
      weightSha256: DETECTOR_ASSETS.weight.sha256,
      packages,
      wheels,
      licensePath: finalLicense,
      fixedFeatureVersion: REGION_V1.fixedFeatureVersion,
      yoloFeatureVersion: REGION_V1.yoloFeatureVersion,
      onlineSelectionVersion: REGION_V1.onlineSelectionVersion,
    };
    verifyDetectorManifest(manifest, { runtimeDir: target, verifyFiles: false });
    await writeFile(join(temp, 'requirements-win-py312.lock.json'), `${JSON.stringify({ schemaVersion: 1, wheels }, null, 2)}\n`, 'utf8');
    await writeFile(join(temp, 'detector-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await validateDetectorPreparePaths({ runtimeDir: target, tempDir: temp });
    await rename(temp, target);
    verifyDetectorManifest(manifest, { runtimeDir: target, verifyFiles: true });
    return { prepared: true, reused: false, manifestPath: existingManifestPath, manifest };
  } catch (error) {
    await removeDetectorPrepareTemp({ runtimeDir: target, tempDir: temp });
    throw error;
  }
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (args['dry-run']) {
    const plan = detectorPreparePlan({ python: args.python, runtimeDir: args.runtime });
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  if (!args.python) throw new Error('--python is required');
  const result = await prepareDetector({ python: args.python, runtimeDir: args.runtime });
  process.stdout.write(`${JSON.stringify({ prepared: result.prepared, reused: result.reused, manifestPath: result.manifestPath })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
