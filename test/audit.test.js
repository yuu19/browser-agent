import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit, reclaimAuditLock } from '../src/audit.js';
import { siteRuntimePaths } from '../src/paths.js';
import {
  createLockOwner,
  exists,
  readLock,
  releaseLock,
  writeJsonAtomic,
} from '../src/runtime.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function testPaths(root) {
  return siteRuntimePaths('example', {
    ...process.env,
    BROWSER_AGENT_DATA_DIR: root,
    XDG_RUNTIME_DIR: root,
  });
}

async function writeDeadLock(path, label) {
  await writeJsonAtomic(path, {
    owner: createLockOwner(label),
    pid: 2_147_483_647,
    createdAt: new Date().toISOString(),
  });
}

function childExit(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal, stderr }));
  });
}

test('site-wide audit updates retain concurrent records from different sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = testPaths(root);
  const records = Array.from({ length: 40 }, (_, index) => ({
    timestamp: new Date().toISOString(),
    site: 'example',
    session: `session-${index % 4}`,
    action: `action-${index}`,
    outcome: 'success',
  }));

  await Promise.all(records.map((record) => appendAudit(paths, record)));

  const actual = (await readFile(paths.audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(actual.length, records.length);
  assert.deepEqual(
    new Set(actual.map((record) => record.action)),
    new Set(records.map((record) => record.action)),
  );
});

test('append recovers dead audit and recovery owners without losing the record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-audit-dead-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = testPaths(root);
  const auditLock = join(paths.runtime, 'audit.lock');
  const recoveryLock = join(paths.runtime, 'audit-recovery.lock');
  await writeDeadLock(auditLock, 'audit:dead');
  await writeDeadLock(recoveryLock, 'audit-recovery:dead');

  const record = {
    timestamp: new Date().toISOString(),
    site: 'example',
    session: 'dead-recovery',
    action: 'append',
    outcome: 'success',
  };
  await appendAudit(paths, record);

  assert.equal(await exists(auditLock), false);
  assert.equal(await exists(recoveryLock), false);
  const records = (await readFile(paths.audit, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records, [record]);
});

test('append never reclaims a live audit recovery owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-audit-live-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = testPaths(root);
  const auditLock = join(paths.runtime, 'audit.lock');
  const recoveryLock = join(paths.runtime, 'audit-recovery.lock');
  await writeDeadLock(auditLock, 'audit:dead');
  const recoveryOwner = createLockOwner('audit-recovery:live');
  await writeJsonAtomic(recoveryLock, {
    owner: recoveryOwner,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });

  await assert.rejects(
    appendAudit(paths, {
      timestamp: new Date().toISOString(),
      site: 'example',
      session: 'live-recovery',
      action: 'append',
      outcome: 'success',
    }, { lockTimeoutMs: 100, lockRetryMs: 5 }),
    (error) => error.code === 'AUDIT_BUSY',
  );
  assert.equal((await readLock(recoveryLock)).owner, recoveryOwner);
  assert.equal(await exists(auditLock), true);
  await releaseLock(recoveryLock, recoveryOwner);
});

test('damaged audit ownership metadata is preserved and fails closed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-audit-damaged-locks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = testPaths(root);
  const auditLock = join(paths.runtime, 'audit.lock');
  const recoveryLock = join(paths.runtime, 'audit-recovery.lock');
  const record = {
    timestamp: new Date().toISOString(),
    site: 'example',
    session: 'damaged-lock',
    action: 'append',
    outcome: 'success',
  };

  await writeJsonAtomic(auditLock, { owner: 'damaged-audit', pid: 2_147_483_647 });
  await assert.rejects(appendAudit(paths, record), /cannot verify damaged lock file/);
  assert.equal(await exists(auditLock), true);

  await rm(auditLock);
  await writeDeadLock(auditLock, 'audit:dead-with-damaged-recovery');
  await writeJsonAtomic(recoveryLock, { owner: 'damaged-recovery', pid: 2_147_483_647 });
  await assert.rejects(appendAudit(paths, record), /cannot verify damaged lock file/);
  assert.equal(await exists(auditLock), true);
  assert.equal(await exists(recoveryLock), true);
});

