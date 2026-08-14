import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, releaseLock, writeJsonAtomic } from '../src/runtime.js';

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

test('atomic JSON state is private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-json-'));
  const path = join(root, 'auth', 'state.json');
  await writeJsonAtomic(path, { cookies: [] });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { cookies: [] });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
