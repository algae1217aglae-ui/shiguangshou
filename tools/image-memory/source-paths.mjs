import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

export const IMAGE_MEMORY_ROOT_NAMES = Object.freeze(['inbox', 'life-photos', 'gallery']);
const ROOT_NAMES = new Set(IMAGE_MEMORY_ROOT_NAMES);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 40 * 1000 * 1000;
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const SUPPORTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

function imageError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function createImageMemoryRoots({ inboxDir, lifePhotosDir, galleryDir } = {}) {
  return Object.freeze({ inbox: inboxDir, 'life-photos': lifePhotosDir, gallery: galleryDir });
}

export function normalizeImageMemoryPath(value) {
  const original = String(value || '').trim();
  if (!original || isAbsolute(original) || /^[a-z]:/i.test(original) || original.includes(':')) throw imageError('image path must use inbox, life-photos, or gallery', 'IMAGE_PATH_INVALID');
  const path = original.replaceAll('\\', '/').replace(/^\/+/, '');
  const match = /^([^/]+)\/([^/]+)$/.exec(path);
  if (!match || !ROOT_NAMES.has(match[1].toLowerCase()) || match[2].includes('..')) throw imageError('image path must name one direct child of inbox, life-photos, or gallery', 'IMAGE_PATH_INVALID');
  return `${match[1].toLowerCase()}/${match[2]}`;
}

function extension(path) {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot).toLowerCase();
}

function isWindowsReparse(fileStat) {
  return Boolean(Number(fileStat?.birthtimeMs) >= 0 && Number(fileStat?.mode) >= 0 && Number(fileStat?.isSymbolicLink?.()));
}

export async function resolveImageMemoryImage(relativePath, roots) {
  const normalized = normalizeImageMemoryPath(relativePath);
  if (!SUPPORTED_EXTENSIONS.has(extension(normalized))) throw imageError('image format is not supported', 'IMAGE_FORMAT_UNSUPPORTED');
  const [rootName, fileName] = normalized.split('/');
  const rootDir = roots?.[rootName];
  if (!rootDir) throw imageError('image root is unavailable', 'IMAGE_ROOT_UNAVAILABLE');
  let rootReal;
  try {
    const rootStat = await lstat(rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || isWindowsReparse(rootStat)) throw imageError('image root link is not allowed', 'IMAGE_LINK_REJECTED');
    rootReal = await realpath(rootDir);
  } catch (error) {
    if (error?.code?.startsWith?.('IMAGE_')) throw error;
    throw imageError('image root is unavailable', 'IMAGE_ROOT_UNAVAILABLE', error);
  }
  const absolutePath = resolve(rootDir, fileName);
  if (dirname(absolutePath).toLowerCase() !== resolve(rootDir).toLowerCase()) throw imageError('image path escapes its root', 'IMAGE_PATH_INVALID');
  let linkStat;
  try { linkStat = await lstat(absolutePath); }
  catch (error) {
    if (error?.code === 'ENOENT') throw imageError('image does not exist', 'IMAGE_NOT_FOUND', error);
    throw imageError('image cannot be inspected', 'IMAGE_STAT_FAILED', error);
  }
  if (!linkStat.isFile() || linkStat.isSymbolicLink() || isWindowsReparse(linkStat)) throw imageError('image link is not allowed', 'IMAGE_LINK_REJECTED');
  let targetReal;
  try { targetReal = await realpath(absolutePath); }
  catch (error) { throw imageError('image cannot be resolved', 'IMAGE_STAT_FAILED', error); }
  const expectedPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (!targetReal.toLowerCase().startsWith(expectedPrefix.toLowerCase()) || dirname(targetReal).toLowerCase() !== rootReal.toLowerCase()) throw imageError('image resolves outside its root', 'IMAGE_PATH_INVALID');
  const fileStat = await stat(targetReal);
  if (fileStat.size > MAX_FILE_BYTES) throw imageError('image exceeds 20 MiB', 'IMAGE_FILE_TOO_LARGE');
  return { relativePath: normalized, rootName, absolutePath: targetReal, stat: fileStat };
}

export async function decodeImageMemoryImage(relativePath, roots) {
  const resolved = await resolveImageMemoryImage(relativePath, roots);
  let sharp;
  try { ({ default: sharp } = await import('sharp')); }
  catch (error) { throw imageError('image decoder is unavailable', 'IMAGE_DECODER_UNAVAILABLE', error); }
  try {
    const bytes = await readFile(resolved.absolutePath);
    if (bytes.length > MAX_FILE_BYTES) throw imageError('image exceeds 20 MiB', 'IMAGE_FILE_TOO_LARGE');
    if (bytes.length !== resolved.stat.size) throw imageError('image changed while it was being read', 'IMAGE_CHANGED_DURING_READ');
    const input = sharp(bytes, { animated: false, pages: 1, limitInputPixels: MAX_PIXELS });
    let metadata;
    try { metadata = await input.metadata(); } finally { input.destroy(); }
    if (!SUPPORTED_FORMATS.has(metadata.format)) throw imageError('image format is not supported', 'IMAGE_FORMAT_UNSUPPORTED');
    if (!Number.isFinite(metadata.width) || !Number.isFinite(metadata.height) || metadata.width * metadata.height > MAX_PIXELS) throw imageError('image exceeds 40 megapixels', 'IMAGE_PIXEL_LIMIT');
    const decoder = sharp(bytes, { animated: false, pages: 1, limitInputPixels: MAX_PIXELS }).rotate().flatten({ background: { r: 255, g: 255, b: 255 } }).toColourspace('srgb').removeAlpha().raw();
    let decoded;
    try { decoded = await decoder.toBuffer({ resolveWithObject: true }); } finally { decoder.destroy(); }
    const after = await stat(resolved.absolutePath);
    if (after.size !== resolved.stat.size || after.mtimeMs !== resolved.stat.mtimeMs) throw imageError('image changed while it was being read', 'IMAGE_CHANGED_DURING_READ');
    return {
      data: Buffer.from(decoded.data), width: decoded.info.width, height: decoded.info.height, channels: decoded.info.channels,
      format: metadata.format, orientation: metadata.orientation || 1, stat: after, absolutePath: resolved.absolutePath,
      relativePath: resolved.relativePath, sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (error?.code?.startsWith?.('IMAGE_')) throw error;
    if (/pixel limit|Input image exceeds pixel limit/i.test(String(error?.message || error))) throw imageError('image exceeds 40 megapixels', 'IMAGE_PIXEL_LIMIT', error);
    throw imageError('image could not be decoded', 'IMAGE_DECODE_FAILED', error);
  }
}
