import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readAlbumImageSourceSnapshot,
  readChatHistoryContextEntries,
  readChatImageSourceSnapshot,
  readLifeImageSourceSnapshot,
  verifyChatHistoryLocator,
} from './image-memory-sources.mjs';
import { selectChatContextWindow } from './image-memory-context.mjs';

function withTemp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-sources-'));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('life snapshot accepts only explicit public photo entries and skips inline data', () => withTemp(dir => {
  const path = join(dir, 'life.json');
  writeFileSync(path, JSON.stringify([
    { id: 'life-1', kind: 'photo', text: 'shared', photo: '/life-photos/a.png', author: 'owner', ts: '2026-09-20T01:00:00Z' },
    { id: 'memo-1', kind: 'memo', text: 'not a photo', photo: '/gallery/b.png', ts: '2026-09-20T02:00:00Z' },
    { id: 'private-1', kind: 'photo', text: 'private', photo: '/gallery/c.png', memorySafe: false, ts: '2026-09-20T03:00:00Z' },
    { id: 'inline-1', kind: 'photo', text: 'legacy', photo: 'data:image/png;base64,AAAA', ts: '2026-09-20T04:00:00Z' },
  ]));
  const snapshot = readLifeImageSourceSnapshot(path);
  assert.equal(snapshot.status, 'complete');
  assert.deepEqual(snapshot.memberships.map(row => row.membershipId), ['life:life-1']);
  assert.equal(snapshot.memberships[0].relativePath, 'life-photos/a.png');
  assert.ok(snapshot.issues.some(issue => issue.code === 'IMAGE_SOURCE_INLINE_DATA_SKIPPED'));
}));

test('album legacy membership id survives rename and a persisted id overrides it', () => withTemp(dir => {
  const path = join(dir, 'albums.json');
  const write = value => writeFileSync(path, JSON.stringify(value));
  write({ albums: [{ id: 'album-1', name: 'old', note: 'n1', items: [{ src: 'gallery/a.png', at: '2026-09-20T01:00:00Z' }] }] });
  const first = readAlbumImageSourceSnapshot(path);
  write({ albums: [{ id: 'album-1', name: 'new', note: 'n2', items: [{ src: 'gallery/a.png', at: '2026-09-20T01:00:00Z' }] }] });
  const renamed = readAlbumImageSourceSnapshot(path);
  assert.equal(first.memberships[0].membershipId, renamed.memberships[0].membershipId);
  assert.equal(renamed.memberships[0].metadata.albumName, 'new');
  write({ albums: [{ id: 'album-1', name: 'new', note: 'n2', items: [{ id: 'item-persisted', src: 'gallery/a.png', at: '2026-09-20T01:00:00Z' }] }] });
  assert.equal(readAlbumImageSourceSnapshot(path).memberships[0].membershipId, 'album:album-1:item-persisted');
}));

test('album and item privacy flags, private notes, and sensitive paths never produce memberships', () => withTemp(dir => {
  const path = join(dir, 'albums.json');
  writeFileSync(path, JSON.stringify({ albums: [
    { id: 'hidden', name: 'hidden', hidden: true, items: [{ src: 'gallery/a.png', at: '2026-09-20T01:00:00Z' }] },
    { id: 'private-note', name: 'private', note: '不要存 synthetic secret', items: [{ src: 'gallery/b.png', at: '2026-09-20T01:00:00Z' }] },
    { id: 'items', name: 'items', items: [
      { src: 'gallery/c.png', at: '2026-09-20T01:00:00Z', memorySafe: false },
      { src: 'gallery/private-d.png', at: '2026-09-20T01:00:00Z' },
      { src: 'gallery/e.png', at: '2026-09-20T01:00:00Z', hidden: true },
      { src: 'gallery/ok.png', at: '2026-09-20T01:00:00Z' },
    ] },
  ] }));
  const snapshot = readAlbumImageSourceSnapshot(path);
  assert.deepEqual(snapshot.memberships.map(row => row.relativePath), ['gallery/ok.png']);
}));

test('broken source JSON is unreadable rather than an empty complete snapshot', () => withTemp(dir => {
  const life = join(dir, 'life.json');
  const albums = join(dir, 'albums.json');
  writeFileSync(life, '{');
  writeFileSync(albums, '{');
  for (const snapshot of [readLifeImageSourceSnapshot(life), readAlbumImageSourceSnapshot(albums)]) {
    assert.equal(snapshot.status, 'unreadable');
    assert.equal(snapshot.memberships, undefined);
  }
}));

