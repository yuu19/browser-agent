import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

export async function acquireLock(path, owner) {
  await ensurePrivateDirectory(dirname(path));
  const value = { owner, pid: process.pid, createdAt: new Date().toISOString() };
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let current = 'unknown owner';
    try {
      current = JSON.parse(await readFile(path, 'utf8')).owner ?? current;
    } catch {
      // The existence of the lock is sufficient even if its metadata is damaged.
    }
    throw new Error(`site profile is already in use by ${current}; close that session before continuing`);
  }
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
