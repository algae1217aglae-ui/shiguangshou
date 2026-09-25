import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { verifyImageAccessAfterHash } from './worker.mjs';
import { filterImageMemoryMatchesByPolicy, initializeImageMemoryPolicy, revokeImageMemory } from '../../image-memory-policy.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function policyFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-race-'));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 0, paths: {}, shas: {} }));
  return { dir, policyPath };
}

test('embedding persistence rejects a path revoked during its final hash await', async () => {
  const { dir, policyPath } = policyFixture();
  const entered = deferred();
  const release = deferred();
  try {
    const checking = verifyImageAccessAfterHash({
      policyPath,
      relativePath: 'inbox/a.png',
      expectedSha: 'sha-a',
      hashCurrent: async () => {
        entered.resolve();
        await release.promise;
        return 'sha-a';
      },
    });
    await entered.promise;
    writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 1, paths: { 'inbox/a.png': 123 }, shas: {} }));
    release.resolve();
    assert.equal(await checking, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('candidate validation rejects a SHA revoked during its final hash await', async () => {
  const { dir, policyPath } = policyFixture();
  const entered = deferred();
  const release = deferred();
  const sha = 'a'.repeat(64);
  try {
    const checking = verifyImageAccessAfterHash({
      policyPath,
      relativePath: 'inbox/a.png',
      expectedSha: sha,
      hashCurrent: async () => {
        entered.resolve();
        await release.promise;
        return sha;
      },
    });
    await entered.promise;
    writeFileSync(policyPath, JSON.stringify({ version: 1, revision: 1, paths: {}, shas: { [sha]: 123 } }));
    release.resolve();
    assert.equal(await checking, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('final candidate batch drops A when it is revoked while validation waits for B', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-policy-final-filter-'));
  const policyPath = join(dir, 'policy.json');
  const releaseB = deferred();
  const candidates = [{ relativePath: 'inbox/a.png', sha256: 'a'.repeat(64) }];
  try {
    initializeImageMemoryPolicy(policyPath);
    const validateB = (async () => {
      await releaseB.promise;
      candidates.push({ relativePath: 'inbox/b.png', sha256: 'b'.repeat(64) });
    })();
    revokeImageMemory({ policyPath, relativePaths: ['inbox/a.png'], knownShas: ['a'.repeat(64)], revokedAt: 123 });
    releaseB.resolve();
    await validateB;
    const filtered = filterImageMemoryMatchesByPolicy(policyPath, candidates);
    assert.deepEqual(filtered.matches.map(match => match.relativePath), ['inbox/b.png']);
    assert.equal(filtered.warning, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
