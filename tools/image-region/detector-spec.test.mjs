import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DETECTOR_ASSETS,
  REGION_V1,
  verifyDetectorManifest,
} from './detector-spec.mjs';

test('detector supply chain pins official versions, bytes, hashes, and selection versions', () => {
  assert.equal(DETECTOR_ASSETS.ultralytics.version, '8.4.161');
  assert.equal(DETECTOR_ASSETS.ultralytics.bytes, 1455197);
  assert.equal(DETECTOR_ASSETS.ultralytics.sha256, '265c39c733aebceec5495cd1e5e0d5f8529d89bbbd8fb60b3d877d41f0bbbe4c');
  assert.equal(DETECTOR_ASSETS.ultralytics.url, 'https://pypi.org/project/ultralytics/8.4.161/');
  assert.equal(DETECTOR_ASSETS.torch.version, '2.14.0');
  assert.equal(DETECTOR_ASSETS.torchvision.version, '0.29.0');
  assert.equal(DETECTOR_ASSETS.weight.name, 'yolo26n.pt');
  assert.equal(DETECTOR_ASSETS.weight.bytes, 5544453);
  assert.equal(DETECTOR_ASSETS.weight.sha256, '9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef');
  assert.equal(REGION_V1.onlineSelectionVersion, 'yolo3-then-fixed-fill5-v1');
  assert.equal(REGION_V1.onlineMaxRegionsPerQuery, 5);
  assert.equal(REGION_V1.onlineMaxYoloRegionsPerQuery, 3);
  assert.notEqual(REGION_V1.fixedFeatureVersion, REGION_V1.yoloFeatureVersion);
});

test('detector manifest is tool-owned, exact, and contains upstream notice metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-detector-spec-'));
  const runtimeDir = join(dir, 'runtime');
  mkdirSync(runtimeDir);
  const pythonPath = join(runtimeDir, '.venv', 'Scripts', 'python.exe');
  const weightPath = join(runtimeDir, 'model', 'yolo26n.pt');
  const licensePath = join(runtimeDir, 'licenses', 'ultralytics-LICENSE');
  mkdirSync(join(runtimeDir, '.venv', 'Scripts'), { recursive: true });
  mkdirSync(join(runtimeDir, 'model'), { recursive: true });
  mkdirSync(join(runtimeDir, 'licenses'), { recursive: true });
  writeFileSync(pythonPath, 'python');
  writeFileSync(weightPath, 'weight');
  writeFileSync(licensePath, 'GNU AFFERO GENERAL PUBLIC LICENSE');
  const manifest = {
    schemaVersion: 1,
    pythonVersion: '3.12.14',
    pythonPath,
    weightPath,
    weightBytes: DETECTOR_ASSETS.weight.bytes,
    weightSha256: DETECTOR_ASSETS.weight.sha256,
    packages: { ultralytics: '8.4.161', torch: '2.14.0', torchvision: '0.29.0' },
    licensePath,
    fixedFeatureVersion: REGION_V1.fixedFeatureVersion,
    yoloFeatureVersion: REGION_V1.yoloFeatureVersion,
    onlineSelectionVersion: REGION_V1.onlineSelectionVersion,
  };
  try {
    assert.deepEqual(verifyDetectorManifest(manifest, { runtimeDir, verifyFiles: false }), manifest);
    assert.throws(() => verifyDetectorManifest({ ...manifest, pythonVersion: '3.11.9' }, { runtimeDir, verifyFiles: false }), /Python 3\.12/i);
    assert.throws(() => verifyDetectorManifest({ ...manifest, weightSha256: '0'.repeat(64) }, { runtimeDir, verifyFiles: false }), /weight/i);
    assert.throws(() => verifyDetectorManifest({ ...manifest, pythonPath: join(dir, 'outside.exe') }, { runtimeDir, verifyFiles: false }), /runtime/i);
    assert.throws(() => verifyDetectorManifest({ ...manifest, licensePath: join(dir, 'outside-license') }, { runtimeDir, verifyFiles: false }), /runtime|license/i);
    assert.equal(Object.hasOwn(manifest, 'licenseAcceptance'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
