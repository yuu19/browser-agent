import test from 'node:test';
import assert from 'node:assert/strict';
import {
  managedSessionName,
  normalizeBrowserCommand,
  runBrowserCommand,
  unlockSite,
} from '../src/agent-browser.js';
import { verifyAgentBrowserBinary, verifyAgentBrowserPolicy } from '../src/agent-browser-binary.js';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { siteRuntimePaths } from '../src/paths.js';
import { exists } from '../src/runtime.js';

const site = {
  id: 'example',
  baseUrl: 'https://app.example.com/root/',
  loginUrl: 'https://login.example.com/',
  allowedOrigins: ['https://app.example.com', 'https://login.example.com'],
};

test('browser command allowlist keeps native syntax for ordinary UI operations', () => {
  assert.deepEqual(
    normalizeBrowserCommand(site, ['open', '../dashboard']).args,
    ['open', 'https://app.example.com/dashboard'],
  );
  assert.deepEqual(normalizeBrowserCommand(site, ['click', '@e3']).args, ['click', '@e3']);
  assert.deepEqual(
    normalizeBrowserCommand(site, ['get', 'styles', '@e3']).args,
    ['get', 'styles', '@e3'],
  );
  assert.deepEqual(
    normalizeBrowserCommand(site, ['read', '--outline', '--filter', 'billing']).args,
    ['read', '--outline', '--filter', 'billing'],
  );
});

test('browser command allowlist rejects secondary HTTP, code, files, and raw capture paths', () => {
  for (const args of [
    ['read', 'https://app.example.com/docs'],
    ['read', '--llms', 'full'],
    ['eval', 'document.title'],
    ['upload', '#file', 'secret.txt'],
    ['download', '#report', 'report.pdf'],
    ['screenshot'],
    ['pdf', 'page.pdf'],
    ['get', 'html', 'body'],
    ['get', 'value', '#secret'],
    ['wait', '--fn', 'window.ready'],
    ['wait', '--download'],
    ['tab', 'new'],
    ['window', 'new'],
    ['network', 'requests'],
    ['cookies', 'get'],
  ]) {
    assert.throws(() => normalizeBrowserCommand(site, args), /BROWSER_POLICY_DENIED/);
  }
});

test('managed global options cannot be smuggled after a permitted command', () => {
  for (const args of [
    ['open', '--config=/tmp/unsafe.json'],
    ['fill', '#field', '--profile', '/tmp/profile'],
    ['click', '#button', '--headed'],
    ['snapshot', '--json'],
    ['type', '#field', 'value', '--action-policy=/tmp/allow-all.json'],
  ]) {
    assert.throws(() => normalizeBrowserCommand(site, args), /managed and cannot be overridden/);
  }
});

test('command-specific parsers reject unapproved option-shaped arguments', () => {
  for (const args of [
    ['fill', '#field', 'value', '--force'],
    ['fill', '#field', '--force'],
    ['type', '#field', 'value', '--force'],
    ['type', '#field', '--force'],
    ['keyboard', 'type', 'value', '--delay', '10'],
    ['keyboard', 'type', '--force'],
    ['select', '#choice', '--label'],
    ['find', 'label', 'Email', 'fill', 'value', '--force'],
  ]) {
    assert.throws(() => normalizeBrowserCommand(site, args), /BROWSER_POLICY_DENIED/);
  }
});

test('explicit navigation is restricted to configured origins', () => {
  assert.equal(
    normalizeBrowserCommand(site, ['open', 'https://login.example.com/mfa']).navigationUrl,
    'https://login.example.com/mfa',
  );
  assert.throws(
    () => normalizeBrowserCommand(site, ['open', 'https://example.net/']),
    /outside the configured top-level origins/,
  );
});

test('fixed local agent-browser binary matches the approved manifest', async () => {
  const result = await verifyAgentBrowserBinary();
  assert.equal(result.version, '0.35.1');
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    verifyAgentBrowserBinary({ platform: 'darwin', arch: 'arm64' }),
    /not approved/,
  );
});

