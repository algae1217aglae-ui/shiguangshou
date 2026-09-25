import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { memoryEntryAllowsContext } from '../../memory-recall.mjs';

const SCHEMA_VERSION = 3;

function storeError(message, code = 'IMAGE_STORE_INVALID') {
  return Object.assign(new Error(message), { code });
}

function createBaseSchema(db) {
  db.exec(`
    CREATE TABLE images (
      id INTEGER PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      phash TEXT,
      phash_version TEXT,
      phash_usable INTEGER NOT NULL DEFAULT 0,
      embedding BLOB,
      embedding_dims INTEGER,
      embedding_version TEXT,
      file_mtime_ms INTEGER NOT NULL,
      file_size INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    );
    CREATE TABLE occurrences (
      occurrence_id TEXT PRIMARY KEY,
      image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
      source_ts INTEGER NOT NULL,
      source_text TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_images_sha256 ON images(sha256);
    CREATE INDEX idx_occurrences_source_ts ON occurrences(source_ts);
  `);
}

function createRegionSchema(db, onStep = () => {}) {
  db.exec(`CREATE TABLE region_sets (
    id INTEGER PRIMARY KEY,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    image_sha256 TEXT NOT NULL,
    feature_version TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('fixed','yolo')),
    detector_version TEXT,
    crop_version TEXT NOT NULL,
    embedding_version TEXT NOT NULL,
    raw_detection_count INTEGER,
    accepted_detection_count INTEGER,
    indexed_at INTEGER NOT NULL,
    UNIQUE(image_id, feature_version, channel),
    CHECK(
      (channel='fixed' AND detector_version IS NULL AND raw_detection_count IS NULL AND accepted_detection_count IS NULL)
      OR
      (channel='yolo' AND detector_version IS NOT NULL AND raw_detection_count >= 0 AND accepted_detection_count >= 0 AND accepted_detection_count <= raw_detection_count)
    )
  )`);
  onStep('region_sets');
  db.exec(`CREATE TABLE regions (
    id INTEGER PRIMARY KEY,
    region_set_id INTEGER NOT NULL REFERENCES region_sets(id) ON DELETE CASCADE,
    region_id TEXT NOT NULL,
    bbox_x REAL NOT NULL CHECK(bbox_x >= 0 AND bbox_x <= 1),
    bbox_y REAL NOT NULL CHECK(bbox_y >= 0 AND bbox_y <= 1),
    bbox_width REAL NOT NULL CHECK(bbox_width > 0 AND bbox_width <= 1),
    bbox_height REAL NOT NULL CHECK(bbox_height > 0 AND bbox_height <= 1),
    class_id INTEGER,
    class_name TEXT,
    detector_confidence REAL,
    embedding BLOB NOT NULL,
    embedding_dims INTEGER NOT NULL CHECK(embedding_dims = 512),
    CHECK(bbox_x + bbox_width <= 1),
    CHECK(bbox_y + bbox_height <= 1),
    UNIQUE(region_set_id, region_id)
  )`);
  onStep('regions');
  db.exec('CREATE INDEX idx_region_sets_image_version_channel ON region_sets(image_id, feature_version, channel)');
  db.exec('CREATE INDEX idx_regions_set ON regions(region_set_id)');
}

