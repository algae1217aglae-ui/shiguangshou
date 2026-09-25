import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMemoryEntry, memoryEntryAllowsImages } from './memory-recall.mjs';
import { assembleImageRecallBridgeDelivery, prepareImageRecallBatch } from './image-memory-chat.mjs';

test('legacy conversion is opt-in and preserves explicit private metadata', async () => {
  const { adaptLegacyChatEntry, adaptLegacyBridgeOptions } = await import('./adapters/legacy-chat.mjs');
  const row = adaptLegacyChatEntry({ role: 'resident', ts: '2026-01-01T00:00:00Z', text: '<心情>internal</心情>visible', images: ['inbox/photo.png'], memorySafe: false });
  assert.equal(row.role, 'assistant'); assert.equal(row.text, 'visible');
  assert.equal(row.memorySafe, false); assert.equal(row.images, undefined);
  assert.equal(adaptLegacyBridgeOptions({ bridgeKind: 'codex' }).supportsImageAttachments, true);
  assert.equal(adaptLegacyBridgeOptions({ bridgeKind: 'claude' }).supportsImageAttachments, false);
  const hidden = adaptLegacyChatEntry({ role: 'resident', messageId: 'barrier', ts: '2026-01-01T00:00:00Z', text: 'secret', hidden: true });
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.messageId, 'barrier');
  assert.equal(hidden.memorySafe, false);
});

test('neutral records keep assistant identity and literal text, excluding unrelated host fields', () => {
  const row = normalizeMemoryEntry({ role: 'assistant', ts: '2026-01-01T00:00:00Z', messageId: 'm', text: '<心情>literal example</心情>', peekFile: 'ignored.png', inner: 'host-only', mood: 'host-only' });
  assert.equal(row.role, 'assistant');
  assert.equal(row.text, '<心情>literal example</心情>');
  assert.deepEqual(Object.keys(row).sort(), ['messageId', 'role', 'text', 'ts']);
  assert.equal(memoryEntryAllowsImages({ memorySafe: true, images: ['inbox/photo.png'], peekFile: 'private.png' }), true);
  assert.equal(memoryEntryAllowsImages({ private: true, images: ['inbox/photo.png'] }), false);
});

test('image delivery uses explicit capability, independent of model names', () => {
  const liveRecall = { context: 'strict\ncandidate', strictContext: 'strict', recalledImagePaths: ['history.png'] };
  assert.deepEqual(assembleImageRecallBridgeDelivery({ supportsImageAttachments: true, angleFallbackEnabled: true, photoPaths: ['query.png'], liveRecall }).images, ['query.png', 'history.png']);
  assert.equal(assembleImageRecallBridgeDelivery({ bridgeKind: 'codex', angleFallbackEnabled: true, liveRecall }).context, 'strict');
});

test('a text-only caller cannot start angle candidate computation', async () => {
  let enabled;
  const prepared = await prepareImageRecallBatch({ entries: [{ role: 'user', ts: '2026-01-01T00:00:00Z', images: ['inbox/photo.png'] }], baseTs: Date.now(), angleFallbackEnabled: true, supportsImageAttachments: false,
    client: { recallBatch: async options => { enabled = options.angleFallbackEnabled; return { matches: [] }; } },
  });
  await prepared.recallPromise;
  assert.equal(enabled, false);
});
