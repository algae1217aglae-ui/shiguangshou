import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import * as prepareModule from './prepare-detector.mjs';

const script = fileURLToPath(new URL('./prepare-detector.mjs', import.meta.url));

test('detector prepare dry-run is offline, pinned, and contains no synthetic license acceptance', () => {
  const result = spawnSync(process.execPath, [script, '--dry-run', '--json', '--python', 'C:/Python312/python.exe'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.python, 'C:/Python312/python.exe');
  assert.equal(plan.packages.ultralytics, '8.4.161');
  assert.equal(plan.model.name, 'yolo26n.pt');
  assert.equal(plan.model.sha256, '9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef');
  assert.equal(plan.actions.includes('download'), true);
  assert.equal(plan.actions.includes('offline-install-require-hashes'), true);
  assert.equal(Object.keys(plan).some(key => /accept|enterprise|licenseMode/i.test(key)), false);
});

test('detector prepare refuses a real run without an explicit Python path', () => {
  const result = spawnSync(process.execPath, [script, '--json'], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--python/i);
});

test('detector prepare path guard only accepts the owned runtime and refuses junction cleanup', async () => {
  assert.equal(typeof prepareModule.validateDetectorPreparePaths, 'function');
  assert.equal(typeof prepareModule.removeDetectorPrepareTemp, 'function');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'porch-detector-prepare-paths-')));
  const toolRoot = join(dir, 'tool');
  const outside = join(dir, 'outside');
  const runtimeDir = join(toolRoot, 'runtime');
  const tempDir = join(toolRoot, 'runtime.tmp-123-456');
  mkdirSync(toolRoot);
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  try {
    const valid = await prepareModule.validateDetectorPreparePaths({ runtimeDir, tempDir, toolRoot });
    assert.equal(valid.runtimeDir, runtimeDir);
    assert.equal(valid.tempDir, tempDir);
    await assert.rejects(
      prepareModule.validateDetectorPreparePaths({ runtimeDir: join(dir, 'other-runtime'), toolRoot }),
      /owned runtime/i,
    );

    symlinkSync(outside, runtimeDir, 'junction');
    await assert.rejects(
      prepareModule.validateDetectorPreparePaths({ runtimeDir, toolRoot }),
      /junction|symbolic|reparse/i,
    );
    rmSync(runtimeDir, { recursive: true, force: true });

    symlinkSync(outside, tempDir, 'junction');
    await assert.rejects(
      prepareModule.removeDetectorPrepareTemp({ runtimeDir, tempDir, toolRoot }),
      /junction|symbolic|reparse/i,
    );
    assert.equal(existsSync(join(outside, 'keep.txt')), true);
    rmSync(tempDir, { recursive: true, force: true });

    mkdirSync(tempDir);
    await prepareModule.removeDetectorPrepareTemp({ runtimeDir, tempDir, toolRoot });
    assert.equal(existsSync(tempDir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('detector runtime environment ignores private pip settings and keeps third-party state under runtime', () => {
  assert.equal(typeof prepareModule.createDetectorRuntimeEnvironment, 'function');
  const runtimeDir = resolve(tmpdir(), 'isolated', 'tools', 'image-region', 'runtime.tmp-1-2').replaceAll('\\', '/');
  const env = prepareModule.createDetectorRuntimeEnvironment(runtimeDir, {
    PATH: 'keep-path',
    PIP_INDEX_URL: 'https://private.example/simple',
    PIP_EXTRA_INDEX_URL: 'https://user:secret@private.example/simple',
    PIP_TRUSTED_HOST: 'private.example',
    UV_INDEX_URL: 'https://private.example/simple',
  });
  assert.equal(env.PATH, 'keep-path');
  assert.equal(env.PIP_INDEX_URL, 'https://pypi.org/simple');
  assert.equal(env.PIP_EXTRA_INDEX_URL, undefined);
  assert.equal(env.PIP_TRUSTED_HOST, undefined);
  assert.equal(env.UV_INDEX_URL, undefined);
  assert.equal(env.PIP_DISABLE_PIP_VERSION_CHECK, '1');
  assert.equal(env.PIP_NO_CACHE_DIR, '1');
  assert.equal(env.PIP_CONFIG_FILE, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(env.PORCH_DETECTOR_NETWORK_DISABLED, '1');
  assert.equal(env.YOLO_AUTOINSTALL, 'false');
  assert.equal(env.YOLO_OFFLINE, 'true');
  assert.equal(env.PORCH_DETECTOR_RUNTIME.replaceAll('\\', '/'), runtimeDir);
  for (const key of ['YOLO_CONFIG_DIR', 'MPLCONFIGDIR', 'TORCH_HOME', 'XDG_CACHE_HOME', 'HF_HOME']) {
    assert.equal(env[key].replaceAll('\\', '/').startsWith(`${runtimeDir}/`), true, key);
  }
});

test('detector package probe ignores first-run Ultralytics chatter before its sentinel JSON', () => {
  assert.equal(typeof prepareModule.parseDetectorProbeOutput, 'function');
  assert.deepEqual(
    prepareModule.parseDetectorProbeOutput([
      'Creating new Ultralytics Settings v0.0.6 file',
      'View Ultralytics Settings with yolo settings',
      'PORCH_DETECTOR_JSON={"torch":"2.14.0","torchvision":"0.29.0","ultralytics":"8.4.161","settingsSync":false}',
      '',
    ].join('\n')),
    { torch: '2.14.0', torchvision: '0.29.0', ultralytics: '8.4.161', settingsSync: false },
  );
  assert.throws(() => prepareModule.parseDetectorProbeOutput('Creating new settings only\n'), /sentinel/i);
});