function createSourceSchema(db, onStep = () => {}) {
  db.exec(`CREATE TABLE image_paths (
    relative_path TEXT PRIMARY KEY,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    file_mtime_ms INTEGER NOT NULL,
    file_size INTEGER NOT NULL,
    verified_at INTEGER NOT NULL
  )`);
  onStep('image_paths');
  db.exec(`CREATE TABLE source_memberships (
    membership_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL CHECK(source_type IN ('chat','life','album')),
    source_id TEXT NOT NULL,
    image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
    relative_path TEXT NOT NULL REFERENCES image_paths(relative_path) ON DELETE CASCADE,
    source_ts INTEGER NOT NULL,
    source_text TEXT NOT NULL DEFAULT '',
    author TEXT CHECK(author IS NULL OR author IN ('user','resident')),
    conversation_id TEXT,
    source_revision TEXT NOT NULL,
    locator_json TEXT,
    metadata_json TEXT,
    updated_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX idx_source_memberships_image ON source_memberships(image_id)');
  db.exec('CREATE INDEX idx_source_memberships_source ON source_memberships(source_type, source_id)');
  onStep('source_memberships');
  db.exec(`CREATE TABLE chat_messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    order_key TEXT NOT NULL,
    source_ts INTEGER NOT NULL,
    author TEXT NOT NULL CHECK(author IN ('user','resident')),
    text TEXT NOT NULL,
    hidden INTEGER NOT NULL,
    memory_safe INTEGER NOT NULL,
    source_revision TEXT NOT NULL,
    locator_json TEXT
  )`);
  db.exec('CREATE INDEX idx_chat_messages_window ON chat_messages(conversation_id, order_key, message_id)');
  db.exec(`CREATE TABLE source_snapshots (
    source_type TEXT PRIMARY KEY,
    generation INTEGER NOT NULL,
    revision TEXT NOT NULL,
    completed_at INTEGER NOT NULL
  )`);
  onStep('source_snapshots');
  db.exec(`INSERT INTO image_paths(relative_path,image_id,file_mtime_ms,file_size,verified_at)
    SELECT relative_path,id,file_mtime_ms,file_size,indexed_at FROM images`);
  db.exec(`INSERT INTO source_memberships(membership_id,source_type,source_id,image_id,relative_path,source_ts,source_text,author,conversation_id,source_revision,locator_json,metadata_json,updated_at)
    SELECT occurrence_id,'chat',occurrence_id,o.image_id,i.relative_path,source_ts,source_text,NULL,NULL,'legacy-v2',
      '{"kind":"legacy","confidence":"none"}','{}',i.indexed_at
    FROM occurrences o JOIN images i ON i.id=o.image_id`);
}

export function migrateImageStore(db, { readOnly = false, onStep = () => {} } = {}) {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0);
  if (version > SCHEMA_VERSION) throw storeError(`image store schema ${version} is newer than supported ${SCHEMA_VERSION}`, 'IMAGE_STORE_SCHEMA_NEWER');
  if (version === SCHEMA_VERSION) return;
  if (readOnly) throw storeError('read-only image store requires an initialized schema', 'IMAGE_STORE_SCHEMA_MISSING');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version === 0) createBaseSchema(db);
    if (version < 2) createRegionSchema(db, onStep);
    if (version < 3) createSourceSchema(db, onStep);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function openImageStore(dbPath, { readOnly = false } = {}) {
  if (!readOnly) mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { readOnly, allowExtension: false });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 250');
    if (!readOnly) db.exec('PRAGMA journal_mode = WAL');
    migrateImageStore(db, { readOnly });
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

export function shouldReindex(row, fileStat, { phashVersion, embeddingVersion }) {
  if (!row) return { hash: true, embedding: true };
  const changed = Number(row.fileMtimeMs) !== Number(fileStat.mtimeMs) || Number(row.fileSize) !== Number(fileStat.size);
  const hash = changed || row.phashVersion !== phashVersion || !row.phash;
  const embedding = changed || hash || row.embeddingVersion !== embeddingVersion || !row.embedding;
  return { hash, embedding };
}

function encodeEmbedding(value, dims, version) {
  if (value == null) return null;
  if (!version || !Number.isInteger(dims) || dims <= 0 || value.length !== dims) throw storeError('embedding dimension does not match embeddingDims', 'IMAGE_STORE_EMBEDDING_DIMENSION');
  let norm = 0;
  const buffer = Buffer.alloc(dims * 4);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let index = 0; index < dims; index++) {
    const item = Number(value[index]);
    if (!Number.isFinite(item)) throw storeError('embedding values must be finite', 'IMAGE_STORE_EMBEDDING_INVALID');
    norm += item * item;
    view.setFloat32(index * 4, item, true);
  }
  if (Math.abs(Math.sqrt(norm) - 1) > 1e-3) throw storeError('embedding must be L2 normalized', 'IMAGE_STORE_EMBEDDING_NOT_NORMALIZED');
  return buffer;
}

function decodeEmbedding(blob, dims) {
  if (blob == null) return null;
  const buffer = Buffer.from(blob);
  if (!Number.isInteger(dims) || dims <= 0 || buffer.byteLength !== dims * 4) return null;
  const copy = new Float32Array(dims);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let norm = 0;
  for (let index = 0; index < dims; index++) {
    const item = view.getFloat32(index * 4, true);
    if (!Number.isFinite(item)) return null;
    copy[index] = item;
    norm += item * item;
  }
  return norm > 0 ? copy : null;
}

function validateRegionRecord(record, channel) {
  const bbox = record?.bbox;
  if (!bbox || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bbox[key]))
      || bbox.x < 0 || bbox.y < 0 || bbox.width <= 0 || bbox.height <= 0
      || bbox.x + bbox.width > 1 || bbox.y + bbox.height > 1) {
    throw storeError('region bbox must be finite and contained in the image', 'IMAGE_STORE_REGION_BBOX');
  }
  if (!record.regionId || String(record.regionId).length > 200) throw storeError('region id is invalid', 'IMAGE_STORE_REGION_ID');
  if (!(record.embedding instanceof Float32Array) || record.embedding.length !== 512) throw storeError('region embedding must contain 512 dimensions', 'IMAGE_STORE_EMBEDDING_DIMENSION');
  if (channel === 'fixed') {
    if (record.classId != null || record.className != null || record.detectorConfidence != null) throw storeError('fixed region cannot contain detector metadata', 'IMAGE_STORE_REGION_CHANNEL');
  } else if (!Number.isInteger(record.classId) || record.classId < 0 || typeof record.className !== 'string' || record.className.length > 80 || !Number.isFinite(record.detectorConfidence) || record.detectorConfidence < 0 || record.detectorConfidence > 1) {
    throw storeError('YOLO region detector metadata is invalid', 'IMAGE_STORE_REGION_CHANNEL');
  }
  return encodeEmbedding(record.embedding, 512, 'region-vector');
}

export function replaceImageRegionChannelSet(db, record) {
  if (!['fixed', 'yolo'].includes(record?.channel)) throw storeError('region channel is invalid', 'IMAGE_STORE_REGION_CHANNEL');
  if (!record.featureVersion || !record.cropVersion || !record.embeddingVersion) throw storeError('region versions are required', 'IMAGE_STORE_REGION_VERSION');
  const image = db.prepare('SELECT id, sha256 FROM images WHERE id = ?').get(record.imageId);
  if (!image || image.sha256 !== record.imageSha256) throw storeError('image SHA does not match region set', 'IMAGE_STORE_REGION_STALE');
  const regions = Array.isArray(record.regions) ? record.regions : [];
  if (regions.length > 5) throw storeError('region set exceeds five rows', 'IMAGE_STORE_REGION_LIMIT');
  if (record.channel === 'fixed') {
    if (record.detectorVersion != null || record.rawDetectionCount != null || record.acceptedDetectionCount != null) throw storeError('fixed region set cannot contain detector metadata', 'IMAGE_STORE_REGION_CHANNEL');
  } else {
    if (!record.detectorVersion || !Number.isInteger(record.rawDetectionCount) || !Number.isInteger(record.acceptedDetectionCount) || record.rawDetectionCount < 0 || record.acceptedDetectionCount !== regions.length || record.acceptedDetectionCount > record.rawDetectionCount) throw storeError('YOLO detector counts or version are invalid', 'IMAGE_STORE_REGION_CHANNEL');
  }
  const encoded = regions.map(region => ({ region, embedding: validateRegionRecord(region, record.channel) }));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM region_sets WHERE image_id=? AND feature_version=? AND channel=?').run(record.imageId, record.featureVersion, record.channel);
    const result = db.prepare(`INSERT INTO region_sets (image_id, image_sha256, feature_version, channel, detector_version, crop_version, embedding_version, raw_detection_count, accepted_detection_count, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.imageId, record.imageSha256, record.featureVersion, record.channel, record.detectorVersion ?? null,
      record.cropVersion, record.embeddingVersion, record.rawDetectionCount ?? null, record.acceptedDetectionCount ?? null, record.indexedAt,
    );
    const setId = Number(result.lastInsertRowid);
    const insert = db.prepare(`INSERT INTO regions (region_set_id, region_id, bbox_x, bbox_y, bbox_width, bbox_height, class_id, class_name, detector_confidence, embedding, embedding_dims)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 512)`);
    for (const { region, embedding } of encoded) insert.run(setId, region.regionId, region.bbox.x, region.bbox.y, region.bbox.width, region.bbox.height, region.classId ?? null, region.className ?? null, region.detectorConfidence ?? null, embedding);
    db.exec('COMMIT');
    return setId;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function listSearchableRegions(db, { beforeTs, excludeOccurrenceIds = [], channel, featureVersion, embeddingVersion }) {
  if (!['fixed', 'yolo'].includes(channel) || !featureVersion || !embeddingVersion) return [];
  const excluded = [...new Set(excludeOccurrenceIds.map(String))];
  const notIn = excluded.length ? ` AND sm.membership_id NOT IN (${excluded.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT i.id AS image_id, sm.relative_path, i.sha256, sm.membership_id AS occurrence_id, sm.source_ts, sm.source_text,
      rs.id AS region_set_id, rs.feature_version, rs.channel, rs.detector_version, rs.crop_version, rs.embedding_version,
      rs.raw_detection_count, rs.accepted_detection_count, r.region_id, r.bbox_x, r.bbox_y, r.bbox_width, r.bbox_height,
      r.class_id, r.class_name, r.detector_confidence, r.embedding, r.embedding_dims
    FROM region_sets rs JOIN images i ON i.id=rs.image_id JOIN source_memberships sm ON sm.image_id=i.id JOIN regions r ON r.region_set_id=rs.id
    WHERE sm.source_ts < ? AND rs.channel=? AND rs.feature_version=? AND rs.embedding_version=?${notIn}
    ORDER BY sm.source_ts, sm.membership_id, r.region_id`).all(beforeTs, channel, featureVersion, embeddingVersion, ...excluded);
  return rows.map(row => ({
    imageId: Number(row.image_id), relativePath: row.relative_path, sha256: row.sha256,
    occurrenceId: row.occurrence_id, sourceTs: Number(row.source_ts), sourceText: row.source_text,
    regionSetId: Number(row.region_set_id), featureVersion: row.feature_version, channel: row.channel,
    detectorVersion: row.detector_version, cropVersion: row.crop_version, embeddingVersion: row.embedding_version,
    rawDetectionCount: row.raw_detection_count == null ? null : Number(row.raw_detection_count),
    acceptedDetectionCount: row.accepted_detection_count == null ? null : Number(row.accepted_detection_count),
    regionId: row.region_id,
    bbox: { x: Number(row.bbox_x), y: Number(row.bbox_y), width: Number(row.bbox_width), height: Number(row.bbox_height) },
    classId: row.class_id == null ? null : Number(row.class_id), className: row.class_name,
    detectorConfidence: row.detector_confidence == null ? null : Number(row.detector_confidence),
    embedding: decodeEmbedding(row.embedding, Number(row.embedding_dims)),
  }));
}

