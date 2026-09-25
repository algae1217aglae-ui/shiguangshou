import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

import { memoryEntryAllowsContext, memoryEntryAllowsImages, normalizeMemoryEntry } from './memory-recall.mjs';
import { normalizeImageMemoryPath } from './tools/image-memory/source-paths.mjs';

const SOURCE_TEXT_LIMIT = 160;
const MESSAGE_TEXT_LIMIT = 240;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function historyGenerationFromBytes(bytes) {
  const newline = bytes.indexOf(0x0a);
  const end = newline >= 0 ? newline : bytes.length;
  const first = bytes.subarray(0, end > 0 && bytes[end - 1] === 0x0d ? end - 1 : end);
  return `history-v1:${digest(first)}`;
}

function boundedHistoryGeneration(path) {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytesRead === buffer.length && bytes.indexOf(0x0a) < 0) return null;
    return historyGenerationFromBytes(bytes);
  } finally { closeSync(descriptor); }
}

export function readChatHistoryGeneration(path) {
  try { return boundedHistoryGeneration(path); }
  catch { return null; }
}

export function readChatHistoryToken(path) {
  try {
    const stat = statSync(path);
    return `${boundedHistoryGeneration(path)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch { return null; }
}

function codePoints(value, limit) {
  return [...String(value || '')].slice(0, limit).join('');
}

function pointLength(value) {
  return [...String(value || '')].length;
}

function sourceTs(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function readStrict(path, expected) {
  try {
    const bytes = readFileSync(path);
    const stat = statSync(path);
    const value = JSON.parse(bytes.toString('utf8'));
    if (!expected(value)) throw new TypeError('source schema is invalid');
    return { ok: true, value, bytes, revision: `${stat.size}:${Math.trunc(stat.mtimeMs)}:${digest(bytes)}` };
  } catch (error) {
    return { ok: false, issue: { code: 'IMAGE_SOURCE_UNREADABLE', sourceType: '' }, error };
  }
}

function unreadable(sourceType) {
  return { sourceType, status: 'unreadable', issue: { code: 'IMAGE_SOURCE_UNREADABLE', sourceType } };
}

function safePath(value) {
  try { return normalizeImageMemoryPath(String(value || '').replace(/^\/+/, '')); }
  catch { return null; }
}

export function readLifeImageSourceSnapshot(path) {
  const source = readStrict(path, Array.isArray);
  if (!source.ok) return unreadable('life');
  const memberships = [];
  const issues = [];
  for (const entry of source.value) {
    if (!entry || entry.kind !== 'photo' || entry.hidden || entry.private || entry.memorySafe === false) continue;
    if (typeof entry.photo === 'string' && entry.photo.startsWith('data:')) {
      issues.push({ code: 'IMAGE_SOURCE_INLINE_DATA_SKIPPED', sourceType: 'life' });
      continue;
    }
    const relativePath = safePath(entry.photo);
    const ts = sourceTs(entry.ts);
    const id = String(entry.id || '').trim();
    if (!relativePath || ts == null || !id || !memoryEntryAllowsImages({ ...entry, images: [relativePath] })) continue;
    memberships.push({
      membershipId: `life:${id}`, sourceType: 'life', sourceId: id, relativePath,
      sourceTs: ts, sourceText: codePoints(entry.text, SOURCE_TEXT_LIMIT), author: entry.author === 'door' ? 'resident' : 'user',
      conversationId: null, sourceRevision: source.revision, locator: { kind: 'life', confidence: 'exact', sourceId: id },
      metadata: { sharedAt: new Date(ts).toISOString(), sourceTextLength: pointLength(entry.text) },
    });
  }
  return { sourceType: 'life', status: 'complete', revision: source.revision, generation: source.revision, memberships, messages: [], issues };
}

function legacyAlbumItemId(albumId, item) {
  return `legacy-${digest(JSON.stringify([albumId, String(item?.at || ''), safePath(item?.src) || ''])).slice(0, 24)}`;
}

export function ensureAlbumItemIds(value) {
  let changed = false;
  for (const album of Array.isArray(value?.albums) ? value.albums : []) {
    const albumId = String(album?.id || '').trim();
    if (!albumId || !Array.isArray(album.items)) continue;
    for (const item of album.items) {
      if (String(item?.id || '').trim()) continue;
      item.id = legacyAlbumItemId(albumId, item);
      changed = true;
    }
  }
  return changed;
}

export function readAlbumImageSourceSnapshot(path) {
  const source = readStrict(path, value => value && !Array.isArray(value) && Array.isArray(value.albums));
  if (!source.ok) return unreadable('album');
  const memberships = [];
  for (const album of source.value.albums) {
    const albumId = String(album?.id || '').trim();
    const albumText = String(album?.note || '');
    if (!albumId || !Array.isArray(album.items)
        || !memoryEntryAllowsContext({ ...album, text: albumText, images: [] })) continue;
    for (const item of album.items) {
      const relativePath = safePath(item?.src);
      const ts = sourceTs(item?.at);
      const itemText = String(item?.note || item?.caption || item?.text || '');
      if (!relativePath || ts == null
          || !memoryEntryAllowsContext({ ...item, text: itemText, images: [relativePath] })) continue;
      const itemId = String(item?.id || '').trim() || legacyAlbumItemId(albumId, item);
      memberships.push({
        membershipId: `album:${albumId}:${itemId}`, sourceType: 'album', sourceId: albumId, relativePath,
        sourceTs: ts, sourceText: codePoints(album.note, SOURCE_TEXT_LIMIT), author: null, conversationId: null,
        sourceRevision: source.revision, locator: { kind: 'album', confidence: 'exact', sourceId: albumId, membershipId: itemId },
        metadata: {
          albumName: codePoints(album.name, 30), albumNote: codePoints(album.note, 80),
          addedAt: new Date(ts).toISOString(), sourceTextLength: pointLength(album.note),
        },
      });
    }
  }
  return { sourceType: 'album', status: 'complete', revision: source.revision, generation: source.revision, memberships, messages: [], issues: [] };
}

function entryKey(entry) {
  return digest(JSON.stringify([
    entry?.role || '', entry?.ts || '', entry?.text || '', entry?.images || [], entry?.hidden === true, entry?.memorySafe === false,
  ]));
}

function chatAuthor(role) {
  return ['user', 'owner'].includes(role) ? 'user' : 'resident';
}

export function readChatImageSourceSnapshot({ historyPath, statePath, cursor = null }) {
  let bytes;
  let historyStat;
  let generation;
  let stateEntries = [];
  let stateRevision = 'missing';
  let historyStart = 0;
  let ordinalStart = 0;
  let mode = 'complete';
  try {
    const stateBytes = readFileSync(statePath);
    const state = JSON.parse(stateBytes.toString('utf8'));
    stateEntries = Array.isArray(state?.log) ? state.log : [];
    stateRevision = digest(stateBytes);
  } catch {}
  try {
    historyStat = statSync(historyPath);
    generation = boundedHistoryGeneration(historyPath);
    const canContinue = cursor && cursor.generation === generation && Number.isInteger(cursor.historyBytes)
      && cursor.historyBytes >= 0 && cursor.historyBytes <= historyStat.size
      && cursor.stateRevision === stateRevision
      && (!cursor.lastLocator || verifyChatHistoryLocator(historyPath, cursor.lastLocator, { allowPrivate: true }));
    if (canContinue) {
      historyStart = cursor.historyBytes;
      ordinalStart = Number.isInteger(cursor.nextOrdinal) ? cursor.nextOrdinal : 0;
      mode = 'delta';
    }
    const descriptor = openSync(historyPath, 'r');
    try {
      bytes = Buffer.alloc(historyStat.size - historyStart);
      if (bytes.length) readSync(descriptor, bytes, 0, bytes.length, historyStart);
    } finally { closeSync(descriptor); }
  }
  catch { return unreadable('chat'); }
  const text = bytes.toString('utf8');
  const lines = text.split(/(?<=\n)/);
  const rows = [];
  const counts = new Map();
  const issues = [];
  let byteStart = historyStart;
  let ordinal = ordinalStart;
  let trailingBytes = 0;
  for (const rawWithBreak of lines) {
    const raw = rawWithBreak.replace(/\r?\n$/, '');
    const rawBytes = Buffer.byteLength(rawWithBreak);
    if (!raw && rawBytes === 0) continue;
    if (!raw.trim()) { byteStart += rawBytes; continue; }
    let entry;
    try { entry = JSON.parse(raw); }
    catch {
      const isTrailingPartial = rawWithBreak === lines.at(-1) && !rawWithBreak.endsWith('\n');
      if (isTrailingPartial) {
        trailingBytes = rawBytes;
        byteStart += rawBytes;
        continue;
      }
      issues.push({ code: 'IMAGE_HISTORY_ROW_INVALID', sourceType: 'chat', ordinal });
      byteStart += rawBytes; ordinal++; continue;
    }
    const key = entryKey(entry);
    counts.set(key, (counts.get(key) || 0) + 1);
    rows.push({ entry, key, byteStart, ordinal, segmentSignature: digest(raw), from: 'history' });
    byteStart += rawBytes;
    ordinal++;
  }
  const revision = `${generation}:${historyStat.size}:${Math.trunc(historyStat.mtimeMs)}:${stateRevision}`;
  if (issues.length) return { sourceType: 'chat', status: 'incomplete', revision, generation, memberships: [], messages: [], issues };

  const deniedMessageIds = new Set(stateEntries.flatMap(entry => {
    const id = String(entry?.messageId || '').trim();
    return id && !memoryEntryAllowsContext(entry) ? [id] : [];
  }));

  try {
    const used = new Map();
    for (const entry of stateEntries) {
      const entryTs = sourceTs(entry?.ts);
      if (mode === 'delta' && entryTs != null && entryTs <= Number(cursor?.latestSourceTs || 0)) continue;
      const key = entryKey(entry);
      const count = counts.get(key) || 0;
      const matched = used.get(key) || 0;
      if (matched < count) { used.set(key, matched + 1); continue; }
      rows.push({ entry, key, byteStart: null, ordinal: ordinal++, segmentSignature: null, from: 'state' });
    }
  } catch {}

  const memberships = [];
  const messages = [];
  for (const row of rows) {
    const normalized = normalizeMemoryEntry(row.entry);
    const ts = sourceTs(row.entry?.ts);
    if (ts == null) continue;
    const exactId = String(row.entry.messageId || '').trim();
    const messageId = exactId || `legacy-chat:${digest(JSON.stringify([generation, row.byteStart, row.ordinal])).slice(0, 32)}`;
    const conversationId = String(row.entry.conversationId || '').trim() || `legacy-window:${generation}`;
    const contextAllowed = !deniedMessageIds.has(messageId) && memoryEntryAllowsContext(row.entry) && !!normalized;
    const locator = row.from === 'history'
      ? {
          kind: 'history', confidence: exactId ? 'exact' : 'legacy-window', generation, byteStart: row.byteStart,
          ordinal: row.ordinal, messageId, segmentSignature: row.segmentSignature,
          ...(contextAllowed ? { textLength: pointLength(normalized.text) } : {}),
        }
      : {
          kind: 'state', confidence: exactId ? 'exact' : 'none', generation, ordinal: row.ordinal, messageId,
          ...(contextAllowed ? { textLength: pointLength(normalized.text) } : {}),
        };
    messages.push({
      messageId, conversationId, orderKey: `${row.from === 'history' ? '0' : '1'}:${String(row.byteStart ?? row.ordinal).padStart(16, '0')}:${String(row.ordinal).padStart(12, '0')}`,
      sourceTs: ts, author: chatAuthor(row.entry.role), text: contextAllowed ? codePoints(normalized.text, MESSAGE_TEXT_LIMIT) : '',
      hidden: !contextAllowed, memorySafe: contextAllowed, sourceRevision: revision, locator,
    });
    if (!contextAllowed || !memoryEntryAllowsImages(row.entry)) continue;
    const images = Array.isArray(row.entry.images) ? row.entry.images : [];
    for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
      const relativePath = safePath(images[imageIndex]);
      if (!relativePath) continue;
      memberships.push({
        membershipId: `chat:${messageId}:image:${imageIndex}`, sourceType: 'chat', sourceId: messageId, relativePath,
        sourceTs: ts, sourceText: codePoints(row.entry.text, SOURCE_TEXT_LIMIT), author: chatAuthor(row.entry.role), conversationId,
        sourceRevision: revision, locator, metadata: { sourceTextLength: pointLength(row.entry.text) },
      });
    }
  }
  const lastHistoryRow = [...rows].reverse().find(row => row.from === 'history');
  const latestSourceTs = rows.reduce((latest, row) => Math.max(latest, sourceTs(row.entry?.ts) || 0), Number(cursor?.latestSourceTs || 0));
  const lastLocator = lastHistoryRow ? {
    kind: 'history', confidence: 'legacy-window', generation, byteStart: lastHistoryRow.byteStart,
    ordinal: lastHistoryRow.ordinal, messageId: '', segmentSignature: lastHistoryRow.segmentSignature,
  } : cursor?.lastLocator || null;
  return {
    sourceType: 'chat', status: 'complete', mode, revision, generation, memberships, messages, issues: [],
    cursor: {
      generation, stateRevision, historyBytes: historyStat.size - trailingBytes,
      nextOrdinal: ordinal, trailingBytes, lastLocator, latestSourceTs,
    },
  };
}

export function verifyChatHistoryLocator(historyPath, locator, { maxLineBytes = 1024 * 1024, allowPrivate = false } = {}) {
  if (!locator || locator.kind !== 'history' || !Number.isInteger(locator.byteStart) || locator.byteStart < 0
      || !/^[0-9a-f]{64}$/i.test(String(locator.segmentSignature || '')) || boundedHistoryGeneration(historyPath) !== locator.generation) return null;
  const descriptor = openSync(historyPath, 'r');
  try {
    const fileSize = statSync(historyPath).size;
    if (locator.byteStart >= fileSize) return null;
    const length = Math.min(maxLineBytes + 2, fileSize - locator.byteStart);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, locator.byteStart);
    const bytes = buffer.subarray(0, bytesRead);
    const newline = bytes.indexOf(0x0a);
    if (newline < 0 && locator.byteStart + bytesRead < fileSize) return null;
    const end = newline >= 0 ? newline : bytes.length;
    if (end > maxLineBytes) return null;
    const rawBytes = bytes.subarray(0, end > 0 && bytes[end - 1] === 0x0d ? end - 1 : end);
    if (digest(rawBytes) !== locator.segmentSignature) return null;
    const entry = JSON.parse(rawBytes.toString('utf8'));
    if (!allowPrivate && !memoryEntryAllowsContext(entry)) return null;
    const exactId = String(entry.messageId || '').trim();
    if (exactId && exactId !== locator.messageId) return null;
    return entry;
  } catch { return null; }
  finally { closeSync(descriptor); }
}

export function readChatHistoryContextEntries(historyPath, locator, { previous = 2, next = 3, maxLineBytes = 1024 * 1024 } = {}) {
  if (!verifyChatHistoryLocator(historyPath, locator, { maxLineBytes, allowPrivate: true })) return [];
  const descriptor = openSync(historyPath, 'r');
  try {
    const fileSize = statSync(historyPath).size;
    const beforeBytes = (previous + 1) * (maxLineBytes + 2);
    const afterBytes = (next + 2) * (maxLineBytes + 2);
    const start = Math.max(0, locator.byteStart - beforeBytes);
    const end = Math.min(fileSize, locator.byteStart + afterBytes);
    const buffer = Buffer.alloc(end - start);
    if (buffer.length) readSync(descriptor, buffer, 0, buffer.length, start);
    const segments = [];
    let segmentStart = 0;
    for (let index = 0; index < buffer.length; index++) {
      if (buffer[index] !== 0x0a) continue;
      const absoluteStart = start + segmentStart;
      if (start === 0 || segmentStart > 0) segments.push({ absoluteStart, bytes: buffer.subarray(segmentStart, index) });
      segmentStart = index + 1;
    }
    if (end === fileSize && segmentStart < buffer.length) {
      const absoluteStart = start + segmentStart;
      if (start === 0 || segmentStart > 0) segments.push({ absoluteStart, bytes: buffer.subarray(segmentStart) });
    }
    const anchorIndex = segments.findIndex(row => row.absoluteStart === locator.byteStart);
    if (anchorIndex < 0) return [];
    const selected = segments.slice(Math.max(0, anchorIndex - previous), anchorIndex + next + 1);
    return selected.map((row, index) => {
      const raw = row.bytes.length && row.bytes.at(-1) === 0x0d ? row.bytes.subarray(0, -1) : row.bytes;
      const ordinal = locator.ordinal + (Math.max(0, anchorIndex - previous) + index - anchorIndex);
      try { return { entry: JSON.parse(raw.toString('utf8')), byteStart: row.absoluteStart, ordinal, segmentSignature: digest(raw), invalid: false }; }
      catch { return { entry: null, byteStart: row.absoluteStart, ordinal, segmentSignature: digest(raw), invalid: true }; }
    });
  } catch { return []; }
  finally { closeSync(descriptor); }
}
