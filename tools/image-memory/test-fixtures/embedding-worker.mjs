import readline from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => index % 2 ? out : [...out, [value.replace(/^--/, ''), all[index + 1]]], []));
const mode = args.mode || 'good';
let active = 0;
const lines = readline.createInterface({ input: process.stdin });
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.op === 'stats') return write({ id: request.id, ok: true, result: { loaded: mode !== 'warming', embeddingVersion: 'v1' } });
  if (request.op === 'shutdown') { write({ id: request.id, ok: true, result: { shuttingDown: true } }); return process.exit(0); }
  if (mode === 'hang') return;
  if (mode === 'hang-once' && !existsSync(args.marker)) { writeFileSync(args.marker, 'hung'); return; }
  if (mode === 'crash') return process.exit(17);
  if (mode === 'missing') return write({ id: request.id, ok: false, error: { code: 'MODEL_UNAVAILABLE', message: 'missing', retryable: true } });
  active++;
  if (active > 1) return write({ id: request.id, ok: false, error: { code: 'CONCURRENT', message: 'too many', retryable: false } });
  const result = request.op === 'embed_regions'
    ? { embeddings: request.descriptors.map((_, index) => [index === 0 ? 1 : 0, index === 0 ? 0 : 1]), sourceSha256: request.expectedSha256, embeddingVersion: 'v1' }
    : { embedding: [1, 0], embeddingVersion: 'v1' };
  setTimeout(() => { active--; write({ id: request.id, ok: true, result }); }, mode === 'slow' ? 30 : 5);
});