export function getRegionStats(db) {
  const row = db.prepare(`SELECT COUNT(*) AS region_sets,
    SUM(CASE WHEN channel='fixed' THEN 1 ELSE 0 END) AS fixed_sets,
    SUM(CASE WHEN channel='yolo' THEN 1 ELSE 0 END) AS yolo_sets,
    SUM(CASE WHEN channel='yolo' AND raw_detection_count=0 THEN 1 ELSE 0 END) AS zero_yolo
    FROM region_sets`).get();
  const regions = Number(db.prepare('SELECT COUNT(*) AS count FROM regions').get().count);
  return { regionSets: Number(row.region_sets), regions, fixedSets: Number(row.fixed_sets || 0), yoloSets: Number(row.yolo_sets || 0), zeroDetectionYoloSets: Number(row.zero_yolo || 0) };
}

export function upsertImage(db, record) {
  releaseChangedPath(db, record.relativePath, record.sha256);
  const current = db.prepare('SELECT * FROM images WHERE sha256 = ? ORDER BY id LIMIT 1').get(record.sha256);
  const embedding = encodeEmbedding(record.embedding, record.embeddingDims, record.embeddingVersion);
  const existing = current || null;
  if (existing) {
    db.prepare(`UPDATE images SET sha256=?, phash=?, phash_version=?, phash_usable=?, embedding=?, embedding_dims=?, embedding_version=?, file_mtime_ms=?, file_size=?, indexed_at=? WHERE id=?`)
      .run(record.sha256, record.phash ?? null, record.phashVersion ?? null, record.phashUsable ? 1 : 0, embedding, record.embeddingDims ?? null, record.embeddingVersion ?? null, record.fileMtimeMs, record.fileSize, record.indexedAt, existing.id);
    upsertImagePath(db, { relativePath: record.relativePath, imageId: Number(existing.id), fileMtimeMs: record.fileMtimeMs, fileSize: record.fileSize, verifiedAt: record.indexedAt });
    return Number(existing.id);
  }
  const result = db.prepare(`INSERT INTO images (relative_path, sha256, phash, phash_version, phash_usable, embedding, embedding_dims, embedding_version, file_mtime_ms, file_size, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(record.relativePath, record.sha256, record.phash ?? null, record.phashVersion ?? null, record.phashUsable ? 1 : 0, embedding, record.embeddingDims ?? null, record.embeddingVersion ?? null, record.fileMtimeMs, record.fileSize, record.indexedAt);
  const imageId = Number(result.lastInsertRowid);
  upsertImagePath(db, { relativePath: record.relativePath, imageId, fileMtimeMs: record.fileMtimeMs, fileSize: record.fileSize, verifiedAt: record.indexedAt });
  return imageId;
}

export function upsertImageHash(db, record) {
  releaseChangedPath(db, record.relativePath, record.sha256);
  const current = db.prepare('SELECT * FROM images WHERE sha256 = ? ORDER BY id LIMIT 1').get(record.sha256);
  const existing = current || null;
  if (existing) {
    db.prepare(`UPDATE images SET sha256=?, phash=?, phash_version=?, phash_usable=?, file_mtime_ms=?, file_size=?, indexed_at=? WHERE id=?`)
      .run(record.sha256, record.phash ?? null, record.phashVersion ?? null, record.phashUsable ? 1 : 0, record.fileMtimeMs, record.fileSize, record.indexedAt, existing.id);
    upsertImagePath(db, { relativePath: record.relativePath, imageId: Number(existing.id), fileMtimeMs: record.fileMtimeMs, fileSize: record.fileSize, verifiedAt: record.indexedAt });
    return Number(existing.id);
  }
  const result = db.prepare(`INSERT INTO images (relative_path, sha256, phash, phash_version, phash_usable, embedding, embedding_dims, embedding_version, file_mtime_ms, file_size, indexed_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`)
    .run(record.relativePath, record.sha256, record.phash ?? null, record.phashVersion ?? null, record.phashUsable ? 1 : 0, record.fileMtimeMs, record.fileSize, record.indexedAt);
  const imageId = Number(result.lastInsertRowid);
  upsertImagePath(db, { relativePath: record.relativePath, imageId, fileMtimeMs: record.fileMtimeMs, fileSize: record.fileSize, verifiedAt: record.indexedAt });
  return imageId;
}

export function upsertImagePath(db, { relativePath, imageId, fileMtimeMs, fileSize, verifiedAt }) {
  db.prepare(`INSERT INTO image_paths(relative_path,image_id,file_mtime_ms,file_size,verified_at) VALUES(?,?,?,?,?)
    ON CONFLICT(relative_path) DO UPDATE SET image_id=excluded.image_id,file_mtime_ms=excluded.file_mtime_ms,file_size=excluded.file_size,verified_at=excluded.verified_at`)
    .run(relativePath, imageId, fileMtimeMs, fileSize, verifiedAt);
}

function releaseChangedPath(db, relativePath, incomingSha) {
  const bound = db.prepare(`SELECT i.id,i.relative_path,i.sha256 FROM image_paths ip JOIN images i ON i.id=ip.image_id WHERE ip.relative_path=?`).get(relativePath)
    || db.prepare('SELECT id,relative_path,sha256 FROM images WHERE relative_path=?').get(relativePath);
  if (!bound || bound.sha256 === incomingSha) return;
  const replacement = db.prepare('SELECT relative_path FROM image_paths WHERE image_id=? AND relative_path<>? ORDER BY relative_path LIMIT 1').get(bound.id, relativePath);
  if (bound.relative_path === relativePath && replacement) db.prepare('UPDATE images SET relative_path=? WHERE id=?').run(replacement.relative_path, bound.id);
  db.prepare('DELETE FROM image_paths WHERE relative_path=?').run(relativePath);
  if (!replacement) db.prepare('DELETE FROM images WHERE id=?').run(bound.id);
}

export function getSourceGeneration(db, sourceType) {
  const row = db.prepare('SELECT generation,revision FROM source_snapshots WHERE source_type=?').get(sourceType);
  return row ? { generation: Number(row.generation), revision: row.revision } : { generation: 0, revision: null };
}

export function listSourceGenerations(db) {
  return db.prepare('SELECT source_type AS sourceType,generation,revision FROM source_snapshots ORDER BY source_type').all()
    .map(row => ({ sourceType: row.sourceType, generation: Number(row.generation), revision: row.revision }));
}

function json(value) { return JSON.stringify(value ?? null); }
function parseJson(value, fallback) { try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; } }

export function replaceSourceSnapshot(db, { sourceType, baseGeneration = 0, baseRevision = null, revision, complete = false, memberships = [], messages = [] }) {
  const before = getSourceGeneration(db, sourceType);
  if (before.generation !== baseGeneration || before.revision !== baseRevision) throw storeError('source snapshot generation changed', 'IMAGE_SOURCE_SNAPSHOT_STALE');
  db.exec('BEGIN IMMEDIATE');
  try {
    const locked = getSourceGeneration(db, sourceType);
    if (locked.generation !== baseGeneration || locked.revision !== baseRevision) throw storeError('source snapshot generation changed', 'IMAGE_SOURCE_SNAPSHOT_STALE');
    const upsertMessage = db.prepare(`INSERT INTO chat_messages(message_id,conversation_id,order_key,source_ts,author,text,hidden,memory_safe,source_revision,locator_json)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET conversation_id=excluded.conversation_id,order_key=excluded.order_key,source_ts=excluded.source_ts,author=excluded.author,text=excluded.text,hidden=excluded.hidden,memory_safe=excluded.memory_safe,source_revision=excluded.source_revision,locator_json=excluded.locator_json`);
    for (const row of messages) {
      const contextSafe = memoryEntryAllowsContext(row);
      const text = contextSafe ? [...String(row.text || '')].slice(0, 240).join('') : '';
      upsertMessage.run(
        row.messageId, row.conversationId, row.orderKey, row.sourceTs, row.author, text,
        contextSafe ? 0 : 1, contextSafe ? 1 : 0, row.sourceRevision || revision, json(row.locator),
      );
    }
    const upsertMembership = db.prepare(`INSERT INTO source_memberships(membership_id,source_type,source_id,image_id,relative_path,source_ts,source_text,author,conversation_id,source_revision,locator_json,metadata_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(membership_id) DO UPDATE SET source_type=excluded.source_type,source_id=excluded.source_id,image_id=excluded.image_id,relative_path=excluded.relative_path,source_ts=excluded.source_ts,source_text=excluded.source_text,author=excluded.author,conversation_id=excluded.conversation_id,source_revision=excluded.source_revision,locator_json=excluded.locator_json,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`);
    for (const row of memberships) upsertMembership.run(row.membershipId, sourceType, row.sourceId, row.imageId, row.relativePath, row.sourceTs, [...String(row.sourceText || '')].slice(0, 160).join(''), row.author ?? null, row.conversationId ?? null, row.sourceRevision || revision, json(row.locator), json(row.metadata || {}), Date.now());
    if (complete) {
      if (memberships.length) db.prepare(`DELETE FROM source_memberships WHERE source_type=? AND membership_id NOT IN (${memberships.map(() => '?').join(',')})`).run(sourceType, ...memberships.map(row => row.membershipId));
      else db.prepare('DELETE FROM source_memberships WHERE source_type=?').run(sourceType);
      if (sourceType === 'chat') {
        if (messages.length) db.prepare(`DELETE FROM chat_messages WHERE message_id NOT IN (${messages.map(() => '?').join(',')})`).run(...messages.map(row => row.messageId));
        else db.prepare('DELETE FROM chat_messages').run();
      }
    }
    const generation = baseGeneration + 1;
    db.prepare(`INSERT INTO source_snapshots(source_type,generation,revision,completed_at) VALUES(?,?,?,?)
      ON CONFLICT(source_type) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,completed_at=excluded.completed_at`)
      .run(sourceType, generation, revision, Date.now());
    db.exec('COMMIT');
    return { generation, revision };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function listImageSources(db, imageId) {
  return db.prepare(`SELECT * FROM source_memberships WHERE image_id=? ORDER BY source_type,source_ts,membership_id`).all(imageId).map(row => ({
    membershipId: row.membership_id, sourceType: row.source_type, sourceId: row.source_id, imageId: Number(row.image_id), relativePath: row.relative_path,
    sourceTs: Number(row.source_ts), sourceText: row.source_text, author: row.author, conversationId: row.conversation_id,
    sourceRevision: row.source_revision, locator: parseJson(row.locator_json, null), metadata: parseJson(row.metadata_json, {}),
  }));
}

function chatMessage(row) {
  return row ? {
    messageId: row.message_id, conversationId: row.conversation_id, orderKey: row.order_key,
    sourceTs: Number(row.source_ts), author: row.author, text: row.text, hidden: !!row.hidden,
    memorySafe: !!row.memory_safe, sourceRevision: row.source_revision, locator: parseJson(row.locator_json, null),
  } : null;
}

export function getChatWindow(db, { membershipId, beforeTs, previous = 2, next = 3, maxDistanceMs = 600000 }) {
  const source = db.prepare(`SELECT source_id,conversation_id,source_ts FROM source_memberships WHERE membership_id=? AND source_type='chat'`).get(membershipId);
  if (!source || !source.conversation_id || Number(source.source_ts) >= beforeTs) return [];
  const anchor = db.prepare('SELECT * FROM chat_messages WHERE message_id=? AND conversation_id=?').get(source.source_id, source.conversation_id);
  if (!anchor) return [];
  const prior = db.prepare(`SELECT * FROM chat_messages WHERE order_key < ? OR (order_key=? AND message_id < ?)
    ORDER BY order_key DESC,message_id DESC LIMIT ?`).all(anchor.order_key, anchor.order_key, anchor.message_id, previous).reverse();
  const after = db.prepare(`SELECT * FROM chat_messages WHERE order_key > ? OR (order_key=? AND message_id > ?)
    ORDER BY order_key,message_id LIMIT ?`).all(anchor.order_key, anchor.order_key, anchor.message_id, next);
  const valid = row => row && row.conversation_id === anchor.conversation_id && !row.hidden && !!row.memory_safe && parseJson(row.locator_json, null)?.confidence !== 'none'
    && Number(row.source_ts) < beforeTs && Math.abs(Number(row.source_ts) - Number(anchor.source_ts)) <= maxDistanceMs;
  if (!valid(anchor)) return [];
  const keptPrior = [];
  for (let index = prior.length - 1; index >= 0; index--) {
    if (!valid(prior[index])) break;
    keptPrior.unshift({ ...chatMessage(prior[index]), contextKind: 'prior' });
  }
  const keptAfter = [];
  for (const row of after) {
    if (!valid(row)) break;
    keptAfter.push({ ...chatMessage(row), contextKind: 'next' });
  }
  return [...keptPrior, { ...chatMessage(anchor), contextKind: 'photo' }, ...keptAfter];
}

export function updateImageEmbedding(db, { relativePath, sha256, embedding, embeddingDims, embeddingVersion, indexedAt }) {
  const encoded = encodeEmbedding(embedding, embeddingDims, embeddingVersion);
  return Number(db.prepare(`UPDATE images SET embedding=?, embedding_dims=?, embedding_version=?, indexed_at=?
    WHERE id=(SELECT image_id FROM image_paths WHERE relative_path=?) AND sha256=?`)
    .run(encoded, embeddingDims, embeddingVersion, indexedAt, relativePath, sha256).changes);
}

export function upsertOccurrence(db, { occurrenceId, imageId, relativePath = null, sourceTs, sourceText = '' }) {
  const existed = !!db.prepare('SELECT 1 FROM occurrences WHERE occurrence_id = ?').get(occurrenceId);
  db.prepare(`INSERT INTO occurrences (occurrence_id, image_id, source_ts, source_text) VALUES (?, ?, ?, ?)
    ON CONFLICT(occurrence_id) DO UPDATE SET image_id=excluded.image_id, source_ts=excluded.source_ts, source_text=excluded.source_text`)
    .run(occurrenceId, imageId, sourceTs, String(sourceText).slice(0, 160));
  const image = db.prepare('SELECT relative_path,indexed_at FROM images WHERE id=?').get(imageId);
  if (image) db.prepare(`INSERT INTO source_memberships(membership_id,source_type,source_id,image_id,relative_path,source_ts,source_text,author,conversation_id,source_revision,locator_json,metadata_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(membership_id) DO UPDATE SET image_id=excluded.image_id,relative_path=excluded.relative_path,source_ts=excluded.source_ts,source_text=excluded.source_text,updated_at=excluded.updated_at`)
    .run(occurrenceId, 'chat', occurrenceId, imageId, relativePath || image.relative_path, sourceTs, String(sourceText).slice(0, 160), null, null, 'legacy-live', '{"kind":"legacy","confidence":"none"}', '{}', Date.now());
  return !existed;
}

export function listSearchableImages(db, { beforeTs, excludeOccurrenceIds = [], embeddingVersion = null }) {
  const excluded = [...new Set(excludeOccurrenceIds.map(String))];
  const notIn = excluded.length ? ` AND sm.membership_id NOT IN (${excluded.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`SELECT i.*, sm.relative_path AS membership_relative_path, sm.membership_id AS occurrence_id, sm.source_ts, sm.source_text
    FROM images i JOIN source_memberships sm ON sm.image_id=i.id WHERE sm.source_ts < ?${notIn} ORDER BY sm.source_ts, sm.membership_id`)
    .all(beforeTs, ...excluded);
  return rows.map(row => ({
    id: Number(row.id), relativePath: row.membership_relative_path, sha256: row.sha256,
    phash: row.phash, phashVersion: row.phash_version, phashUsable: !!row.phash_usable,
    embedding: row.embedding_version === embeddingVersion ? decodeEmbedding(row.embedding, Number(row.embedding_dims)) : null,
    embeddingDims: row.embedding_dims == null ? null : Number(row.embedding_dims),
    embeddingVersion: row.embedding_version,
    fileMtimeMs: Number(row.file_mtime_ms), fileSize: Number(row.file_size), indexedAt: Number(row.indexed_at),
    occurrenceId: row.occurrence_id, sourceTs: Number(row.source_ts), sourceText: row.source_text,
  }));
}

export function removeImage(db, imageId) {
  return Number(db.prepare('DELETE FROM images WHERE id = ?').run(imageId).changes);
}

export function getStats(db) {
  const images = Number(db.prepare('SELECT COUNT(*) AS count FROM images').get().count);
  const occurrences = Number(db.prepare('SELECT COUNT(*) AS count FROM occurrences').get().count);
  const pendingEmbedding = Number(db.prepare('SELECT COUNT(*) AS count FROM images WHERE embedding IS NULL').get().count);
  return { images, occurrences, pendingEmbedding };
}

export function getLogicalImageStoreDigest(db) {
  const images = db.prepare(`SELECT id, relative_path, sha256, phash, phash_version, phash_usable,
    hex(embedding) AS embedding_hex, embedding_dims, embedding_version, file_mtime_ms, file_size, indexed_at
    FROM images ORDER BY relative_path, id`).all();
  const occurrences = db.prepare(`SELECT occurrence_id, image_id, source_ts, source_text
    FROM occurrences ORDER BY occurrence_id`).all();
  const regionSets = db.prepare(`SELECT id, image_id, image_sha256, feature_version, channel, detector_version, crop_version, embedding_version,
    raw_detection_count, accepted_detection_count, indexed_at FROM region_sets ORDER BY image_id, feature_version, channel, id`).all();
  const regions = db.prepare(`SELECT id, region_set_id, region_id, bbox_x, bbox_y, bbox_width, bbox_height, class_id, class_name,
    detector_confidence, hex(embedding) AS embedding_hex, embedding_dims FROM regions ORDER BY region_set_id, region_id, id`).all();
  const imagePaths = db.prepare(`SELECT relative_path, image_id, file_mtime_ms, file_size, verified_at FROM image_paths ORDER BY relative_path`).all();
  const sourceMemberships = db.prepare(`SELECT membership_id, source_type, source_id, image_id, relative_path, source_ts, source_text, author,
    conversation_id, source_revision, locator_json, metadata_json, updated_at FROM source_memberships ORDER BY membership_id`).all();
  const chatMessages = db.prepare(`SELECT message_id, conversation_id, order_key, source_ts, author, text, hidden, memory_safe,
    source_revision, locator_json FROM chat_messages ORDER BY message_id`).all();
  const sourceSnapshots = db.prepare(`SELECT source_type, generation, revision, completed_at FROM source_snapshots ORDER BY source_type`).all();
  return createHash('sha256').update(JSON.stringify({
    version: SCHEMA_VERSION, images, occurrences, regionSets, regions, imagePaths, sourceMemberships, chatMessages, sourceSnapshots,
  })).digest('hex');
}
