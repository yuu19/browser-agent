import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneProfile, removeWorkingProfile } from '../src/profile-workspace.js';
import { exists } from '../src/runtime.js';

test('profile snapshots copy content but exclude Chrome singleton links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-profile-'));
  const source = join(root, 'source');
  const managed = join(root, 'managed');
  const target = join(managed, 'session');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(source, 'Default'), { recursive: true });
  await writeFile(join(source, 'Default', 'Cookies'), 'private-state');
  await symlink('not-used', join(source, 'SingletonLock'));

  await cloneProfile(source, target, managed);
  assert.equal(await readFile(join(target, 'Default', 'Cookies'), 'utf8'), 'private-state');
  assert.equal(await exists(join(target, 'SingletonLock')), false);
  await removeWorkingProfile(target, managed);
  assert.equal(await exists(target), false);
});

test('profile cleanup refuses paths outside the managed working root', async () => {
  await assert.rejects(
    removeWorkingProfile('/tmp/not-managed', '/tmp/managed-root'),
    /managed runtime directory/,
  );
});
