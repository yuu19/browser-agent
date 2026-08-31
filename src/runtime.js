import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { temporarySibling } from './paths.js';

const LOCK_GUARD_BINARY = '/usr/bin/flock';

export async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error(`managed private path is not a directory: ${path}`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`managed private directory has an unexpected owner: ${path}`);
  }
  await chmod(path, 0o700);
}

export async function writeJsonAtomic(path, value, mode = 0o600) {
  await ensurePrivateDirectory(dirname(path));
  const temporary = temporarySibling(path, '.json');
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function createLockOwner(label) {
  if (typeof label !== 'string' || label.length === 0) throw new Error('lock owner label is required');
  return `${label}:${process.pid}:${randomUUID()}`;
}

export async function verifyLockGuard(binary = LOCK_GUARD_BINARY) {
  await access(binary, constants.X_OK);
  return binary;
}

async function withLockGuard(path, callback) {
  await ensurePrivateDirectory(dirname(path));
  const guardPath = `${path}.guard`;
  await writeFile(guardPath, '', { flag: 'a', mode: 0o600 });
  await chmod(guardPath, 0o600);

  const child = spawn(await verifyLockGuard(), [
    '--exclusive',
    guardPath,
    '/bin/sh',
    '-c',
    'printf "LOCK_GUARD_READY\\n"; cat >/dev/null',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  const childExited = new Promise((resolveExit) => child.once('exit', resolveExit));
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_096); });

  await new Promise((resolveReady, rejectReady) => {
    let stdout = '';
    let ready = false;
    const fail = (error) => {
      if (ready) return;
      rejectReady(error);
    };
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      fail(new Error(`lock guard exited before acquisition (${code ?? signal}): ${stderr.trim()}`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (ready) return;
      stdout += chunk;
      if (stdout.includes('LOCK_GUARD_READY\n')) {
        ready = true;
        resolveReady();
      }
    });
  });

  try {
    return await callback();
  } finally {
    child.stdin.end();
    await childExited;
  }
}

function validateLockValue(value) {
  if (!value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof value.owner !== 'string'
    || value.owner.length === 0
    || !Number.isInteger(value.pid)
    || value.pid <= 0
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('invalid lock');
  }
}

async function readLockSnapshot(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    const [contents, info] = await Promise.all([handle.readFile('utf8'), handle.stat()]);
    const value = JSON.parse(contents);
    validateLockValue(value);
    return { value, dev: info.dev, ino: info.ino };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot verify damaged lock file: ${path}`);
  } finally {
    await handle?.close();
  }
}

function sameLock(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.value.owner === right.value.owner;
}

export async function acquireLock(path, owner, metadata = {}) {
  await ensurePrivateDirectory(dirname(path));
  const value = { ...metadata, owner, pid: process.pid, createdAt: new Date().toISOString() };
  const temporary = temporarySibling(path, '.lock');
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // link(2) publishes only when the path is absent; it never replaces an existing owner.
    await link(temporary, path);
    return value;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let current = 'unknown owner';
    try {
      current = JSON.parse(await readFile(path, 'utf8')).owner ?? current;
    } catch {
      // The existence of the lock is sufficient even if its metadata is damaged.
    }
    const lockError = new Error(`site profile is already in use by ${current}; close that session before continuing`);
    lockError.code = 'LOCK_HELD';
    throw lockError;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readLock(path) {
  return (await readLockSnapshot(path))?.value ?? null;
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export async function archiveRuntimeFile(path, archiveRoot, reason) {
  if (!(await exists(path))) return null;
  await ensurePrivateDirectory(archiveRoot);
  const stamp = new Date().toISOString().replaceAll(':', '-');
  const destination = join(archiveRoot, `${stamp}-${reason}-${randomUUID()}-${basename(path)}`);
  await rename(path, destination);
  return destination;
}

export async function reclaimLock(path, archiveRoot, reason, validate, hooks = {}) {
  const candidate = await readLockSnapshot(path);
  if (!candidate) return false;
  await validate(candidate.value);
  await hooks.afterValidation?.(candidate.value);
  await hooks.beforeGuard?.(candidate.value);

  return withLockGuard(path, async () => {
    const current = await readLockSnapshot(path);
    if (!sameLock(candidate, current)) return false;
    await hooks.beforeArchive?.(candidate.value);
    await ensurePrivateDirectory(archiveRoot);
    const stamp = new Date().toISOString().replaceAll(':', '-');
    const destination = join(archiveRoot, `${stamp}-${reason}-${randomUUID()}-${basename(path)}`);
    await rename(path, destination);
    return true;
  });
}

export async function releaseLock(path, expectedOwner) {
  await withLockGuard(path, async () => {
    const candidate = await readLockSnapshot(path);
    if (!candidate) return;
    if (expectedOwner && candidate.value.owner !== expectedOwner) {
      throw new Error(`refusing to release a lock owned by ${candidate.value.owner}`);
    }
    const current = await readLockSnapshot(path);
    if (!sameLock(candidate, current)) throw new Error(`refusing to release a replaced lock: ${path}`);
    await rm(path);
  });
}

export async function replaceFileAtomic(temporary, output) {
  await rename(temporary, output);
}