test('agent-browser policy exactly matches the approved default-deny action set', async () => {
  assert.deepEqual(await verifyAgentBrowserPolicy(), { default: 'deny', actions: 51 });
});

test('modified action policies fail exact verification', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policyPath = join(root, 'policy.json');
  await writeFile(policyPath, '{"default":"allow","allow":[]}\n');
  await assert.rejects(
    verifyAgentBrowserPolicy({ policyPath }),
    /does not match the approved default-deny policy/,
  );
});

test('managed session names encode site, session, and purpose without concatenation collisions', () => {
  const first = managedSessionName('foo-bar', 'baz');
  const second = managedSessionName('foo', 'bar-baz');
  assert.notEqual(first, second);
  assert.notEqual(first, managedSessionName('foo-bar', 'baz', 'login'));
  assert.match(first, /^ba-[a-f0-9]{32}$/);
});

test('pre-bootstrap setup failure rolls back every disposable session artifact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-setup-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: root, XDG_RUNTIME_DIR: root };
  const failingSite = {
    ...site,
    authMode: 'profile',
    browser: {
      channel: 'unsupported',
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      locale: 'ja-JP',
      captureHeaded: false,
    },
  };
  const paths = siteRuntimePaths(failingSite.id, env);
  await assert.rejects(
    runBrowserCommand(failingSite, 'rollback', ['open'], env),
    /configured browser channel is not supported/,
  );
  for (const directory of [paths.sessions, paths.workingProfiles, paths.downloads, paths.configs]) {
    assert.deepEqual(await readdir(directory).catch(() => []), []);
  }
});

test('unlock archives only a verified stale lock and refuses an active owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-unlock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: root, XDG_RUNTIME_DIR: root };
  const paths = siteRuntimePaths('example', env);
  await mkdir(paths.profile, { recursive: true });
  await mkdir(join(paths.runtimeRoot, 'locks'), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({
    owner: 'stale',
    pid: 2_147_483_647,
    createdAt: new Date().toISOString(),
  }));
  assert.equal(await unlockSite({ id: 'example' }, env), 1);
  assert.equal(await exists(paths.lock), false);

  await writeFile(paths.lock, JSON.stringify({
    owner: 'active',
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }));
  await assert.rejects(unlockSite({ id: 'example' }, env), /RUNTIME_ACTIVE/);
  assert.equal(await exists(paths.lock), true);
});

test('unlock refuses damaged locks and session paths outside managed runtime roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-unlock-validation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: root, XDG_RUNTIME_DIR: root };
  const paths = siteRuntimePaths('example', env);
  await mkdir(join(paths.runtimeRoot, 'locks'), { recursive: true });
  await writeFile(paths.lock, JSON.stringify({ owner: 'damaged', pid: 999_999 }));
  await assert.rejects(unlockSite({ id: 'example' }, env), /damaged lock file/);
  assert.equal(await exists(paths.lock), true);

  await rm(paths.lock, { force: true });
  const protectedDirectory = join(root, 'protected');
  const protectedFile = join(protectedDirectory, 'keep.txt');
  await mkdir(protectedDirectory, { recursive: true });
  await writeFile(protectedFile, 'keep');
  await mkdir(paths.sessions, { recursive: true });
  await writeFile(join(paths.sessions, 'ba-example-malicious.json'), JSON.stringify({
    kind: 'browser',
    siteId: 'example',
    sessionName: 'ba-example-malicious',
    profilePath: protectedDirectory,
    workingProfile: protectedDirectory,
    downloadPath: join(paths.downloads, 'ba-example-malicious'),
    configPath: join(paths.configs, 'ba-example-malicious.json'),
    createdAt: new Date().toISOString(),
  }));
  await assert.rejects(unlockSite({ id: 'example' }, env), /session metadata is damaged/);
  assert.equal(await exists(protectedFile), true);
});
