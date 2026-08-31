import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireCommandLock,
  acquireSiteLock,
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
import {
  acquireLock,
  createLockOwner,
  exists,
  processIsAlive,
  readLock,
  reclaimLock,
  releaseLock,
  writeJsonAtomic,
} from '../src/runtime.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function competingReclaimerHooks() {
  const bothValidated = deferred();
  const allowSlow = deferred();
  let validationCount = 0;
  const afterValidation = async () => {
    validationCount += 1;
    if (validationCount === 2) bothValidated.resolve();
    await bothValidated.promise;
  };
  return {
    bothValidated,
    allowSlow,
    fast: { afterValidation },
    slow: { afterValidation, beforeGuard: () => allowSlow.promise },
  };
}

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

test('site lock acquisition does not reclaim a competing replacement owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-site-lock-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: root, XDG_RUNTIME_DIR: root };
  const paths = siteRuntimePaths('example', env);
  const verifyInactive = async () => {};

  for (let iteration = 0; iteration < 3; iteration += 1) {
    await writeJsonAtomic(paths.lock, {
      owner: createLockOwner('site:stale'),
      pid: 2_147_483_647,
      createdAt: new Date().toISOString(),
    });
    const hooks = competingReclaimerHooks();
    const fastOwner = createLockOwner('site:fast');
    const slowOwner = createLockOwner('site:slow');
    const fast = acquireSiteLock(paths, fastOwner, {}, env, { hooks: hooks.fast, verifyInactive });
    const slow = acquireSiteLock(paths, slowOwner, {}, env, { hooks: hooks.slow, verifyInactive });
    await hooks.bothValidated.promise;
    await fast;
    hooks.allowSlow.resolve();
    await assert.rejects(slow, /RUNTIME_ACTIVE/);
    assert.equal((await readLock(paths.lock)).owner, fastOwner);
    await releaseLock(paths.lock, fastOwner);
  }
});

test('command lock acquisition does not reclaim a competing replacement owner', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-command-lock-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: root, XDG_RUNTIME_DIR: root };
  const paths = siteRuntimePaths('example', env);
  const name = managedSessionName('example', 'command-race');
  const lockPath = join(paths.commandLocks, `${name}.json`);

  for (let iteration = 0; iteration < 3; iteration += 1) {
    await writeJsonAtomic(lockPath, {
      owner: createLockOwner('command:stale'),
      pid: 2_147_483_647,
      createdAt: new Date().toISOString(),
    });
    const hooks = competingReclaimerHooks();
    const fast = acquireCommandLock(paths, name, { hooks: hooks.fast });
    const slow = acquireCommandLock(paths, name, { hooks: hooks.slow });
    await hooks.bothValidated.promise;
    const acquired = await fast;
    hooks.allowSlow.resolve();
    await assert.rejects(slow, /SESSION_BUSY/);
    assert.equal((await readLock(lockPath)).owner, acquired.owner);
    await releaseLock(acquired.path, acquired.owner);
  }
});

test('unlock does not archive a live lock installed after stale validation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-unlock-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: root, XDG_RUNTIME_DIR: root };
  const paths = siteRuntimePaths('example', env);
  await mkdir(paths.profile, { recursive: true });
  const staleOwner = createLockOwner('unlock:stale');
  await writeJsonAtomic(paths.lock, {
    owner: staleOwner,
    pid: 2_147_483_647,
    createdAt: new Date().toISOString(),
  });
  const validated = deferred();
  const continueUnlock = deferred();
  const unlock = unlockSite({ id: 'example' }, env, {
    lockHooks: {
      afterValidation: () => validated.resolve(),
      beforeGuard: () => continueUnlock.promise,
    },
  });
  await validated.promise;
  assert.equal(await reclaimLock(paths.lock, paths.archive, 'test-stale', async (metadata) => {
    assert.equal(metadata.owner, staleOwner);
    assert.equal(processIsAlive(metadata.pid), false);
  }), true);
  const liveOwner = createLockOwner('unlock:live');
  await acquireLock(paths.lock, liveOwner);
  continueUnlock.resolve();
  assert.equal(await unlock, 0);
  assert.equal((await readLock(paths.lock)).owner, liveOwner);
  await releaseLock(paths.lock, liveOwner);
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
