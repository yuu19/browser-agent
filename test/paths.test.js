import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeOutputPath, safeOutputPathChecked } from '../src/paths.js';

test('safeOutputPath resolves a project-relative destination', () => {
  assert.equal(safeOutputPath('/tmp/project', 'docs/image.png'), join('/tmp/project', 'docs/image.png'));
});

test('safeOutputPath rejects absolute and escaping paths', () => {
  assert.throws(() => safeOutputPath('/tmp/project', '/tmp/image.png'), /absolute/);
  assert.throws(() => safeOutputPath('/tmp/project', '../image.png'), /escapes/);
});

test('safeOutputPathChecked rejects a symlink escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-path-'));
  const outside = await mkdtemp(join(tmpdir(), 'browser-agent-outside-'));
  await mkdir(join(root, 'docs'));
  await symlink(outside, join(root, 'docs', 'images'));
  await assert.rejects(
    safeOutputPathChecked(root, 'docs/images/secret.png'),
    /symbolic link/,
  );
});
