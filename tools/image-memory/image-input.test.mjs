import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import { decodeImage, resolveInboxImage } from './image-input.mjs';

async function withInbox(run) {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-input-'));
  const inbox = join(dir, 'inbox');
  mkdirSync(inbox);
  try { await run({ dir, inbox }); } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}

test('resolveInboxImage only accepts a real direct child of inbox', async () => {
  await withInbox(async ({ dir, inbox }) => {
    const file = join(inbox, 'ok.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toFile(file);
    const resolved = await resolveInboxImage('inbox/ok.png', inbox);
    assert.equal(resolved.absolutePath, file);
    assert.equal(resolved.stat.size > 0, true);
    await assert.rejects(resolveInboxImage('../outside.png', inbox), /inbox/i);
    await assert.rejects(resolveInboxImage('inbox/sub/file.png', inbox), /inbox/i);
    await assert.rejects(resolveInboxImage('C:\\outside.png', inbox), /inbox/i);
    await assert.rejects(resolveInboxImage('inbox/ok.png:stream', inbox), /inbox/i);

    const outside = join(dir, 'outside.png');
    await sharp({ create: { width: 8, height: 8, channels: 3, background: 'blue' } }).png().toFile(outside);
    const link = join(inbox, 'link.png');
    try {
      symlinkSync(outside, link, 'file');
      await assert.rejects(resolveInboxImage('inbox/link.png', inbox), /link|inbox/i);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) throw error;
    }
  });
});

test('decodeImage normalizes orientation, alpha, and colour space', async () => {
  await withInbox(async ({ inbox }) => {
    await sharp({ create: { width: 12, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.25 } } })
      .png().withMetadata({ orientation: 6 }).toFile(join(inbox, 'oriented.png'));
    const decoded = await decodeImage('inbox/oriented.png', inbox);
    assert.equal(decoded.width, 8);
    assert.equal(decoded.height, 12);
    assert.equal(decoded.channels, 3);
    assert.equal(decoded.data.length, decoded.width * decoded.height * 3);
    assert.equal(decoded.format, 'png');
  });
});

test('decodeImage returns the actual first frame of a two-frame animated GIF', async () => {
  await withInbox(async ({ inbox }) => {
    const width = 12, height = 8, channels = 3;
    const red = Buffer.alloc(width * height * channels);
    const blue = Buffer.alloc(width * height * channels);
    for (let index = 0; index < red.length; index += channels) {
      red[index] = 255;
      blue[index + 2] = 255;
    }
    await sharp(Buffer.concat([red, blue]), {
      raw: { width, height: height * 2, channels, pageHeight: height },
    }).gif({ loop: 0, delay: [100, 100] }).toFile(join(inbox, 'animated.gif'));

    const decoded = await decodeImage('inbox/animated.gif', inbox);
    let redTotal = 0, greenTotal = 0, blueTotal = 0;
    for (let index = 0; index < decoded.data.length; index += 3) {
      redTotal += decoded.data[index];
      greenTotal += decoded.data[index + 1];
      blueTotal += decoded.data[index + 2];
    }
    const pixels = decoded.width * decoded.height;
    assert.equal(decoded.format, 'gif');
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.ok(redTotal / pixels > 240);
    assert.ok(greenTotal / pixels < 10);
    assert.ok(blueTotal / pixels < 10);
  });
});

test('decodeImage rejects a real file whose metadata changes while Sharp is reading it', async () => {
  await withInbox(async ({ inbox }) => {
    const file = join(inbox, 'changing.png');
    await sharp({ create: { width: 5000, height: 5000, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toFile(file);
    let mutations = 0;
    const timer = setInterval(() => {
      mutations++;
      const changed = new Date(Date.now() + mutations * 1000);
      try { utimesSync(file, changed, changed); } catch {}
    }, 1);
    try {
      await assert.rejects(decodeImage('inbox/changing.png', inbox), error => error.code === 'IMAGE_CHANGED_DURING_READ');
      assert.ok(mutations > 1, `expected repeated real-file mutations, got ${mutations}`);
    } finally { clearInterval(timer); }
  });
});

test('decodeImage rejects missing, corrupt, unsupported, oversized, and over-pixel-limit files', async () => {
  await withInbox(async ({ inbox }) => {
    writeFileSync(join(inbox, 'broken.jpg'), 'not an image');
    writeFileSync(join(inbox, 'plain.txt'), 'hello');
    writeFileSync(join(inbox, 'oversized.jpg'), Buffer.alloc(20 * 1024 * 1024 + 1));
    await assert.rejects(decodeImage('inbox/missing.jpg', inbox), error => error.code === 'IMAGE_NOT_FOUND');
    await assert.rejects(decodeImage('inbox/broken.jpg', inbox), error => error.code === 'IMAGE_DECODE_FAILED');
    await assert.rejects(decodeImage('inbox/plain.txt', inbox), error => error.code === 'IMAGE_FORMAT_UNSUPPORTED');
    await assert.rejects(decodeImage('inbox/oversized.jpg', inbox), error => error.code === 'IMAGE_FILE_TOO_LARGE');
    await sharp({ create: { width: 7000, height: 6000, channels: 3, background: 'white' } }).png().toFile(join(inbox, 'huge.png'));
    await assert.rejects(decodeImage('inbox/huge.png', inbox), error => error.code === 'IMAGE_PIXEL_LIMIT');
  });
});
