import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, chmod, link, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { temporarySibling } from './paths.js';

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

export async function acquireLock(path, owner, metadata = {}) {
  await ensurePrivateDirectory(dirname(path));
  const value = { ...metadata, owner, pid: process.pid, createdAt: new Date().toISOString() };
  const temporary = temporarySibling(path, '.lock');
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // Publish a complete inode atomically; readers must never observe a partially written lock.
    await link(temporary, path);
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
  if (!(await exists(path))) return null;
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
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
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`cannot verify damaged lock file: ${path}`);
  }
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

export async function releaseLock(path, expectedOwner) {
  if (!(await exists(path))) return;
  if (expectedOwner) {
    try {
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (current.owner !== expectedOwner) {
        throw new Error(`refusing to release a lock owned by ${current.owner}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`cannot verify damaged lock file: ${path}`);
      throw error;
    }
  }
  await rm(path, { force: true });
}

export async function replaceFileAtomic(temporary, output) {
  await rename(temporary, output);
}
