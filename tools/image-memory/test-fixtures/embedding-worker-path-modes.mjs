import readline from 'node:readline';

const lines = readline.createInterface({ input: process.stdin });
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);

lines.on('line', line => {
  const request = JSON.parse(line);
  if (request.op === 'stats') return write({ id: request.id, ok: true, result: { loaded: true, embeddingVersion: 'fake-v1' } });
  if (request.op === 'shutdown') { write({ id: request.id, ok: true, result: { shuttingDown: true } }); return process.exit(0); }
  if (String(request.relativePath || '').includes('hang')) return;
  write({ id: request.id, ok: true, result: { embedding: [1, 0], embeddingVersion: 'fake-v1' } });
});
