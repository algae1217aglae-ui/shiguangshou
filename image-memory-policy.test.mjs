import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

import { filterImageMemoryMatchesByPolicy, initializeImageMemoryPolicy, readImageMemoryPolicy, revokeImageMemory } from './image-memory-policy.mjs';

test('missing and damaged image memory policies fail closed with explicit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-'));
  try {
    const missing = join(dir, 'missing.json');
    assert.throws(() => readImageMemoryPolicy(missing), error => error.code === 'IMAGE_MEMORY_POLICY_MISSING');
    const damaged = join(dir, 'damaged.json');
    mkdirSync(damaged);
    assert.throws(() => readImageMemoryPolicy(damaged), error => error.code === 'IMAGE_MEMORY_POLICY_INVALID');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('revocation is atomic, persistent, and idempotent across index rebuilds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-'));
  const policyPath = join(dir, 'policy.json');
  try {
    initializeImageMemoryPolicy(policyPath);
    const first = revokeImageMemory({
      policyPath,
      relativePaths: ['/inbox/a.jpg', 'inbox/a.jpg'],
      knownShas: ['A'.repeat(64)],
      revokedAt: 1000,
    });
    assert.deepEqual(first.revokedPaths, ['inbox/a.jpg']);
    assert.deepEqual(first.revokedShas, ['a'.repeat(64)]);
    assert.equal(first.revision, 1);

    const again = revokeImageMemory({
      policyPath,
      relativePaths: ['inbox/a.jpg'],
      knownShas: ['a'.repeat(64)],
      revokedAt: 2000,
    });
    assert.equal(again.revision, 1);
    const reloaded = readImageMemoryPolicy(policyPath);
    assert.equal(reloaded.paths['inbox/a.jpg'], 1000);
    assert.equal(reloaded.shas['a'.repeat(64)], 1000);

    // A disposable index can disappear; the authoritative denial remains on disk.
    assert.equal(readImageMemoryPolicy(policyPath).paths['inbox/a.jpg'], 1000);
    assert.doesNotThrow(() => JSON.parse(readFileSync(policyPath, 'utf8')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('policy revocation accepts each finite image root and rejects unknown roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-roots-'));
  const policyPath = join(dir, 'policy.json');
  try {
    initializeImageMemoryPolicy(policyPath);
    const result = revokeImageMemory({ policyPath, relativePaths: ['inbox/a.png', 'life-photos/b.png', 'gallery/c.png'], revokedAt: 1 });
    assert.deepEqual(result.revokedPaths, ['gallery/c.png', 'inbox/a.png', 'life-photos/b.png']);
    assert.throws(() => revokeImageMemory({ policyPath, relativePaths: ['other/d.png'], revokedAt: 2 }), /path/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('revocation reports a policy write failure instead of silently allowing images', t => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-'));
  try {
    const policyPath = join(dir, 'policy.json');
    initializeImageMemoryPolicy(policyPath);
    // An open file blocks replacement on Windows, but not POSIX. Fail only the
    // final atomic replacement; pending-denial persistence still uses real files.
    const rename = fs.renameSync;
    const failure = t.mock.method(fs, 'renameSync', (source, target) => {
      if (target === policyPath) throw Object.assign(new Error('fixture: replacement denied'), { code: 'EACCES' });
      return rename(source, target);
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => revokeImageMemory({
        policyPath,
        relativePaths: ['inbox/a.jpg'],
        knownShas: [],
        revokedAt: 1000,
      }), error => error.code === 'IMAGE_MEMORY_POLICY_WRITE_FAILED');
      const filtered = filterImageMemoryMatchesByPolicy(policyPath, [{ relativePath: 'inbox/other.jpg', sha256: 'b'.repeat(64) }]);
      assert.deepEqual(filtered.matches, []);
      assert.equal(filtered.warning, 'IMAGE_MEMORY_POLICY_PENDING');
    } finally { failure.mock.restore(); syncBuiltinESMExports(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary revocation fails closed when the authoritative policy is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-missing-'));
  const policyPath = join(dir, 'policy.json');
  try {
    assert.throws(() => revokeImageMemory({
      policyPath,
      relativePaths: ['inbox/new-denial.jpg'],
      knownShas: [],
      revokedAt: 1000,
    }), error => error.code === 'IMAGE_MEMORY_POLICY_MISSING');
    assert.equal(requireExists(policyPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable pending-denial location keeps recall paused after the revoke fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-pending-failure-'));
  const policyPath = join(dir, 'policy.json');
  try {
    initializeImageMemoryPolicy(policyPath);
    writeFileSync(`${policyPath}.pending`, 'not-a-directory');
    assert.throws(() => revokeImageMemory({
      policyPath,
      relativePaths: ['inbox/private.jpg'],
      revokedAt: 1000,
    }), error => error.code === 'IMAGE_MEMORY_POLICY_PENDING_WRITE_FAILED');
    const filtered = filterImageMemoryMatchesByPolicy(policyPath, [{ relativePath: 'inbox/other.jpg', sha256: 'c'.repeat(64) }]);
    assert.deepEqual(filtered.matches, []);
    assert.equal(filtered.warning, 'IMAGE_MEMORY_POLICY_PENDING_READ_FAILED');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stale-looking lock is never deleted without owning its generation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-stale-lock-'));
  const policyPath = join(dir, 'policy.json');
  const lockPath = `${policyPath}.lock`;
  try {
    initializeImageMemoryPolicy(policyPath);
    writeFileSync(lockPath, 'unreadable-owner');
    const old = new Date(Date.now() - 60000);
    utimesSync(lockPath, old, old);
    assert.throws(() => revokeImageMemory({
      policyPath,
      relativePaths: ['inbox/a.png'],
      revokedAt: 1000,
    }), error => error.code === 'IMAGE_MEMORY_POLICY_LOCK_BUSY');
    assert.equal(readFileSync(lockPath, 'utf8'), 'unreadable-owner');
    assert.equal(readImageMemoryPolicy(policyPath).paths['inbox/a.png'], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real Node writers and initialization serialize across processes without losing revocations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-writers-'));
  const policyPath = join(dir, 'policy.json');
  const lockPath = `${policyPath}.lock`;
  const writer = fileURLToPath(new URL('./test-fixtures/image-memory-policy-writer.mjs', import.meta.url));
  const children = [];
  const ready = child => new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('ready\n')) resolve();
    });
    child.once('error', reject);
    child.once('exit', code => { if (!output.includes('ready\n')) reject(new Error(`writer exited before ready: ${code}`)); });
  });
  const exited = child => new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer failed ${code}: ${stderr}`)));
  });
  try {
    initializeImageMemoryPolicy(policyPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'test-gate', createdAt: Date.now() }), { flag: 'wx' });
    for (let index = 0; index < 2; index++) {
      children.push(spawn(process.execPath, [writer, policyPath, `inbox/${index}.png`, String(100 + index)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    }
    children.push(spawn(process.execPath, [writer, policyPath, '--initialize', '0'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    const exits = children.map(exited);
    await Promise.all(children.map(ready));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(children.map(child => child.exitCode), [null, null, null], 'all writers must wait outside the policy critical section');
    rmSync(lockPath, { force: true });
    await Promise.all(exits);
    const policy = readImageMemoryPolicy(policyPath);
    assert.equal(policy.revision, 2);
    assert.deepEqual(Object.keys(policy.paths).sort(), ['inbox/0.png', 'inbox/1.png']);
  } finally {
    try { rmSync(lockPath, { force: true }); } catch {}
    for (const child of children) if (child.exitCode == null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sixteen Windows writers either persist every revocation or fail explicitly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-stress-'));
  const policyPath = join(dir, 'policy.json');
  const writer = fileURLToPath(new URL('./test-fixtures/image-memory-policy-writer.mjs', import.meta.url));
  try {
    initializeImageMemoryPolicy(policyPath);
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => new Promise(resolve => {
      const child = spawn(process.execPath, [writer, policyPath, `inbox/stress-${index}.png`, String(1000 + index)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', error => resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
      child.on('exit', code => resolve({ code, stdout, stderr }));
    })));
    assert.deepEqual(results.map(result => result.code), Array(16).fill(0), JSON.stringify(results));
    const policy = readImageMemoryPolicy(policyPath);
    assert.equal(policy.revision, 16);
    assert.equal(Object.keys(policy.paths).length, 16);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function requireExists(path) {
  try { readFileSync(path); return true; } catch { return false; }
}