test('chat snapshot preserves equal duplicates and binds legacy locators to a file generation', () => withTemp(dir => {
  const history = join(dir, 'chat-history.jsonl');
  const state = join(dir, 'state.json');
  const ts = '2026-09-20T01:00:00Z';
  const photo = { role: 'user', text: '', images: ['inbox/a.png'], ts };
  const lines = [photo, photo, { role: 'assistant', text: 'after', ts: '2026-09-20T01:01:00Z' }];
  writeFileSync(history, lines.map(row => JSON.stringify(row)).join('\r\n') + '\r\n');
  writeFileSync(state, JSON.stringify({ log: [photo] }));
  const first = readChatImageSourceSnapshot({ historyPath: history, statePath: state });
  assert.equal(first.status, 'complete');
  assert.equal(first.memberships.length, 2);
  assert.notEqual(first.memberships[0].membershipId, first.memberships[1].membershipId);
  assert.equal(first.messages.filter(row => row.text === 'after').length, 1);
  const oldGeneration = first.generation;
  writeFileSync(history, JSON.stringify({ role: 'user', text: '', images: ['inbox/replaced.png'], ts }) + '\n');
  const replaced = readChatImageSourceSnapshot({ historyPath: history, statePath: state });
  assert.notEqual(replaced.generation, oldGeneration);
  assert.notEqual(replaced.memberships[0].locator.generation, first.memberships[0].locator.generation);
}));

