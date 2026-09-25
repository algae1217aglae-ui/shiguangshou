import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const DETECTOR_ASSETS = Object.freeze({
  ultralytics: Object.freeze({
    name: 'ultralytics', version: '8.4.161', bytes: 1455197,
    sha256: '265c39c733aebceec5495cd1e5e0d5f8529d89bbbd8fb60b3d877d41f0bbbe4c',
    url: 'https://pypi.org/project/ultralytics/8.4.161/',
  }),
  torch: Object.freeze({
    name: 'torch', version: '2.14.0', bytes: 124114011,
    sha256: 'cad84f41bbdf3dcf333ce394aeeaf25237c4d94fd6b659ba5eb813c829978823',
  }),
  torchvision: Object.freeze({
    name: 'torchvision', version: '0.29.0', bytes: 1376791,
    sha256: '0e3b99c62f7f095153887330c2c60c9ebc2da84dfbe08eea564a41ec361629cf',
  }),
  weight: Object.freeze({
    name: 'yolo26n.pt', version: 'v8.4.0', bytes: 5544453,
    sha256: '9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef',
    url: 'https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.pt',
  }),
});

export const REGION_V1 = Object.freeze({
  fixedFeatureVersion: 'fixed5-center70-corners65-clip-cada01e72f732ce8f532a8af-v1',
  yoloFeatureVersion: 'yolo26n-v8.4.0-pad15-clip-cada01e72f732ce8f532a8af-v1',
  fixedCropVersion: 'fixed5-center70-corners65-v1',
  onlineSelectionVersion: 'yolo3-then-fixed-fill5-v1',
  onlineMaxRegionsPerQuery: 5,
  onlineMaxYoloRegionsPerQuery: 3,
  detectorVersion: 'ultralytics-8.4.161:yolo26n-v8.4.0:9b09cc8b',
  detectorConfidence: 0.25,
  detectorIou: 0.70,
  detectorImageSize: 640,
  detectorMaxRaw: 20,
  detectorMaxRegions: 5,
  detectorPostNmsIou: 0.85,
  paddingFraction: 0.15,
  minimumCropPixels: 32,
  regionVisualMinScore: 0.88,
  detectorTimeoutMs: 900,
  detectorBackgroundTimeoutMs: 10000,
});

function specError(message, code = 'DETECTOR_MANIFEST_INVALID') {
  return Object.assign(new Error(message), { code, retryable: false });
}

function insideRuntime(path, runtimeDir, field) {
  if (!isAbsolute(path || '')) throw specError(`${field} must be an absolute runtime path`);
  const rel = relative(resolve(runtimeDir), resolve(path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw specError(`${field} must stay inside detector runtime`);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function verifyDetectorManifest(manifest, { runtimeDir, verifyFiles = true } = {}) {
  if (!manifest || manifest.schemaVersion !== 1) throw specError('detector manifest schema is invalid');
  if (!runtimeDir) throw specError('detector runtime is required');
  if (!/^3\.12\./.test(String(manifest.pythonVersion || ''))) throw specError('detector requires Python 3.12');
  insideRuntime(manifest.pythonPath, runtimeDir, 'pythonPath');
  insideRuntime(manifest.weightPath, runtimeDir, 'weightPath');
  insideRuntime(manifest.licensePath, runtimeDir, 'licensePath');
  const packages = manifest.packages || {};
  if (packages.ultralytics !== DETECTOR_ASSETS.ultralytics.version || packages.torch !== DETECTOR_ASSETS.torch.version || packages.torchvision !== DETECTOR_ASSETS.torchvision.version) {
    throw specError('detector package versions do not match the pinned supply chain');
  }
  if (manifest.weightBytes !== DETECTOR_ASSETS.weight.bytes || manifest.weightSha256 !== DETECTOR_ASSETS.weight.sha256) throw specError('detector weight metadata does not match');
  for (const field of ['fixedFeatureVersion', 'yoloFeatureVersion', 'onlineSelectionVersion']) {
    if (manifest[field] !== REGION_V1[field]) throw specError(`${field} does not match detector specification`);
  }
  if (Object.hasOwn(manifest, 'licenseAcceptance') || Object.hasOwn(manifest, 'licenseMode')) throw specError('detector manifest must not record a user license choice');
  if (verifyFiles) {
    if (!existsSync(manifest.pythonPath) || !existsSync(manifest.weightPath) || !existsSync(manifest.licensePath)) throw specError('detector runtime file is missing');
    if (statSync(manifest.weightPath).size !== DETECTOR_ASSETS.weight.bytes || sha256File(manifest.weightPath) !== DETECTOR_ASSETS.weight.sha256) throw specError('detector weight verification failed');
    if (!/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(readFileSync(manifest.licensePath, 'utf8'))) throw specError('upstream detector license notice is missing');
  }
  return manifest;
}
