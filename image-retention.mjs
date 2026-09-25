import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, realpathSync, statSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const IMAGE_RETENTION_DAYS = 90;
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

function retentionError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

function readRequiredJson(path, validate, code) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw retentionError(code, String(error?.message || error)); }
  if (!validate(value)) throw retentionError(`${code}_SCHEMA`, path);
  return value;
}

function assertSafeDirectory(path, code) {
  let st;
  try { st = lstatSync(path); }
  catch (error) { throw retentionError(code, String(error?.message || error)); }
  if (!st.isDirectory() || st.isSymbolicLink()) throw retentionError(code, 'directory is not a plain directory');
  const resolved = realpathSync(path);
  if (resolved !== resolve(path)) throw retentionError(code, 'directory resolves elsewhere');
}

function lexicalInboxPath(value) {
  if (typeof value !== 'string') return null;
  let input = value.trim().replaceAll('\\', '/');
  if (input.startsWith('/') && !input.startsWith('//')) input = input.slice(1);
  if (!input || isAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.includes('\0')) return null;
  input = input.replace(/^\.\//, '').replace(/^\//, '');
  const match = /^inbox\/([^/]+)$/.exec(input);
  if (!match || match[1] === '.' || match[1] === '..' || match[1].includes('..')) return null;
  if (!IMAGE_EXTENSIONS.has(extname(match[1]).toLowerCase())) return null;
  return `inbox/${match[1]}`;
}

export function normalizeDirectInboxPath(value, { inboxRoot, mustExist = true } = {}) {
  const relativePath = lexicalInboxPath(value);
  if (!relativePath || !inboxRoot) return null;
  const name = relativePath.slice('inbox/'.length);
  const absolutePath = join(inboxRoot, name);
  if (dirname(absolutePath) !== resolve(inboxRoot)) return null;
  if (!mustExist) return { relativePath, absolutePath };
  try {
    const st = lstatSync(absolutePath);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const real = realpathSync(absolutePath);
    const realInbox = realpathSync(inboxRoot);
    const sameName = process.platform === 'win32' ? basename(real).toLowerCase() === name.toLowerCase() : basename(real) === name;
    const sameParent = process.platform === 'win32' ? dirname(real).toLowerCase() === realInbox.toLowerCase() : dirname(real) === realInbox;
    if (!sameParent || !sameName) return null;
    return { relativePath: `inbox/${basename(real)}`, absolutePath: real, stat: st };
  } catch { return null; }
}

function htmlDecode(value) {
  const named = { quot: '"', apos: "'", sol: '/', percnt: '%', amp: '&', colon: ':', period: '.', num: '#' };
  return String(value)
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/gi, (whole, hex, dec) => {
      const point = Number.parseInt(hex || dec, hex ? 16 : 10);
      try { return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole; }
      catch { return whole; }
    })
    .replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] ?? whole);
}

