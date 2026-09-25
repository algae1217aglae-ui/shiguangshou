import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import {
  getLogicalImageStoreDigest,
  getChatWindow,
  getRegionStats,
  getStats,
  listSearchableRegions,
  migrateImageStore,
  listSearchableImages,
  openImageStore,
  replaceImageRegionChannelSet,
  removeImage,
  getSourceGeneration,
  listImageSources,
  replaceSourceSnapshot,
  shouldReindex,
  upsertImage,
  upsertImageHash,
  upsertImagePath,
  upsertOccurrence,
} from './store.mjs';

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-store-'));
  const path = join(dir, 'index.sqlite');
  try {
    const db = openImageStore(path);
    try { run(db, path); } finally { db.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('neutral assistant authors round-trip through the compatible v0.1 SQLite encoding', () => withStore(db => {
  const imageId = upsertImage(db, image());
  replaceSourceSnapshot(db, { sourceType: 'chat', revision: 'r', complete: true,
    memberships: [{ membershipId: 'm', sourceId: 'photo', imageId, relativePath: 'inbox/a.jpg', sourceTs: 100, sourceText: 'photo', author: 'assistant', conversationId: 'c' }],
    messages: [{ messageId: 'photo', conversationId: 'c', orderKey: '1', sourceTs: 100, author: 'assistant', text: 'photo', memorySafe: true, locator: { confidence: 'exact' } }],
  });
  assert.equal(db.prepare('SELECT author FROM chat_messages').get().author, 'resident');
  assert.equal(listImageSources(db, imageId)[0].author, 'assistant');
  assert.equal(getChatWindow(db, { membershipId: 'm', beforeTs: 200 })[0].author, 'assistant');
}));

const image = (overrides = {}) => ({
  relativePath: 'inbox/a.jpg', sha256: 'a'.repeat(64), phash: '0123456789abcdef',
  phashVersion: 'p1', phashUsable: true, embedding: null, embeddingDims: null,
  embeddingVersion: null, fileMtimeMs: 10, fileSize: 20, indexedAt: 30, ...overrides,
});

test('store initializes schema idempotently and keeps same-image occurrences distinct', () => {
  withStore((db, path) => {
    const imageId = upsertImage(db, image());
    assert.equal(upsertOccurrence(db, { occurrenceId: 'o1', imageId, sourceTs: 100, sourceText: 'first' }), true);
    assert.equal(upsertOccurrence(db, { occurrenceId: 'o2', imageId, sourceTs: 200, sourceText: 'second' }), true);
    assert.equal(upsertOccurrence(db, { occurrenceId: 'o1', imageId, sourceTs: 100, sourceText: 'updated' }), false);
    assert.deepEqual(getStats(db), { images: 1, occurrences: 2, pendingEmbedding: 1 });
    const reopened = openImageStore(path);
    assert.deepEqual(getStats(reopened), { images: 1, occurrences: 2, pendingEmbedding: 1 });
    reopened.close();
  });
});

test('search excludes self and future occurrences but allows historical same SHA', () => {
  withStore(db => {
    const imageId = upsertImage(db, image());
    upsertOccurrence(db, { occurrenceId: 'old', imageId, sourceTs: 100, sourceText: 'old text' });
    upsertOccurrence(db, { occurrenceId: 'self', imageId, sourceTs: 200, sourceText: 'self text' });
    const rows = listSearchableImages(db, { beforeTs: 200, excludeOccurrenceIds: ['self'], embeddingVersion: 'e1' });
    assert.deepEqual(rows.map(row => row.occurrenceId), ['old']);
    assert.equal(rows[0].sha256, 'a'.repeat(64));
  });
});

test('embedding Float32 little-endian blobs round-trip as copies and isolate versions', () => {
  withStore(db => {
    const vector = new Float32Array([0.6, 0.8]);
    const imageId = upsertImage(db, image({ embedding: vector, embeddingDims: 2, embeddingVersion: 'e1' }));
    upsertOccurrence(db, { occurrenceId: 'o1', imageId, sourceTs: 100, sourceText: '' });
    const rows = listSearchableImages(db, { beforeTs: 200, excludeOccurrenceIds: [], embeddingVersion: 'e1' });
    assert.ok(rows[0].embedding instanceof Float32Array);
    assert.deepEqual([...rows[0].embedding], [...vector]);
    rows[0].embedding[0] = 0;
    assert.equal(listSearchableImages(db, { beforeTs: 200, excludeOccurrenceIds: [], embeddingVersion: 'e1' })[0].embedding[0] > 0.59, true);
    assert.equal(listSearchableImages(db, { beforeTs: 200, excludeOccurrenceIds: [], embeddingVersion: 'e2' })[0].embedding, null);
  });
});

test('logical digest covers hashes, metadata, vectors, and occurrence content even when counts stay equal', () => {
  withStore(db => {
    const imageId = upsertImage(db, image({ embedding: new Float32Array([1, 0]), embeddingDims: 2, embeddingVersion: 'e1' }));
    upsertOccurrence(db, { occurrenceId: 'o1', imageId, sourceTs: 100, sourceText: 'first' });
    const counts = getStats(db);
    const original = getLogicalImageStoreDigest(db);

    upsertImage(db, image({ embedding: new Float32Array([1, 0]), embeddingDims: 2, embeddingVersion: 'e1', fileMtimeMs: 11 }));
    const metadata = getLogicalImageStoreDigest(db);
    assert.notEqual(metadata, original);
    assert.deepEqual(getStats(db), counts);

    upsertImage(db, image({ embedding: new Float32Array([0, 1]), embeddingDims: 2, embeddingVersion: 'e1', fileMtimeMs: 11 }));
    const vector = getLogicalImageStoreDigest(db);
    assert.notEqual(vector, metadata);
    assert.deepEqual(getStats(db), counts);

    upsertOccurrence(db, { occurrenceId: 'o1', imageId, sourceTs: 100, sourceText: 'changed' });
    const occurrence = getLogicalImageStoreDigest(db);
    assert.notEqual(occurrence, vector);
    assert.deepEqual(getStats(db), counts);

    db.prepare('UPDATE images SET sha256 = ? WHERE id = ?').run('b'.repeat(64), imageId);
    assert.notEqual(getLogicalImageStoreDigest(db), occurrence);
    assert.deepEqual(getStats(db), counts);
  });
});

test('store rejects malformed embeddings and cascades image revocation', () => {
  withStore(db => {
    assert.throws(() => upsertImage(db, image({ embedding: new Float32Array([1, Number.NaN]), embeddingDims: 2, embeddingVersion: 'e1' })), /finite/i);
    assert.throws(() => upsertImage(db, image({ embedding: new Float32Array([1, 1]), embeddingDims: 3, embeddingVersion: 'e1' })), /dimension/i);
    assert.throws(() => upsertImage(db, image({ embedding: new Float32Array([2, 0]), embeddingDims: 2, embeddingVersion: 'e1' })), /normalized/i);
    const imageId = upsertImage(db, image());
    upsertOccurrence(db, { occurrenceId: 'o1', imageId, sourceTs: 1, sourceText: '' });
    removeImage(db, imageId);
    assert.deepEqual(getStats(db), { images: 0, occurrences: 0, pendingEmbedding: 0 });
  });
});

test('content replacement drops old occurrences while metadata-only updates keep features', () => {
  withStore(db => {
    const imageId = upsertImage(db, image());
    upsertOccurrence(db, { occurrenceId: 'old', imageId, sourceTs: 1, sourceText: '' });
    const sameId = upsertImage(db, image({ fileMtimeMs: 11, indexedAt: 31 }));
    assert.equal(sameId, imageId);
    assert.equal(getStats(db).occurrences, 1);
    const replacementId = upsertImage(db, image({ sha256: 'b'.repeat(64), phash: null, phashVersion: null, phashUsable: false, fileMtimeMs: 12 }));
    assert.ok(replacementId > 0);
    assert.equal(getStats(db).occurrences, 0);
  });
});

test('same-SHA aliases share one asset and replacing one alias preserves the other source', () => {
  withStore(db => {
    const originalId = upsertImage(db, image());
    const aliasId = upsertImageHash(db, image({ relativePath: 'gallery/b.jpg', fileMtimeMs: 11 }));
    assert.equal(aliasId, originalId);
    replaceSourceSnapshot(db, {
      sourceType: 'album', baseGeneration: 0, baseRevision: null, revision: 'r1', complete: true,
      memberships: [{ membershipId: 'album:b', sourceId: 'b', imageId: originalId, relativePath: 'gallery/b.jpg', sourceTs: 100, sourceText: 'kept', sourceRevision: 'r1' }], messages: [],
    });
    const replacementId = upsertImageHash(db, image({ relativePath: 'inbox/a.jpg', sha256: 'b'.repeat(64), phash: null, phashUsable: false, fileMtimeMs: 12 }));
    assert.notEqual(replacementId, originalId);
    const kept = listSearchableImages(db, { beforeTs: 200, embeddingVersion: null });
    assert.deepEqual(kept.map(row => [row.occurrenceId, row.relativePath, row.sha256]), [['album:b', 'gallery/b.jpg', 'a'.repeat(64)]]);
  });
});

test('shouldReindex separates hash and embedding version work', () => {
  assert.deepEqual(shouldReindex(null, { mtimeMs: 1, size: 2 }, { phashVersion: 'p1', embeddingVersion: 'e1' }), { hash: true, embedding: true });
  const row = { fileMtimeMs: 1, fileSize: 2, phash: '0123456789abcdef', phashVersion: 'p1', embeddingVersion: 'e1', embedding: new Float32Array([1]) };
  assert.deepEqual(shouldReindex(row, { mtimeMs: 1, size: 2 }, { phashVersion: 'p1', embeddingVersion: 'e1' }), { hash: false, embedding: false });
  assert.deepEqual(shouldReindex(row, { mtimeMs: 1, size: 2 }, { phashVersion: 'p1', embeddingVersion: 'e2' }), { hash: false, embedding: true });
  assert.deepEqual(shouldReindex(row, { mtimeMs: 2, size: 2 }, { phashVersion: 'p1', embeddingVersion: 'e1' }), { hash: true, embedding: true });
});

test('read-only open does not change journal mode and newer schemas are rejected', () => {
  withStore((db, path) => {
    const mode = String(db.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase();
    const readOnly = openImageStore(path, { readOnly: true });
    assert.equal(String(readOnly.prepare('PRAGMA journal_mode').get().journal_mode).toLowerCase(), mode);
    readOnly.close();
  });
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-store-newer-'));
  const path = join(dir, 'newer.sqlite');
  try {
    const raw = new DatabaseSync(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    assert.throws(() => openImageStore(path), error => error.code === 'IMAGE_STORE_SCHEMA_NEWER');
    assert.throws(() => openImageStore(path, { readOnly: true }), error => error.code === 'IMAGE_STORE_SCHEMA_NEWER');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function unit512(index = 0) {
  const vector = new Float32Array(512);
  vector[index] = 1;
  return vector;
}

test('v1 migrates atomically to current schema without changing base rows', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-store-v1-'));
  const path = join(dir, 'v1.sqlite');
  try {
    const raw = new DatabaseSync(path);
    raw.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE images (id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, phash TEXT, phash_version TEXT, phash_usable INTEGER NOT NULL DEFAULT 0, embedding BLOB, embedding_dims INTEGER, embedding_version TEXT, file_mtime_ms INTEGER NOT NULL, file_size INTEGER NOT NULL, indexed_at INTEGER NOT NULL);
      CREATE TABLE occurrences (occurrence_id TEXT PRIMARY KEY, image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE, source_ts INTEGER NOT NULL, source_text TEXT NOT NULL DEFAULT '');
      CREATE INDEX idx_images_sha256 ON images(sha256);
      CREATE INDEX idx_occurrences_source_ts ON occurrences(source_ts);
      INSERT INTO images VALUES (1, 'inbox/a.jpg', '${'a'.repeat(64)}', NULL, NULL, 0, NULL, NULL, NULL, 1, 2, 3);
      INSERT INTO occurrences VALUES ('old', 1, 100, 'kept');
      PRAGMA user_version = 1;
    `);
    const before = raw.prepare('SELECT * FROM images').all();
    migrateImageStore(raw, { readOnly: false });
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);
    assert.deepEqual(raw.prepare('SELECT * FROM images').all(), before);
    assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='region_sets'").get());
    raw.close();

    const reopened = openImageStore(path);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 3);
    assert.equal(reopened.prepare('SELECT source_text FROM occurrences').get().source_text, 'kept');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('v3 source snapshot keeps independent memberships and rejects stale CAS commits', () => {
  withStore(db => {
    const imageId = upsertImage(db, image());
    upsertImagePath(db, { relativePath: 'inbox/a.jpg', imageId, fileMtimeMs: 10, fileSize: 20, verifiedAt: 30 });
    const first = replaceSourceSnapshot(db, {
      sourceType: 'album', baseGeneration: 0, baseRevision: null, revision: 'r1', complete: true,
      memberships: [
        { membershipId: 'album:a:i1', sourceId: 'a', imageId, relativePath: 'inbox/a.jpg', sourceTs: 10, sourceText: 'one', sourceRevision: 'r1', metadata: { albumName: 'A' } },
        { membershipId: 'album:b:i2', sourceId: 'b', imageId, relativePath: 'inbox/a.jpg', sourceTs: 20, sourceText: 'two', sourceRevision: 'r1', metadata: { albumName: 'B' } },
      ], messages: [],
    });
    assert.equal(first.generation, 1);
    assert.equal(listImageSources(db, imageId).length, 2);
    assert.throws(() => replaceSourceSnapshot(db, {
      sourceType: 'album', baseGeneration: 0, baseRevision: null, revision: 'old', complete: true,
      memberships: [], messages: [],
    }), error => error.code === 'IMAGE_SOURCE_SNAPSHOT_STALE');
    replaceSourceSnapshot(db, {
      sourceType: 'album', baseGeneration: 1, baseRevision: 'r1', revision: 'r2', complete: true,
      memberships: [{ membershipId: 'album:b:i2', sourceId: 'b', imageId, relativePath: 'inbox/a.jpg', sourceTs: 20, sourceText: 'updated', sourceRevision: 'r2', metadata: { albumName: 'B2' } }], messages: [],
    });
    const rows = listImageSources(db, imageId);
    assert.deepEqual(rows.map(row => row.membershipId), ['album:b:i2']);
    assert.equal(rows[0].metadata.albumName, 'B2');
    assert.deepEqual(getSourceGeneration(db, 'album'), { generation: 2, revision: 'r2' });
  });
});

test('chat snapshot storage erases private text and preserves its context barrier', () => {
  withStore(db => {
    const imageId = upsertImage(db, image());
    upsertImagePath(db, { relativePath: 'inbox/a.jpg', imageId, fileMtimeMs: 10, fileSize: 20, verifiedAt: 30 });
    replaceSourceSnapshot(db, {
      sourceType: 'chat', baseGeneration: 0, baseRevision: null, revision: 'chat-1', complete: true,
      memberships: [{
        membershipId: 'chat:photo:image:0', sourceId: 'photo', imageId, relativePath: 'inbox/a.jpg',
        sourceTs: 100, sourceText: 'photo', conversationId: 'c1', sourceRevision: 'chat-1',
      }],
      messages: [
        { messageId: 'photo', conversationId: 'c1', orderKey: '01', sourceTs: 100, author: 'user', text: 'photo', memorySafe: true, locator: { confidence: 'exact' } },
        { messageId: 'private', conversationId: 'c1', orderKey: '02', sourceTs: 110, author: 'assistant', text: '不要存 synthetic secret', memorySafe: false, locator: { confidence: 'exact' } },
        { messageId: 'after', conversationId: 'c1', orderKey: '03', sourceTs: 120, author: 'assistant', text: 'must not cross', memorySafe: true, locator: { confidence: 'exact' } },
      ],
    });
    assert.equal(db.prepare('SELECT text FROM chat_messages WHERE message_id=?').get('private').text, '');
    assert.deepEqual(getChatWindow(db, { membershipId: 'chat:photo:image:0', beforeTs: 200 }).map(row => row.messageId), ['photo']);
  });
});

test('chat context cannot cross an interleaved conversation row', () => {
  withStore(db => {
    const imageId = upsertImage(db, image());
    replaceSourceSnapshot(db, {
      sourceType: 'chat', baseGeneration: 0, baseRevision: null, revision: 'chat-1', complete: true,
      memberships: [{
        membershipId: 'chat:photo:image:0', sourceId: 'photo', imageId, relativePath: 'inbox/a.jpg',
        sourceTs: 100, sourceText: 'photo', conversationId: 'c1', sourceRevision: 'chat-1',
      }],
      messages: [
        { messageId: 'photo', conversationId: 'c1', orderKey: '01', sourceTs: 100, author: 'user', text: 'photo', memorySafe: true, locator: { confidence: 'exact' } },
        { messageId: 'other', conversationId: 'c2', orderKey: '02', sourceTs: 110, author: 'assistant', text: 'barrier', memorySafe: true, locator: { confidence: 'exact' } },
        { messageId: 'after', conversationId: 'c1', orderKey: '03', sourceTs: 120, author: 'assistant', text: 'must not cross', memorySafe: true, locator: { confidence: 'exact' } },
      ],
    });
    assert.deepEqual(getChatWindow(db, { membershipId: 'chat:photo:image:0', beforeTs: 200 }).map(row => row.messageId), ['photo']);
  });
});

test('searchability follows the union of live source memberships until the final source is removed', () => {
  withStore(db => {
    const imageId = upsertImage(db, image({ embedding: new Float32Array([1, 0]), embeddingDims: 2, embeddingVersion: 'e1' }));
    replaceSourceSnapshot(db, {
      sourceType: 'life', baseGeneration: 0, baseRevision: null, revision: 'life-1', complete: true,
      memberships: [{ membershipId: 'life:one', sourceId: 'one', imageId, relativePath: 'inbox/a.jpg', sourceTs: 100, sourceText: 'life', sourceRevision: 'life-1' }], messages: [],
    });
    replaceSourceSnapshot(db, {
      sourceType: 'album', baseGeneration: 0, baseRevision: null, revision: 'album-1', complete: true,
      memberships: [{ membershipId: 'album:one', sourceId: 'one', imageId, relativePath: 'inbox/a.jpg', sourceTs: 110, sourceText: 'album', sourceRevision: 'album-1' }], messages: [],
    });
    assert.deepEqual(listSearchableImages(db, { beforeTs: 200, embeddingVersion: 'e1' }).map(row => row.occurrenceId), ['life:one', 'album:one']);

    replaceSourceSnapshot(db, { sourceType: 'life', baseGeneration: 1, baseRevision: 'life-1', revision: 'life-2', complete: true, memberships: [], messages: [] });
    assert.deepEqual(listSearchableImages(db, { beforeTs: 200, embeddingVersion: 'e1' }).map(row => row.occurrenceId), ['album:one']);

    replaceSourceSnapshot(db, { sourceType: 'album', baseGeneration: 1, baseRevision: 'album-1', revision: 'album-2', complete: true, memberships: [], messages: [] });
    assert.deepEqual(listSearchableImages(db, { beforeTs: 200, embeddingVersion: 'e1' }), []);
  });
});

test('logical digest includes source membership and snapshot generation changes', () => {
  withStore(db => {
    const imageId = upsertImage(db, image());
    const before = getLogicalImageStoreDigest(db);
    replaceSourceSnapshot(db, {
      sourceType: 'life', baseGeneration: 0, baseRevision: null, revision: 'life-1', complete: true,
      memberships: [{ membershipId: 'life:one', sourceId: 'one', imageId, relativePath: 'inbox/a.jpg', sourceTs: 100, sourceText: 'life', sourceRevision: 'life-1' }], messages: [],
    });
    const withSource = getLogicalImageStoreDigest(db);
    assert.notEqual(withSource, before);
    replaceSourceSnapshot(db, {
      sourceType: 'life', baseGeneration: 1, baseRevision: 'life-1', revision: 'life-2', complete: true,
      memberships: [{ membershipId: 'life:one', sourceId: 'one', imageId, relativePath: 'inbox/a.jpg', sourceTs: 100, sourceText: 'changed', sourceRevision: 'life-2' }], messages: [],
    });
    assert.notEqual(getLogicalImageStoreDigest(db), withSource);
  });
});

test('failed v1 region migration rolls back both tables and user_version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'porch-image-store-v1-fail-'));
  const path = join(dir, 'v1.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE images (id INTEGER PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, phash TEXT, phash_version TEXT, phash_usable INTEGER NOT NULL DEFAULT 0, embedding BLOB, embedding_dims INTEGER, embedding_version TEXT, file_mtime_ms INTEGER NOT NULL, file_size INTEGER NOT NULL, indexed_at INTEGER NOT NULL); CREATE TABLE occurrences (occurrence_id TEXT PRIMARY KEY, image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE, source_ts INTEGER NOT NULL, source_text TEXT NOT NULL DEFAULT ''); PRAGMA user_version=1;`);
    assert.throws(() => migrateImageStore(db, { readOnly: false, onStep(step) { if (step === 'region_sets') throw new Error('injected migration failure'); } }), /injected/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('region_sets','regions')").get().count, 0);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('channel region sets are atomic, version-isolated, searchable, and cascade with images', () => {
  withStore(db => {
    const imageId = upsertImage(db, image());
    upsertOccurrence(db, { occurrenceId: 'old', imageId, sourceTs: 100, sourceText: 'old' });
    const fixed = Array.from({ length: 2 }, (_, index) => ({
      regionId: `fixed:${index}`, bbox: { x: index * 0.5, y: 0, width: 0.5, height: 0.5 },
      classId: null, className: null, detectorConfidence: null, embedding: unit512(index),
    }));
    replaceImageRegionChannelSet(db, {
      imageId, imageSha256: 'a'.repeat(64), featureVersion: 'fixed-v1', channel: 'fixed', detectorVersion: null,
      cropVersion: 'fixed5-v1', embeddingVersion: 'clip-v1', rawDetectionCount: null, acceptedDetectionCount: null,
      indexedAt: 200, regions: fixed,
    });
    replaceImageRegionChannelSet(db, {
      imageId, imageSha256: 'a'.repeat(64), featureVersion: 'yolo-v1', channel: 'yolo', detectorVersion: 'detector-v1',
      cropVersion: 'pad15-v1', embeddingVersion: 'clip-v1', rawDetectionCount: 0, acceptedDetectionCount: 0,
      indexedAt: 200, regions: [],
    });
    const rows = listSearchableRegions(db, { beforeTs: 200, excludeOccurrenceIds: [], channel: 'fixed', featureVersion: 'fixed-v1', embeddingVersion: 'clip-v1' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].embedding.length, 512);
    assert.equal(listSearchableRegions(db, { beforeTs: 200, excludeOccurrenceIds: [], channel: 'fixed', featureVersion: 'fixed-v2', embeddingVersion: 'clip-v1' }).length, 0);
    assert.deepEqual(getRegionStats(db), { regionSets: 2, regions: 2, fixedSets: 1, yoloSets: 1, zeroDetectionYoloSets: 1 });
    removeImage(db, imageId);
    assert.deepEqual(getRegionStats(db), { regionSets: 0, regions: 0, fixedSets: 0, yoloSets: 0, zeroDetectionYoloSets: 0 });
  });
});

test('region store rejects invalid bounds, dimensions, channel metadata, and stale image SHA without replacing ready data', () => {
  withStore(db => {
    const imageId = upsertImage(db, image());
    upsertOccurrence(db, { occurrenceId: 'old', imageId, sourceTs: 100, sourceText: 'old' });
    const base = {
      imageId, imageSha256: 'a'.repeat(64), featureVersion: 'fixed-v1', channel: 'fixed', detectorVersion: null,
      cropVersion: 'fixed5-v1', embeddingVersion: 'clip-v1', rawDetectionCount: null, acceptedDetectionCount: null,
      indexedAt: 200,
    };
    const valid = { regionId: 'fixed:a', bbox: { x: 0, y: 0, width: 0.5, height: 0.5 }, classId: null, className: null, detectorConfidence: null, embedding: unit512() };
    replaceImageRegionChannelSet(db, { ...base, regions: [valid] });
    assert.throws(() => replaceImageRegionChannelSet(db, { ...base, regions: [{ ...valid, bbox: { x: 0.8, y: 0, width: 0.3, height: 0.5 } }] }), /bbox/i);
    assert.throws(() => replaceImageRegionChannelSet(db, { ...base, regions: [{ ...valid, embedding: new Float32Array([1]) }] }), /512/);
    assert.throws(() => replaceImageRegionChannelSet(db, { ...base, channel: 'yolo', detectorVersion: null, rawDetectionCount: 0, acceptedDetectionCount: 0, regions: [] }), /detector/i);
    assert.throws(() => replaceImageRegionChannelSet(db, { ...base, imageSha256: 'b'.repeat(64), regions: [valid] }), /SHA/i);
    assert.equal(listSearchableRegions(db, { beforeTs: 300, excludeOccurrenceIds: [], channel: 'fixed', featureVersion: 'fixed-v1', embeddingVersion: 'clip-v1' }).length, 1);
  });
});