test('a crash after recovery acquisition is reclaimable by the next append', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-audit-recovery-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = testPaths(root);
  const auditLock = join(paths.runtime, 'audit.lock');
  const recoveryLock = join(paths.runtime, 'audit-recovery.lock');
  await writeDeadLock(auditLock, 'audit:dead-before-crash');

  const auditModule = new URL('../src/audit.js', import.meta.url).href;
  const pathsModule = new URL('../src/paths.js', import.meta.url).href;
  const childCode = `
    import { reclaimAuditLock } from ${JSON.stringify(auditModule)};
    import { siteRuntimePaths } from ${JSON.stringify(pathsModule)};
    const paths = siteRuntimePaths('example', {
      ...process.env,
      BROWSER_AGENT_DATA_DIR: ${JSON.stringify(root)},
      XDG_RUNTIME_DIR: ${JSON.stringify(root)},
    });
    await reclaimAuditLock(paths, ${JSON.stringify(auditLock)}, {
      hooks: { afterRecoveryAcquired: () => process.exit(91) },
    });
  `;
  const crashed = await childExit(childCode);
  assert.equal(crashed.exitCode, 91, crashed.stderr);
  assert.equal(await exists(auditLock), true);
  assert.equal(await exists(recoveryLock), true);
  assert.equal((await readLock(recoveryLock)).pid > 0, true);

  const record = {
    timestamp: new Date().toISOString(),
    site: 'example',
    session: 'crash-recovery',
    action: 'append',
    outcome: 'success',
  };
  await appendAudit(paths, record);
  const records = (await readFile(paths.audit, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records, [record]);
  assert.equal(await exists(auditLock), false);
  assert.equal(await exists(recoveryLock), false);
});

test('competing recovery owners cannot remove a replacement recovery lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-audit-reclaimer-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = testPaths(root);
  const auditLock = join(paths.runtime, 'audit.lock');
  const recoveryLock = join(paths.runtime, 'audit-recovery.lock');
  await writeDeadLock(auditLock, 'audit:dead-race');
  await writeDeadLock(recoveryLock, 'audit-recovery:dead-race');

  const bothValidated = deferred();
  const allowSlow = deferred();
  const fastOwnsRecovery = deferred();
  const allowFast = deferred();
  let validations = 0;
  const afterValidation = async () => {
    validations += 1;
    if (validations === 2) bothValidated.resolve();
    await bothValidated.promise;
  };
  const fast = reclaimAuditLock(paths, auditLock, {
    hooks: {
      recoveryReclaim: { afterValidation },
      afterRecoveryAcquired: async (lock) => {
        fastOwnsRecovery.resolve(lock);
        await allowFast.promise;
      },
    },
  });
  const slow = reclaimAuditLock(paths, auditLock, {
    hooks: {
      recoveryReclaim: {
        afterValidation,
        beforeGuard: () => allowSlow.promise,
      },
    },
  });
  await bothValidated.promise;
  const fastLock = await fastOwnsRecovery.promise;
  allowSlow.resolve();
  assert.equal(await slow, false);
  assert.equal((await readLock(recoveryLock)).owner, fastLock.owner);
  allowFast.resolve();
  assert.equal(await fast, true);
  assert.equal(await exists(auditLock), false);
  assert.equal(await exists(recoveryLock), false);

  const records = Array.from({ length: 20 }, (_, index) => ({
    timestamp: new Date().toISOString(),
    site: 'example',
    session: `recovered-${index % 2}`,
    action: `recovered-${index}`,
    outcome: 'success',
  }));
  await Promise.all(records.map((record) => appendAudit(paths, record)));
  const actual = (await readFile(paths.audit, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(actual.length, records.length);
  assert.deepEqual(new Set(actual.map((record) => record.action)), new Set(records.map((record) => record.action)));
  assert.deepEqual(await readdir(paths.runtime).then((entries) => entries.filter((name) => name.endsWith('.lock'))), []);
});