function decodeReferenceToken(token, { baseUrl = null } = {}) {
  let value = htmlDecode(token).trim();
  if (/&(?:#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);?/.test(value)) throw retentionError('RETENTION_REFERENCE_ENCODING');
  value = value.replace(/^url\(\s*/i, '').replace(/\s*\)$/, '').replace(/^['"]|['"]$/g, '').trim();
  value = value.replace(/\s+(?:\d+(?:\.\d+)?[wx]|\d+dpi)$/i, '').trim();
  try { value = decodeURIComponent(value); }
  catch {
    if (/inbox|%2f/i.test(value)) throw retentionError('RETENTION_REFERENCE_ENCODING', value);
    return null;
  }
  if (/^data:/i.test(value)) return null;
  if (/^inbox\//i.test(value)) value = `/${value}`;
  if (baseUrl || /^(?:https?:)?\/\//i.test(value)) {
    let parsed;
    try { parsed = new URL(value, baseUrl || 'http://porch.invalid/works/card.html'); }
    catch {
      if (/inbox/i.test(value)) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', value);
      return null;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', value);
    try { value = decodeURIComponent(parsed.pathname); }
    catch { throw retentionError('RETENTION_REFERENCE_ENCODING', value); }
  } else {
    value = value.split(/[?#]/, 1)[0];
  }
  if (/^\/?inbox\/(?:\.\.?\/|.*\/)/i.test(value)) {
    throw retentionError('RETENTION_REFERENCE_BOUNDARY', value);
  }
  if (/^\.\.\/inbox\//i.test(value)) value = value.slice(3);
  const direct = lexicalInboxPath(value);
  if (!direct && /inbox/i.test(value)) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', value);
  return direct;
}

function parseHtmlStartTags(text) {
  const tags = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('<', cursor);
    if (open < 0) break;
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open + 4);
      if (end < 0) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'unterminated HTML comment');
      cursor = end + 3; continue;
    }
    let index = open + 1; let quote = '';
    for (; index < text.length; index++) {
      const char = text[index];
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '>') break;
    }
    if (index >= text.length) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'unterminated HTML tag');
    const raw = text.slice(open + 1, index).trim(); cursor = index + 1;
    if (!raw || raw.startsWith('/') || raw.startsWith('!') || raw.startsWith('?')) continue;
    const nameMatch = /^([^\s/>]+)/.exec(raw);
    if (!nameMatch) continue;
    const name = nameMatch[1].toLowerCase();
    const attrs = new Map();
    const source = raw.slice(nameMatch[0].length);
    let at = 0;
    while (at < source.length) {
      while (/\s|\//.test(source[at] || '')) at++;
      if (at >= source.length) break;
      const attrMatch = /^[^\s=/>]+/.exec(source.slice(at));
      if (!attrMatch) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', `malformed ${name} attribute`);
      const attr = attrMatch[0].toLowerCase(); at += attrMatch[0].length;
      while (/\s/.test(source[at] || '')) at++;
      let value = '';
      if (source[at] === '=') {
        at++; while (/\s/.test(source[at] || '')) at++;
        const marker = source[at];
        if (marker === '"' || marker === "'") {
          at++; const end = source.indexOf(marker, at);
          if (end < 0) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', `unterminated ${attr}`);
          value = source.slice(at, end); at = end + 1;
        } else {
          const unquoted = /^[^\s>]+/.exec(source.slice(at));
          value = unquoted?.[0] || ''; at += value.length;
        }
      }
      if (attrs.has(attr)) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', `duplicate ${attr}`);
      attrs.set(attr, htmlDecode(value));
    }
    tags.push({ name, attrs });
  }
  return tags;
}

function splitSrcset(value) {
  return String(value).split(',').map(part => part.trim().split(/\s+/, 1)[0]).filter(Boolean);
}

const PROVEN_CSS_FUNCTIONS = new Set([
  'url', 'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  'calc', 'min', 'max', 'clamp', 'round', 'mod', 'rem',
  'translate', 'translatex', 'translatey', 'translatez', 'translate3d', 'scale', 'scalex', 'scaley', 'scalez', 'scale3d',
  'rotate', 'rotatex', 'rotatey', 'rotatez', 'rotate3d', 'skew', 'skewx', 'skewy', 'matrix', 'matrix3d', 'perspective',
  'cubic-bezier', 'steps', 'circle', 'ellipse', 'inset', 'polygon', 'path', 'rect', 'xywh', 'counter', 'counters',
]);

function extractCssReferenceTokens(css) {
  const source = String(css || '');
  if (source.includes('\\')) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'CSS escapes are outside the proven subset');
  if (/@import\b/i.test(source)) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'CSS imports are not retention-safe');
  for (const match of source.matchAll(/(-?[a-z][a-z0-9-]*)\s*\(/gi)) {
    if (!PROVEN_CSS_FUNCTIONS.has(match[1].toLowerCase())) {
      throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', `unknown CSS function ${match[1]}`);
    }
  }
  const tokens = [];
  const remainder = source.replace(/url\(\s*([^)]*)\)/gi, (whole, token) => { tokens.push(token); return 'url()'; });
  if (/inbox/i.test(remainder)) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'unparsed CSS inbox reference');
  return tokens;
}

export function extractDurableInboxReferences(text, { format = 'html', documentPath = '/works/card.html' } = {}) {
  if (!['html', 'markdown', 'text'].includes(format)) throw retentionError('RETENTION_REFERENCE_FORMAT', format);
  const decoded = htmlDecode(text);
  if (/(?:^|["'\s(])(?:\/|%2f)?inbox(?:\/|%2f)(?:\.\.?)(?:\/|%2f)/i.test(decoded)) {
    throw retentionError('RETENTION_REFERENCE_BOUNDARY', 'ambiguous inbox traversal');
  }
  const tokens = [];
  let baseUrl = new URL(documentPath, 'http://porch.invalid/');
  if (format === 'html') {
    const tags = parseHtmlStartTags(decoded);
    const styleBlocks = [...decoded.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)];
    if (tags.filter(tag => tag.name === 'style').length !== styleBlocks.length) {
      throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'unbounded style element');
    }
    for (const match of styleBlocks) tokens.push(...extractCssReferenceTokens(match[1]));
    const bases = tags.filter(tag => tag.name === 'base');
    if (bases.length > 1) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'multiple base elements');
    if (bases.length === 1) {
      const href = bases[0].attrs.get('href');
      if (!href) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'base href missing');
      let parsed;
      try { parsed = new URL(href, baseUrl); } catch { throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'invalid base href'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== baseUrl.origin) {
        throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'unverifiable base href');
      }
      baseUrl = parsed;
    }
    const urlAttrs = new Set(['src', 'href', 'xlink:href', 'poster', 'data']);
    for (const tag of tags) {
      if (tag.name === 'script') throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'dynamic HTML is not retention-safe');
      if (tag.name === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(tag.attrs.get('rel') || '')) {
        throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'external stylesheets are not retention-safe');
      }
      for (const [attr, value] of tag.attrs) {
        if (attr.startsWith('on')) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', 'event handlers are not retention-safe');
        if (tag.name === 'base' && attr === 'href') continue;
        if (attr === 'srcset') tokens.push(...splitSrcset(value));
        else if (urlAttrs.has(attr)) tokens.push(value);
        else if (attr === 'style') {
          tokens.push(...extractCssReferenceTokens(value));
        } else if (/inbox/i.test(value)) {
          throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', `unknown reference attribute ${attr}`);
        }
      }
    }
  }
  if (format !== 'html') for (const match of decoded.matchAll(/url\(\s*([^)]*)\)/gi)) tokens.push(match[1]);
  for (const match of decoded.matchAll(/!\[[^\]]*\]\(([^)]*)\)/gi)) tokens.push(match[1]);
  for (const match of decoded.matchAll(/(?:^|[\s(=:,])((?:\.\.\/|%2f|\/)?inbox(?:%2f|\/)[^\s"'<>),]+)/gim)) tokens.push(match[1]);
  const result = new Set();
  for (const compound of tokens) {
    for (const token of String(compound).split(/\s*,\s*/)) {
      const path = decodeReferenceToken(token, { baseUrl });
      if (path) result.add(path);
    }
  }
  return result;
}

export function extractWorkRetentionClaimPaths(text, options = {}) {
  try { return [...extractDurableInboxReferences(text, { format: 'html', ...options })]; }
  catch (error) {
    if (String(error?.code || '').startsWith('RETENTION_REFERENCE_')) return ['__unknown_work_reference__'];
    throw error;
  }
}

export function extractLifeInboxReferences(life) {
  if (!Array.isArray(life)) throw retentionError('RETENTION_SOURCE_LIFE_SCHEMA');
  const refs = new Set();
  const add = value => {
    if (value == null) return;
    if (typeof value !== 'string') throw retentionError('RETENTION_SOURCE_LIFE_PHOTO_SCHEMA');
    if (!/inbox/i.test(value)) return;
    const path = decodeReferenceToken(value);
    if (!path) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', value);
    refs.add(path);
  };
  for (const row of life) {
    if (!isRecord(row)) throw retentionError('RETENTION_SOURCE_LIFE_ENTRY_SCHEMA');
    add(row.photo);
    if (row.kind === 'travel' || row.travel != null) {
      if (!isRecord(row.travel) || !Array.isArray(row.travel.stops)) throw retentionError('RETENTION_SOURCE_LIFE_TRAVEL_SCHEMA');
      for (const stop of row.travel.stops) {
        if (!isRecord(stop)) throw retentionError('RETENTION_SOURCE_LIFE_TRAVEL_SCHEMA');
        add(stop.photo);
      }
      if (row.travel.group != null) {
        if (!isRecord(row.travel.group)) throw retentionError('RETENTION_SOURCE_LIFE_TRAVEL_SCHEMA');
        add(row.travel.group.photo);
      }
    }
  }
  return refs;
}

function entryKey(entry) {
  return JSON.stringify([
    entry?.role || '', entry?.ts ?? null, entry?.text || '', Array.isArray(entry?.images) ? entry.images : [],
    entry?.hidden === true, entry?.memorySafe === false,
  ]);
}

function readChatEntries(statePath, historyPath) {
  const state = readRequiredJson(statePath, value => value && !Array.isArray(value) && Array.isArray(value.log), 'RETENTION_SOURCE_STATE');
  let historyText;
  try { historyText = readFileSync(historyPath, 'utf8'); }
  catch (error) { throw retentionError('RETENTION_SOURCE_HISTORY', String(error?.message || error)); }
  const history = [];
  for (const raw of historyText.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let row;
    try { row = JSON.parse(raw); }
    catch (error) { throw retentionError('RETENTION_SOURCE_HISTORY_ROW', String(error?.message || error)); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw retentionError('RETENTION_SOURCE_HISTORY_SCHEMA');
    history.push(row);
  }
  const unique = new Map();
  for (const row of [...history, ...state.log]) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw retentionError('RETENTION_SOURCE_STATE_ENTRY_SCHEMA');
    if (row.images != null && (!Array.isArray(row.images) || row.images.some(value => typeof value !== 'string'))) {
      throw retentionError('RETENTION_SOURCE_CHAT_IMAGES_SCHEMA');
    }
    unique.set(entryKey(row), row);
  }
  return [...unique.values()];
}

function readDurableReferences({ root, inboxRoot }) {
  const life = readRequiredJson(join(root, 'life.json'), Array.isArray, 'RETENTION_SOURCE_LIFE');
  const albums = readRequiredJson(join(root, 'albums.json'), value => value && !Array.isArray(value) && Array.isArray(value.albums), 'RETENTION_SOURCE_ALBUMS');
  // Retention protects albums and life entries (including travel), per the user's scope.
  // Showcase works are not a durable photo collection or a cleanup prerequisite.
  const refs = new Set();
  const add = value => {
    if (value == null) return;
    if (typeof value !== 'string') throw retentionError('RETENTION_SOURCE_LIFE_PHOTO_SCHEMA');
    if (!/inbox/i.test(value)) return;
    const path = decodeReferenceToken(value);
    if (!path) throw retentionError('RETENTION_REFERENCE_UNSUPPORTED', value);
    refs.add(path);
  };
  for (const ref of extractLifeInboxReferences(life)) refs.add(ref);
  for (const album of albums.albums) {
    if (!isRecord(album) || !Array.isArray(album.items)) throw retentionError('RETENTION_SOURCE_ALBUMS_SCHEMA');
    for (const item of album.items) {
      if (!isRecord(item)) throw retentionError('RETENTION_SOURCE_ALBUMS_ITEM_SCHEMA');
      if (item.src != null && typeof item.src !== 'string') throw retentionError('RETENTION_SOURCE_ALBUMS_ITEM_SCHEMA');
      add(item.src);
    }
  }
  const shaRefs = new Set();
  const canonicalRefs = new Set();
  for (const ref of refs) {
    const resolved = normalizeDirectInboxPath(ref, { inboxRoot });
    if (resolved) { canonicalRefs.add(resolved.relativePath); shaRefs.add(fileSha(resolved.absolutePath)); }
  }
  return { refs: new Set([...refs, ...canonicalRefs]), shaRefs };
}

function fileSha(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function identityFor(resolved) {
  const st = lstatSync(resolved.absolutePath);
  return {
    size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs,
    dev: String(st.dev), ino: String(st.ino), sha256: fileSha(resolved.absolutePath),
  };
}

export function readImageFileIdentity(absolutePath) {
  const st = lstatSync(absolutePath);
  if (!st.isFile() || st.isSymbolicLink()) throw retentionError('RETENTION_FILE_UNSAFE');
  return {
    size: st.size, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs,
    dev: String(st.dev), ino: String(st.ino), sha256: fileSha(absolutePath),
  };
}

export async function collectRetentionEvidence({
  root, now = Date.now(), days = IMAGE_RETENTION_DAYS, maxCandidates = 100,
} = {}) {
  if (!root) throw retentionError('RETENTION_ROOT_REQUIRED');
  if (days !== IMAGE_RETENTION_DAYS) throw retentionError('RETENTION_DAYS_INVALID');
  const absoluteRoot = resolve(root);
  const inboxRoot = join(absoluteRoot, 'inbox');
  assertSafeDirectory(absoluteRoot, 'RETENTION_SOURCE_ROOT');
  assertSafeDirectory(inboxRoot, 'RETENTION_SOURCE_INBOX');
  const entries = readChatEntries(join(absoluteRoot, 'state.json'), join(absoluteRoot, 'chat-history.jsonl'));
  const { refs, shaRefs } = readDurableReferences({ root: absoluteRoot, inboxRoot });
  const shares = new Map();
  for (const row of entries) {
    const images = Array.isArray(row.images) ? row.images : [];
    for (const rawPath of images) {
      const normalized = normalizeDirectInboxPath(rawPath, { inboxRoot }) || normalizeDirectInboxPath(rawPath, { inboxRoot, mustExist: false });
      if (!normalized) continue;
      const shareKey = process.platform === 'win32' ? normalized.relativePath.toLowerCase() : normalized.relativePath;
      const current = shares.get(shareKey) || { relativePath: normalized.relativePath, latest: null, untrusted: false };
      const time = typeof row.ts === 'number' ? row.ts : Date.parse(row.ts);
      if (!Number.isFinite(time) || time > now) current.untrusted = true;
      else current.latest = current.latest == null ? time : Math.max(current.latest, time);
      shares.set(shareKey, current);
    }
  }
  const cutoff = now - days * 86400000;
  const skipReasons = {};
  const skip = reason => { skipReasons[reason] = (skipReasons[reason] || 0) + 1; };
  const candidates = [];
  let estimatedBytes = 0;
  for (const shareKey of [...shares.keys()].sort()) {
    const share = shares.get(shareKey);
    const relativePath = share.relativePath;
    const resolved = normalizeDirectInboxPath(relativePath, { inboxRoot });
    if (!resolved) { skip('missing_or_unsafe_file'); continue; }
    if (share.untrusted || share.latest == null) { skip('untrusted_time'); continue; }
    if (share.latest >= cutoff) { skip('within_retention'); continue; }
    if (resolved.stat.mtimeMs > share.latest) { skip('file_newer_than_share'); continue; }
    if (refs.has(relativePath)) { skip('durable_reference'); continue; }
    const identity = identityFor(resolved);
    if (shaRefs.has(identity.sha256)) { skip('durable_sha_alias'); continue; }
    if (candidates.length >= Math.max(1, Math.min(1000, maxCandidates))) { skip('run_limit'); continue; }
    candidates.push({ relativePath, absolutePath: resolved.absolutePath, lastSharedAt: share.latest, identity });
    estimatedBytes += identity.size;
  }
  return {
    root: absoluteRoot, inboxRoot, cutoff, days, chatEntries: entries.length, chatPaths: shares.size,
    protectedCount: [...refs].length, candidates, estimatedBytes, skipReasons,
  };
}

export async function previewImageRetention(options = {}) {
  const evidence = await collectRetentionEvidence(options);
  return {
    mode: 'preview', days: evidence.days, cutoff: new Date(evidence.cutoff).toISOString(),
    candidateCount: evidence.candidates.length, estimatedBytes: evidence.estimatedBytes,
    chatPathCount: evidence.chatPaths, protectedReferenceCount: evidence.protectedCount,
    skipReasons: { ...evidence.skipReasons },
  };
}

export function sameFileIdentity(left, right) {
  return !!left && !!right && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.dev === right.dev && left.ino === right.ino && left.sha256 === right.sha256;
}
