import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryEntryAllowsContext, memoryEntryAllowsImages, normalizeMemoryEntry } from './memory-recall.mjs';
test('explicit private metadata excludes images and chat context', () => {
  const row = { role:'user', ts:'2026-01-01T00:00:00Z', text:'synthetic', images:['inbox/photo.png'], memorySafe:false };
  assert.equal(memoryEntryAllowsImages(row), false);
  assert.equal(memoryEntryAllowsContext(row), false);
  const normalized = normalizeMemoryEntry(row);
  assert.equal(normalized.memorySafe, false);
  assert.equal(normalized.images, undefined);
  assert.equal(normalizeMemoryEntry({...row, hidden:true}), null);
});
test('ordinary source preserves identity and media', () => {
  const row = {role:'user',ts:'2026-01-01T00:00:00Z',messageId:'synthetic-1',conversationId:'synthetic',text:'a photo',images:['inbox/photo.png']};
  const normalized = normalizeMemoryEntry(row);
  assert.equal(normalized.messageId,row.messageId);
  assert.equal(normalized.conversationId,row.conversationId);
  assert.deepEqual(normalized.images,row.images);
  assert.equal(normalized.role,'user');
});
