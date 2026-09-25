import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import {
  IMAGE_MEMORY_ROOT_NAMES,
  createImageMemoryRoots,
  decodeImageMemoryImage,
  normalizeImageMemoryPath,
  resolveImageMemoryImage,
} from './source-paths.mjs';
import { computePhash } from './phash.mjs';

async function withRoots(run) {
  const root = mkdtempSync(join(tmpdir(), 'porch-image-roots-'));
  const dirs = Object.fromEntries(IMAGE_MEMORY_ROOT_NAMES.map(name => [name, join(root, name)]));
  for (const dir of Object.values(dirs)) mkdirSync(dir);
  try { await run({ root, dirs, roots: createImageMemoryRoots({ inboxDir: dirs.inbox, lifePhotosDir: dirs['life-photos'], galleryDir: dirs.gallery }) }); }
  finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}

test('all three finite roots resolve and decode the same direct-child contract', async () => {
  await withRoots(async ({ dirs, roots }) => {
    for (const name of IMAGE_MEMORY_ROOT_NAMES) {
      const file = join(dirs[name], `${name.replace('-', '')}.png`);
      await sharp({ create: { width: 9, height: 7, channels: 3, background: 'green' } }).png().toFile(file);
      const relativePath = `${name}/${name.replace('-', '')}.png`;
      assert.equal(normalizeImageMemoryPath(relativePath), relativePath);
      const resolved = await resolveImageMemoryImage(relativePath, roots);
      assert.equal(resolved.absolutePath, realpathSync.native(file));
      const decoded = await decodeImageMemoryImage(relativePath, roots);
      assert.equal(decoded.width, 9);
      assert.match(decoded.sha256, /^[0-9a-f]{64}$/);
      assert.match((await computePhash(relativePath, roots)).phash, /^[0-9a-f]{16}$/);
    }
  });
});

test('finite roots reject unknown roots, traversal, nesting, absolute paths and links', async () => {
  await withRoots(async ({ root, dirs, roots }) => {
    for (const value of ['other/a.png', '../a.png', 'gallery/sub/a.png', 'C:\\a.png', 'inbox/a.png:stream']) {
      assert.throws(() => normalizeImageMemoryPath(value), error => error.code === 'IMAGE_PATH_INVALID');
    }
    const outside = join(root, 'outside.png');
    await sharp({ create: { width: 4, height: 4, channels: 3, background: 'blue' } }).png().toFile(outside);
    try {
      symlinkSync(outside, join(dirs.gallery, 'link.png'), 'file');
      await assert.rejects(resolveImageMemoryImage('gallery/link.png', roots), error => error.code === 'IMAGE_LINK_REJECTED');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
    }
  });
});
