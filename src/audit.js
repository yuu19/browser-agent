import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporarySibling } from './paths.js';
import {
  acquireLock,
  archiveRuntimeFile,
  createLockOwner,
  ensurePrivateDirectory,
  processIsAlive,
  readLock,
  reclaimLock,
  releaseLock,
} from './runtime.js';

const AUDIT_MAX_ENTRIES = 1_000;
const AUDIT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const AUDIT_LOCK_TIMEOUT_MS = 5_000;
const AUDIT_LOCK_RETRY_MS = 20;
const auditQueues = new Map();

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function busyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function withAuditQueue(key, operation) {
  const previous = auditQueues.get(key) ?? Promise.resolve();
  const running = previous.then(operation);
  const tail = running.catch(() => {});
  auditQueues.set(key, tail);
  try {
    return await running;
  } finally {
    if (auditQueues.get(key) === tail) auditQueues.delete(key);
  }
}

async function acquireRecoveryLock(paths, hooks) {
  const recoveryPath = join(paths.runtime, 'audit-recovery.lock');
  const recoveryOwner = createLockOwner('audit-recovery');
  try {
    await acquireLock(recoveryPath, recoveryOwner);
  } catch (error) {
    if (error.code !== 'LOCK_HELD') throw error;
    const reclaimed = await reclaimLock(
      recoveryPath,
      paths.archive,
      'stale-audit-recovery-lock',
      async (current) => {
        if (processIsAlive(current.pid)) {
          throw busyError('RECOVERY_BUSY', 'audit recovery is owned by a live process');
        }
      },
      hooks?.recoveryReclaim,
    ).catch((reclaimError) => {
      if (reclaimError.code === 'RECOVERY_BUSY') return false;
      throw reclaimError;
    });
    if (!reclaimed) return null;
    try {
      await acquireLock(recoveryPath, recoveryOwner);
    } catch (retryError) {
      if (retryError.code === 'LOCK_HELD') return null;
      throw retryError;
    }
  }
  return { path: recoveryPath, owner: recoveryOwner };
}

export async function reclaimAuditLock(paths, lockPath, { hooks } = {}) {
  const recoveryLock = await acquireRecoveryLock(paths, hooks);
  if (!recoveryLock) return false;
  try {
    await hooks?.afterRecoveryAcquired?.(recoveryLock);
    return reclaimLock(lockPath, paths.archive, 'stale-audit-lock', async (lock) => {
      if (processIsAlive(lock.pid)) {
        throw busyError('AUDIT_OWNER_LIVE', 'audit is owned by a live process');
      }
    }, hooks?.auditReclaim).catch((error) => {
      if (error.code === 'AUDIT_OWNER_LIVE') return false;
      throw error;
    });
  } finally {
    await releaseLock(recoveryLock.path, recoveryLock.owner);
  }
}

async function acquireAuditLock(paths, owner, options) {
  const lockPath = join(paths.runtime, 'audit.lock');
  const deadline = Date.now() + (options.lockTimeoutMs ?? AUDIT_LOCK_TIMEOUT_MS);
  const retryMs = options.lockRetryMs ?? AUDIT_LOCK_RETRY_MS;
  while (Date.now() < deadline) {
    try {
      await acquireLock(lockPath, owner);
      return lockPath;
    } catch (error) {
      if (error.code !== 'LOCK_HELD') throw error;
      const lock = await readLock(lockPath);
      if (!lock) continue;
      if (!processIsAlive(lock.pid) && await reclaimAuditLock(paths, lockPath, options)) continue;
      await delay(retryMs);
    }
  }
  const error = new Error('site audit log is busy');
  error.code = 'AUDIT_BUSY';
  throw error;
}

export async function appendAudit(paths, record, options = {}) {
  return withAuditQueue(paths.audit, async () => {
    const owner = createLockOwner('audit');
    const lockPath = await acquireAuditLock(paths, owner, options);
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
  });
}
