import readline from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const rl = readline.createInterface({ input: process.stdin });
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const workerArgs = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => index % 2 ? out : [...out, [value.replace(/^--/, ''), all[index + 1]]], []));
process.stderr.write('fixture diagnostic only\n');
let ignoreShutdown = false;

rl.on('line', line => {
  const request = JSON.parse(line);
  const path = request.queries?.[0]?.relativePath || request.sources?.[0]?.relativePath || '';
  if (request.op === 'shutdown' && ignoreShutdown) return;
  if (path.includes('hang')) return;
  if (path.includes('crash')) return process.exit(7);
  if (path.includes('bad-json')) return process.stdout.write('{bad}\n');
  if (request.op.startsWith('source_sync_')) {
    if (request.op === 'source_sync_commit') return setTimeout(() => write({ id: request.id, ok: true, result: { generation: 1 } }), 800);
    return write({ id: request.id, ok: true, result: {} });
  }
  const reply = () => {
    if (request.op === 'stats') {
      const sendStats = () => write({ id: request.id, ok: true, result: { images: 1, occurrences: 2, pendingEmbedding: 0, ...(workerArgs['regions-enabled'] === '1' ? { pendingRegions: 2, regionArgs: { manifest: workerArgs['detector-manifest'], worker: workerArgs['detector-worker'] } } : {}) } });
      if (existsSync(`${workerArgs.db}.generation-race`)) return setTimeout(sendStats, 120);
      return sendStats();
    }
    if (request.op === 'shutdown') { write({ id: request.id, ok: true, result: { shuttingDown: true } }); return process.exit(0); }
    if (request.op === 'index' || request.op === 'backfill') return write({ id: request.id, ok: true, result: { indexed: request.sources.length, unchanged: 0, pendingEmbedding: request.sources.length, ...(workerArgs['regions-enabled'] === '1' ? { pendingRegions: request.sources.length } : {}), failed: 0, codes: [] } });
    if (request.op === 'reconcile') return write({ id: request.id, ok: true, result: { removed: 0 } });
    return write({ id: request.id, ok: true, result: { matches: [{ queryIds: [request.queries[0].queryId], relativePath: 'inbox/old.jpg', sha256: 'a', occurrenceId: 'old', sourceTs: 1, sourceText: '', kind: 'exact', hammingDistance: null, cosine: null, embeddingVersion: null }], warnings: [], channels: { hash: 'ready', visual: 'unavailable' }, ...(path.includes('limits') ? { diagnosticLimits: request.limits } : {}) } });
  };
  if (path.includes('protocol-late-commit')) {
    process.stdout.write('{bad}\n{bad}\n');
    setTimeout(() => { writeFileSync(`${workerArgs.db}.protocol-late-commit`, 'committed'); process.exit(0); }, 350);
    return;
  }
  if (path.includes('read-circuit-late-commit')) {
    setTimeout(() => { writeFileSync(`${workerArgs.db}.read-circuit-late-commit`, 'committed'); process.exit(0); }, 350);
    return;
  }
  if (path.includes('close-input')) {
    reply();
    rl.close(); process.stdin.destroy();
    setTimeout(() => { writeFileSync(`${workerArgs.db}.stdin-late-commit`, 'committed'); process.exit(0); }, 350);
    return;
  }
  if (path.includes('epipe-close')) {
    reply();
    rl.close(); process.stdin.destroy();
    setTimeout(() => process.exit(0), 120);
    return;
  }
  if (path.includes('close-generation-old')) {
    ignoreShutdown = true;
    writeFileSync(`${workerArgs.db}.close-generation-old-ready`, 'ready');
    setTimeout(() => { writeFileSync(`${workerArgs.db}.close-generation-old-commit`, 'committed'); process.exit(0); }, 350);
    return;
  }
  if (path.includes('close-generation-new')) {
    writeFileSync(`${workerArgs.db}.close-generation-new-ready`, 'ready');
    setTimeout(() => { writeFileSync(`${workerArgs.db}.close-generation-new-commit`, 'committed'); process.exit(0); }, 650);
    return;
  }
  if (path.includes('close-late-commit')) {
    ignoreShutdown = true;
    setTimeout(() => { writeFileSync(`${workerArgs.db}.close-late-commit`, 'committed'); process.exit(0); }, 500);
    return;
  }
  if (path.includes('late-commit')) {
    setTimeout(() => { appendFileSync(`${workerArgs.db}.late-commit`, 'committed'); reply(); }, 1000);
    return;
  }
  if (path.includes('late-exit')) {
    setTimeout(() => appendFileSync(`${workerArgs.db}.late-exit`, 'committed'), 60);
    setTimeout(() => process.exit(0), 120);
    return;
  }
  if (path.includes('late-generation')) {
    writeFileSync(`${workerArgs.db}.generation-race`, '1');
    setTimeout(() => process.exit(0), 500);
    return;
  }
  setTimeout(reply, path.includes('slow') ? 25 : 0);
});
