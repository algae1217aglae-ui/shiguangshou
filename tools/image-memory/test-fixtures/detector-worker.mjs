import readline from 'node:readline';
import { resolve, sep } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => index % 2 ? out : [...out, [value.replace(/^--/, ''), all[index + 1]]], []));
const mode = args.mode || 'good';
const runtime = args.runtime ? resolve(args.runtime) : '';
const envContractOk = runtime
  && resolve(process.env.PORCH_DETECTOR_RUNTIME || '') === runtime
  && resolve(process.env.YOLO_CONFIG_DIR || '').startsWith(`${runtime}${sep}`)
  && process.env.YOLO_AUTOINSTALL === 'false'
  && process.env.YOLO_OFFLINE === 'true'
  && process.env.PIP_INDEX_URL === 'https://pypi.org/simple'
  && !process.env.PIP_EXTRA_INDEX_URL
  && !process.env.PIP_TRUSTED_HOST
  && !process.env.UV_INDEX_URL;
const lines = readline.createInterface({ input: process.stdin });
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.op === 'stats') return write({ id: request.id, ok: true, result: { loaded: mode !== 'warming' && (mode !== 'env-contract' || envContractOk), detectorVersion: 'detector-v1' } });
  if (request.op === 'shutdown') { write({ id: request.id, ok: true, result: { shuttingDown: true } }); return process.exit(0); }
  if (mode === 'hang') return;
  if (mode === 'crash') return process.exit(19);
  if (mode === 'crash-resource') {
    process.stderr.write('RuntimeError: out of memory while opening C:\\private\\photo.jpg\n');
    return process.exit(23);
  }
  if (mode === 'malformed') return process.stdout.write('not-json\n');
  if (mode === 'missing') return write({ id: request.id, ok: false, error: { code: 'DETECTOR_UNAVAILABLE', message: 'missing', retryable: true } });
  const result = {
    detectorVersion: 'detector-v1', rawDetectionCount: 1, orientedWidth: 640, orientedHeight: 480,
    detections: [{ bbox: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, classId: 41, className: 'cup', confidence: 0.9 }],
  };
  setTimeout(() => write({ id: request.id, ok: true, result }), mode === 'medium' ? 150 : mode === 'slow' ? 30 : 1);
});
