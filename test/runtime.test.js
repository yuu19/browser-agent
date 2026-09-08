import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireLock,
  createLockOwner,
  processIsAlive,
  readLock,
  reclaimLock,
  releaseLock,
  verifyLockGuard,
  writeJsonAtomic,
} from '../src/runtime.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('profile lock is exclusive and ownership is checked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-lock-'));
  const lock = join(root, 'locks', 'site.json');
  await acquireLock(lock, 'first');
  await assert.rejects(acquireLock(lock, 'second'), /already in use by first/);
  await assert.rejects(releaseLock(lock, 'second'), /owned by first/);
  await releaseLock(lock, 'first');
  await acquireLock(lock, 'second');
  await releaseLock(lock, 'second');
});

test('lock owner tokens are unique for every acquisition lifecycle', () => {
  assert.notEqual(createLockOwner('site:example'), createLockOwner('site:example'));
});

test('lock guard binary is fixed and executable', async () => {
  assert.equal(await verifyLockGuard(), '/usr/bin/flock');
  await assert.rejects(verifyLockGuard('/missing/browser-agent-flock'), /ENOENT/);
});

for (const lockKind of ['site', 'command', 'unlock']) {
  test(`${lockKind} reclamation never archives a replacement owner`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `browser-agent-${lockKind}-race-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const archive = join(root, 'archive');
    const lock = join(root, 'locks', `${lockKind}.json`);

    for (let iteration = 0; iteration < 5; iteration += 1) {
      const staleOwner = createLockOwner(`${lockKind}:stale`);
      await writeJsonAtomic(lock, {
        owner: staleOwner,
        pid: 2_147_483_647,
        createdAt: new Date().toISOString(),
      });
      const bothValidated = deferred();
      const allowSlowReclaimer = deferred();
      let validationCount = 0;
      const afterValidation = async () => {
        validationCount += 1;
        if (validationCount === 2) bothValidated.resolve();
        await bothValidated.promise;
      };
      const validate = async (metadata) => {
        assert.equal(metadata.owner, staleOwner);
        assert.equal(processIsAlive(metadata.pid), false);
      };

      const fast = reclaimLock(lock, archive, `${lockKind}-stale`, validate, { afterValidation });
      const slow = reclaimLock(lock, archive, `${lockKind}-stale`, validate, {
        afterValidation,
        beforeGuard: () => allowSlowReclaimer.promise,
      });
      await bothValidated.promise;
      assert.equal(await fast, true);

      const liveOwner = createLockOwner(`${lockKind}:live`);
      await acquireLock(lock, liveOwner);
      allowSlowReclaimer.resolve();
      assert.equal(await slow, false);
      assert.equal((await readLock(lock)).owner, liveOwner);
      await releaseLock(lock, liveOwner);
    }
  });
}

test('atomic JSON state is private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-json-'));
  const path = join(root, 'auth', 'state.json');
  await writeJsonAtomic(path, { cookies: [] });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { cookies: [] });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