test('chat generation survives append while bounded locators reject reused offsets and front insertion', () => withTemp(dir => {
  const history = join(dir, 'chat-history.jsonl');
  const state = join(dir, 'state.json');
  const first = { role: 'user', messageId: 'm1', text: 'one', ts: '2026-09-20T01:00:00Z' };
  const second = { role: 'user', text: 'two', images: ['inbox/a.png'], ts: '2026-09-20T01:01:00Z' };
  writeFileSync(state, JSON.stringify({ log: [] }));
  writeFileSync(history, `${JSON.stringify(first)}\r\n${JSON.stringify(second)}\r\n`);
  const original = readChatImageSourceSnapshot({ historyPath: history, statePath: state });
  const originalMembership = original.memberships[0];

  writeFileSync(history, `${JSON.stringify(first)}\r\n${JSON.stringify(second)}\r\n${JSON.stringify({ role: 'assistant', text: 'after', ts: '2026-09-20T01:02:00Z' })}\r\n`);
  const appended = readChatImageSourceSnapshot({ historyPath: history, statePath: state });
  assert.equal(appended.generation, original.generation);
  assert.equal(appended.memberships[0].membershipId, originalMembership.membershipId);
  assert.equal(verifyChatHistoryLocator(history, originalMembership.locator)?.text, 'two');
  const delta = readChatImageSourceSnapshot({ historyPath: history, statePath: state, cursor: original.cursor });
  assert.equal(delta.mode, 'delta');
  assert.deepEqual(delta.messages.map(row => row.text), ['after']);
  assert.ok(delta.messages[0].locator.ordinal >= original.cursor.nextOrdinal);

  const replacement = { ...second, text: 'six' };
  assert.equal(Buffer.byteLength(JSON.stringify(replacement)), Buffer.byteLength(JSON.stringify(second)));
  writeFileSync(history, `${JSON.stringify(first)}\r\n${JSON.stringify(replacement)}\r\n`);
  assert.equal(verifyChatHistoryLocator(history, originalMembership.locator), null);

  writeFileSync(history, `${JSON.stringify({ role: 'assistant', text: 'inserted', ts: '2026-09-20T00:59:00Z' })}\n${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
  assert.notEqual(readChatImageSourceSnapshot({ historyPath: history, statePath: state }).generation, original.generation);
}));

test('bounded history context reads the current adjacent rows around an unchanged anchor', () => withTemp(dir => {
  const history = join(dir, 'chat-history.jsonl');
  const state = join(dir, 'state.json');
  const rows = [
    { role: 'assistant', messageId: 'prior', conversationId: 'c1', text: 'prior', ts: '2026-09-20T01:00:00Z' },
    { role: 'user', messageId: 'photo', conversationId: 'c1', text: 'photo', images: ['inbox/a.png'], ts: '2026-09-20T01:01:00Z' },
    { role: 'assistant', messageId: 'next', conversationId: 'c1', text: 'next', ts: '2026-09-20T01:02:00Z' },
  ];
  writeFileSync(state, JSON.stringify({ log: [] }));
  writeFileSync(history, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const locator = readChatImageSourceSnapshot({ historyPath: history, statePath: state }).memberships[0].locator;
  assert.deepEqual(readChatHistoryContextEntries(history, locator).map(row => row.entry.messageId), ['prior', 'photo', 'next']);
  rows.splice(2, 0, { role: 'assistant', messageId: 'hidden', conversationId: 'c1', text: 'private', memorySafe: false, ts: '2026-09-20T01:01:30Z' });
  writeFileSync(history, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(readChatHistoryContextEntries(history, locator).map(row => row.entry.messageId), ['prior', 'photo', 'hidden', 'next']);
}));

test('chat adapter ignores an incomplete trailing line until it is finished', () => withTemp(dir => {
  const history = join(dir, 'chat-history.jsonl');
  const state = join(dir, 'state.json');
  writeFileSync(state, JSON.stringify({ log: [] }));
  writeFileSync(history, `${JSON.stringify({ role: 'user', text: 'ready', ts: '2026-09-20T01:00:00Z' })}\n{"role":"user"`);
  const snapshot = readChatImageSourceSnapshot({ historyPath: history, statePath: state });
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.messages.length, 1);
  assert.ok(snapshot.cursor.trailingBytes > 0);
}));

test('chat adapter reports an invalid middle row as incomplete without throwing', () => withTemp(dir => {
  const history = join(dir, 'chat-history.jsonl');
  const state = join(dir, 'state.json');
  writeFileSync(state, JSON.stringify({ log: [] }));
  writeFileSync(history, [
    JSON.stringify({ role: 'user', messageId: 'before', text: 'before', ts: '2026-09-20T01:00:00Z' }),
    '{invalid}',
    JSON.stringify({ role: 'assistant', messageId: 'after', text: 'after', ts: '2026-09-20T01:01:00Z' }),
  ].join('\n') + '\n');
  const snapshot = readChatImageSourceSnapshot({ historyPath: history, statePath: state });
  assert.equal(snapshot.status, 'incomplete');
  assert.ok(snapshot.revision);
  assert.deepEqual(snapshot.memberships, []);
  assert.ok(snapshot.issues.some(issue => issue.code === 'IMAGE_HISTORY_ROW_INVALID'));
}));

test('private chat rows remain opaque barriers without storing their text', () => withTemp(dir => {
  const history = join(dir, 'chat-history.jsonl');
  const state = join(dir, 'state.json');
  const base = Date.parse('2026-09-20T01:00:00Z');
  writeFileSync(state, JSON.stringify({ log: [] }));
  writeFileSync(history, [
    { role: 'user', messageId: 'photo', conversationId: 'c1', text: 'photo', images: ['inbox/a.png'], ts: new Date(base).toISOString() },
    { role: 'assistant', messageId: 'hidden', conversationId: 'c1', text: 'hidden synthetic secret', hidden: true, ts: new Date(base + 60000).toISOString() },
    { role: 'assistant', messageId: 'private-text', conversationId: 'c1', text: '不要存 synthetic secret', ts: new Date(base + 120000).toISOString() },
    { role: 'assistant', messageId: 'normal', conversationId: 'c1', text: 'must not cross', ts: new Date(base + 180000).toISOString() },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const snapshot = readChatImageSourceSnapshot({ historyPath: history, statePath: state });
  const hidden = snapshot.messages.find(row => row.messageId === 'hidden');
  const privateText = snapshot.messages.find(row => row.messageId === 'private-text');
  assert.equal(hidden.text, '');
  assert.equal(privateText.text, '');
  assert.equal(hidden.memorySafe, false);
  assert.equal(privateText.memorySafe, false);
  const context = selectChatContextWindow(snapshot.messages, { photoMessageId: 'photo', beforeTs: base + 10 * 60000 });
  assert.deepEqual(context.map(row => row.messageId), ['photo']);
  assert.equal(JSON.stringify(snapshot).includes('hidden synthetic secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('不要存 synthetic secret'), false);
}));

test('private state wins over archived public content with the same exact message id', () => withTemp(dir => {
  const history = join(dir, 'chat-history.jsonl');
  const state = join(dir, 'state.json');
  const archived = {
    role: 'user', messageId: 'same', conversationId: 'c1', text: 'public before edit', images: ['inbox/a.png'],
    ts: '2026-09-20T01:00:00Z',
  };
  writeFileSync(history, `${JSON.stringify(archived)}\n`);
  writeFileSync(state, JSON.stringify({ log: [{ ...archived, text: '不要存 synthetic secret', memorySafe: false }] }));
  const snapshot = readChatImageSourceSnapshot({ historyPath: history, statePath: state });
  assert.deepEqual(snapshot.memberships, []);
  assert.ok(snapshot.messages.filter(row => row.messageId === 'same').every(row => row.memorySafe === false && row.text === ''));
  assert.equal(JSON.stringify(snapshot).includes('synthetic secret'), false);
}));

test('any state revision change forces a complete snapshot so deleted or privatized sources are removed', () => withTemp(dir => {
  const history = join(dir, 'chat-history.jsonl');
  const state = join(dir, 'state.json');
  const entry = {
    role: 'user', messageId: 'state-only', conversationId: 'c1', text: 'safe', images: ['inbox/a.png'],
    ts: '2026-09-20T01:00:00Z',
  };
  writeFileSync(history, '');
  writeFileSync(state, JSON.stringify({ log: [entry] }));
  const first = readChatImageSourceSnapshot({ historyPath: history, statePath: state });
  assert.equal(first.memberships.length, 1);

  writeFileSync(state, JSON.stringify({ log: [{ ...entry, text: '不要存 synthetic secret', memorySafe: false }] }));
  const privatized = readChatImageSourceSnapshot({ historyPath: history, statePath: state, cursor: first.cursor });
  assert.equal(privatized.mode, 'complete');
  assert.deepEqual(privatized.memberships, []);

  writeFileSync(state, JSON.stringify({ log: [] }));
  const deleted = readChatImageSourceSnapshot({ historyPath: history, statePath: state, cursor: privatized.cursor });
  assert.equal(deleted.mode, 'complete');
  assert.deepEqual(deleted.memberships, []);
}));
