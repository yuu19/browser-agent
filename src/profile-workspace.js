import { constants } from 'node:fs';
import { chmod, cp, rm } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { ensurePrivateDirectory, exists } from './runtime.js';

const TRANSIENT_PROFILE_ENTRIES = new Set([
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
]);

function assertContained(root, target, label) {
  const absoluteRoot = resolve(root);
  const absoluteTarget = resolve(target);
  const rel = relative(absoluteRoot, absoluteTarget);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must stay below its managed runtime directory`);
  }
  return absoluteTarget;
}

export async function cloneProfile(source, destination, managedRoot) {
  const target = assertContained(managedRoot, destination, 'working profile');
  if (await exists(target)) throw new Error('working profile already exists');
  await ensurePrivateDirectory(source);
  await ensurePrivateDirectory(managedRoot);
  try {
    await cp(source, target, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      mode: constants.COPYFILE_FICLONE,
      filter: (path) => !TRANSIENT_PROFILE_ENTRIES.has(basename(path)),
    });
    await chmod(target, 0o700);
    return target;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function removeWorkingProfile(destination, managedRoot) {
  const target = assertContained(managedRoot, destination, 'working profile');
  await rm(target, { recursive: true, force: true });
}
