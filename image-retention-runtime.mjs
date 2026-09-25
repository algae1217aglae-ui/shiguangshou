import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function runtimeError(code = 'RETENTION_RUNTIME_UNSAFE', message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function samePath(left, right) {
  const a = resolve(left); const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertPlainDirectory(path, code) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { throw runtimeError(code, String(error?.message || error)); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw runtimeError(code, 'directory is not plain');
  let real;
  try { real = realpathSync(path); }
  catch (error) { throw runtimeError(code, String(error?.message || error)); }
  if (!samePath(real, path)) throw runtimeError(code, 'directory resolves outside its lexical path');
}

function createChildDirectory(parent, child, code) {
  assertPlainDirectory(parent, code);
  if (!existsSync(child)) {
    try { mkdirSync(child); }
    catch (error) { if (error?.code !== 'EEXIST') throw runtimeError(code, String(error?.message || error)); }
  }
  assertPlainDirectory(parent, code);
  assertPlainDirectory(child, code);
  if (!samePath(dirname(realpathSync(child)), realpathSync(parent))) throw runtimeError(code, 'child escaped its parent');
}

export function ensureImageRetentionRuntime(runtimeRoot, { code = 'RETENTION_RUNTIME_UNSAFE' } = {}) {
  const runtime = resolve(runtimeRoot || '');
  const data = dirname(runtime);
  const projectRoot = dirname(data);
  if (basename(runtime).toLowerCase() !== 'image-retention' || basename(data).toLowerCase() !== 'data' || projectRoot === data) {
    throw runtimeError(code, 'unexpected runtime layout');
  }
  assertPlainDirectory(projectRoot, code);
  createChildDirectory(projectRoot, data, code);
  createChildDirectory(data, runtime, code);
  return runtime;
}

export function ensureImageRetentionRuntimeDirectory(runtimeRoot, name, { code = 'RETENTION_RUNTIME_UNSAFE' } = {}) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(String(name || ''))) throw runtimeError(code, 'unsafe child name');
  const runtime = ensureImageRetentionRuntime(runtimeRoot, { code });
  const child = join(runtime, name);
  createChildDirectory(runtime, child, code);
  return child;
}

export function imageRetentionRuntimeFile(runtimeRoot, name, { code = 'RETENTION_RUNTIME_UNSAFE' } = {}) {
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(String(name || ''))) throw runtimeError(code, 'unsafe file name');
  return join(ensureImageRetentionRuntime(runtimeRoot, { code }), name);
}

export function writeImageRetentionRuntimeFileAtomic(runtimeRoot, name, value, { code = 'RETENTION_RUNTIME_UNSAFE', mode } = {}) {
  const runtime = ensureImageRetentionRuntime(runtimeRoot, { code });
  const target = imageRetentionRuntimeFile(runtime, name, { code });
  const temp = join(runtime, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temp, 'wx', mode == null ? undefined : mode);
    writeFileSync(descriptor, value);
    closeSync(descriptor); descriptor = null;
    ensureImageRetentionRuntime(runtime, { code });
    renameSync(temp, target);
    return target;
  } catch (error) {
    if (descriptor != null) try { closeSync(descriptor); } catch {}
    try { unlinkSync(temp); } catch {}
    if (error?.code === code) throw error;
    throw error;
  }
}

export function readImageRetentionRuntimeFile(runtimeRoot, name, { code = 'RETENTION_RUNTIME_UNSAFE' } = {}) {
  const path = imageRetentionRuntimeFile(runtimeRoot, name, { code });
  return readFileSync(path, 'utf8');
}
