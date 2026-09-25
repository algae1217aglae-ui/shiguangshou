import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const run = (...args) => JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true }));

test('CLI initializes only a new explicit directory and refuses reinitialization', () => {
  const parent = mkdtempSync(join(tmpdir(), 'shiguangshou-cli-')), root = join(parent, 'photos');
  try {
    assert.equal(run('init', '--root', root).initialized, true);
    const policy = readFileSync(join(root, 'policy.json'), 'utf8');
    assert.notEqual(spawnSync(process.execPath, [cli, 'init', '--root', root], { windowsHide: true }).status, 0);
    assert.equal(readFileSync(join(root, 'policy.json'), 'utf8'), policy);
    assert.notEqual(spawnSync(process.execPath, [cli, 'index'], { windowsHide: true }).status, 0);
    const missingModel = spawnSync(process.execPath, [cli, 'index', '--root', root, '--yolo'], { windowsHide: true, encoding: 'utf8' });
    assert.notEqual(missingModel.status, 0);
    assert.match(missingModel.stderr, /MODEL_NOT_PREPARED/);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('CLI indexes and recalls its own dataset, previews by default and protects saved photos on explicit cleanup', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'shiguangshou-cli-')), root = join(parent, 'photos');
  try {
    run('init', '--root', root);
    const now = Date.now(), old = now - 120 * 86400000;
    for (const [name, background] of [['old.png', 'red'], ['saved.png', 'blue']]) {
      await sharp({ create: { width: 128, height: 128, channels: 3, background } }).png().toFile(join(root, 'inbox', name));
      utimesSync(join(root, 'inbox', name), new Date(old), new Date(old));
    }
    copyFileSync(join(root, 'inbox', 'old.png'), join(root, 'inbox', 'query.png'));
    writeFileSync(join(root, 'state.json'), JSON.stringify({ log: ['old.png', 'saved.png'].map((name, i) => ({ messageId: `m${i}`, conversationId: 'c', role: 'user', ts: new Date(old).toISOString(), text: 'Synthetic image', images: [`inbox/${name}`] })) }));
    writeFileSync(join(root, 'albums.json'), JSON.stringify({ albums: [{ id: 'a', items: [{ id: 'i', src: 'inbox/saved.png', addedAt: new Date(old).toISOString() }] }] }));
    const indexed = run('index', '--root', root);
    assert.equal(indexed.failed, 0);
    assert.equal(indexed.sourceSynced, 3);
    assert.equal(run('query', '--root', root, '--image', 'inbox/query.png').matches[0].kind, 'exact');
    assert.equal(run('preview', '--root', root).candidateCount, 1);
    assert.notEqual(spawnSync(process.execPath, [cli, 'cleanup', '--root', root], { windowsHide: true }).status, 0);
    assert.equal(existsSync(join(root, 'inbox', 'old.png')), true);
    assert.equal(run('cleanup', '--root', root, '--execute').deletedCount, 1);
    assert.equal(existsSync(join(root, 'inbox', 'saved.png')), true);
    assert.equal(existsSync(join(root, 'inbox', 'query.png')), true);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
