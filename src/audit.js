import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporarySibling } from './paths.js';
import {
  acquireLock,
  archiveRuntimeFile,
  ensurePrivateDirectory,
  processIsAlive,
  readLock,
  releaseLock,
} from './runtime.js';

const AUDIT_MAX_ENTRIES = 1_000;
const AUDIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const AUDIT_LOCK_TIMEOUT_MS = 5_000;
const AUDIT_LOCK_RETRY_MS = 20;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reclaimAuditLock(paths, lockPath) {
  const recoveryPath = join(paths.runtime, 'audit-recovery.lock');
  const recoveryOwner = `audit-recovery:${process.pid}:${randomUUID()}`;
  try {
    await acquireLock(recoveryPath, recoveryOwner);
  } catch (error) {
    if (error.code === 'LOCK_HELD') return false;
    throw error;
  }
  try {
    let lock;
    try {
      lock = await readLock(lockPath);
    } catch {
      await archiveRuntimeFile(lockPath, paths.archive, 'damaged-audit-lock');
      return true;
    }
    if (lock && !processIsAlive(lock.pid)) {
      await archiveRuntimeFile(lockPath, paths.archive, 'stale-audit-lock');
      return true;
    }
    return false;
  } finally {
    await releaseLock(recoveryPath, recoveryOwner);
  }
}

async function acquireAuditLock(paths, owner) {
  const lockPath = join(paths.runtime, 'audit.lock');
  const deadline = Date.now() + AUDIT_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await acquireLock(lockPath, owner);
      return lockPath;
    } catch (error) {
      if (error.code !== 'LOCK_HELD') throw error;
      let needsRecovery = false;
      try {
        const lock = await readLock(lockPath);
        if (!lock) continue;
        needsRecovery = !processIsAlive(lock.pid);
      } catch {
        needsRecovery = true;
      }
      if (needsRecovery && await reclaimAuditLock(paths, lockPath)) continue;
      await delay(AUDIT_LOCK_RETRY_MS);
    }
  }
  const error = new Error('site audit log is busy');
  error.code = 'AUDIT_BUSY';
  throw error;
}

export async function appendAudit(paths, record) {
  const owner = `audit:${process.pid}:${randomUUID()}`;
  const lockPath = await acquireAuditLock(paths, owner);
  try {
    let records = [];
    try {
      records = (await readFile(paths.audit, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await archiveRuntimeFile(paths.audit, paths.archive, 'damaged-audit');
        records = [];
      }
    }
    const cutoff = Date.now() - AUDIT_MAX_AGE_MS;
    records = [...records, record]
      .filter((item) => Date.parse(item.timestamp) >= cutoff)
      .slice(-AUDIT_MAX_ENTRIES);
    const temporary = temporarySibling(paths.audit, '.jsonl');
    await ensurePrivateDirectory(paths.runtime);
    try {
      await writeFile(
        temporary,
        `${records.map((item) => JSON.stringify(item)).join('\n')}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, paths.audit);
    } finally {
      await rm(temporary, { force: true });
    }
  } finally {
    await releaseLock(lockPath, owner);
  }
}
