import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentBrowserNamespace,
  agentBrowserSocketDirectory,
  safeOutputPath,
  safeOutputPathChecked,
} from '../src/paths.js';

function managedSocketPath(env) {
  return join(
    agentBrowserSocketDirectory(env),
    'namespaces',
    agentBrowserNamespace(env),
    'run',
    `ba-${'0'.repeat(32)}.sock`,
  );
}

test('agentBrowserSocketDirectory keeps the managed socket within the Linux pathname limit', () => {
  const env = {
    BROWSER_AGENT_DATA_DIR: '/tmp/browser-agent-data',
    XDG_RUNTIME_DIR: '/run/user/1000',
  };

  assert.match(agentBrowserSocketDirectory(env), /^\/run\/user\/1000\/ba-[a-f0-9]{12}$/);
  assert.ok(Buffer.byteLength(managedSocketPath(env)) <= 107);
});

test('agentBrowserSocketDirectory falls back when XDG_RUNTIME_DIR is too long', () => {
  const env = {
    BROWSER_AGENT_DATA_DIR: '/tmp/browser-agent-data',
    XDG_RUNTIME_DIR: `/tmp/${'long-runtime-'.repeat(8)}`,
  };
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';

  assert.match(agentBrowserSocketDirectory(env), new RegExp(`^${tmpdir()}/ba-${uid}-[a-f0-9]{12}$`));
  assert.ok(Buffer.byteLength(managedSocketPath(env)) <= 107);
});

test('agentBrowserSocketDirectory isolates different data roots', () => {
  const shared = { XDG_RUNTIME_DIR: '/run/user/1000' };
  const first = agentBrowserSocketDirectory({ ...shared, BROWSER_AGENT_DATA_DIR: '/tmp/first' });
  const second = agentBrowserSocketDirectory({ ...shared, BROWSER_AGENT_DATA_DIR: '/tmp/second' });

  assert.notEqual(first, second);
});

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
