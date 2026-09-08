import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeLogin,
  managedSessionName,
  openLogin,
  runBrowserCommand,
  saveLogin,
} from '../src/agent-browser.js';
import { verifyAgentBrowserBinary } from '../src/agent-browser-binary.js';
import { agentBrowserNamespace, siteRuntimePaths } from '../src/paths.js';
import { exists, readLock } from '../src/runtime.js';

const integrationTest = process.env.BROWSER_AGENT_INTEGRATION === '1' ? test : test.skip;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

integrationTest('agent-browser is contained by bootstrap, policy, locale, and all-tab checks', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-engine-'));
  const external = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>external</title><p>external origin</p>');
  });
  const externalAddress = await listen(external);
  const externalOrigin = `http://127.0.0.1:${externalAddress.port}`;
  const app = createServer((request, response) => {
    const acceptLanguage = request.headers['accept-language'] ?? '';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <title>fixture</title>
      <p id="accept-language">${acceptLanguage}</p>
      <p id="navigator-language"></p>
      <p id="viewport"></p>
      <input id="field" value="">
      <input id="check" type="checkbox">
      <select id="choice"><option value="a">A</option><option value="b">B</option></select>
      <button id="same-origin" onclick="window.open('/same-origin')">same</button>
      <button id="external-origin" onclick="window.open('${externalOrigin}/')">external</button>
      <script>
        document.querySelector('#navigator-language').textContent = navigator.language;
        document.querySelector('#viewport').textContent = innerWidth + 'x' + innerHeight + '@' + devicePixelRatio;
      </script>`);
  });
  const appAddress = await listen(app);
  const origin = `http://127.0.0.1:${appAddress.port}`;
  const env = {
    ...process.env,
    BROWSER_AGENT_DATA_DIR: root,
    XDG_RUNTIME_DIR: join(root, 'runtime-with-a-deliberately-long-user-specific-path'),
  };
  const site = {
    id: 'example',
    baseUrl: `${origin}/`,
    loginUrl: `${origin}/login`,
    allowedOrigins: [origin],
    authMode: 'state',
    browser: {
      channel: 'chromium',
      viewport: { width: 900, height: 700 },
      deviceScaleFactor: 1,
      locale: 'ja-JP',
      captureHeaded: false,
    },
  };
  const paths = siteRuntimePaths(site.id, env);
  const socketPath = join(
    paths.socketDirectory,
    'namespaces',
    agentBrowserNamespace(env),
    'run',
    `${managedSessionName(site.id, 'integration')}.sock`,
  );
  assert.ok(Buffer.byteLength(socketPath) <= 107);
  await mkdir(dirname(paths.authState), { recursive: true });
  await writeFile(paths.authState, '{"cookies":[],"origins":[]}\n', { mode: 0o600 });

  try {
    const opened = await runBrowserCommand(site, 'integration', ['open'], env);
    assert.equal(JSON.parse(opened).success, true);
    assert.match(opened, new RegExp(`127\\.0\\.0\\.1:${appAddress.port}`));

    const acceptLanguage = await runBrowserCommand(site, 'integration', ['get', 'text', '#accept-language'], env);
    const navigatorLanguage = await runBrowserCommand(site, 'integration', ['get', 'text', '#navigator-language'], env);
    const viewport = await runBrowserCommand(site, 'integration', ['get', 'text', '#viewport'], env);
    assert.match(acceptLanguage, /ja-JP/);
    assert.match(navigatorLanguage, /ja-JP/);
    assert.match(viewport, /900x700@1/);

    const waiting = runBrowserCommand(site, 'integration', ['wait', '500'], env);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      runBrowserCommand(site, 'integration', ['snapshot'], env),
      /SESSION_BUSY/,
    );
    await waiting;

    await runBrowserCommand(site, 'integration', ['snapshot', '-i'], env);
    await runBrowserCommand(site, 'integration', ['fill', '#field', 'alpha'], env);
    await runBrowserCommand(site, 'integration', ['type', '#field', 'beta', '--clear'], env);
    await runBrowserCommand(site, 'integration', ['focus', '#field'], env);
    await runBrowserCommand(site, 'integration', ['keyboard', 'type', 'z'], env);
    await runBrowserCommand(site, 'integration', ['press', 'Tab'], env);
    await runBrowserCommand(site, 'integration', ['hover', '#same-origin'], env);
    await runBrowserCommand(site, 'integration', ['select', '#choice', 'b'], env);
    await runBrowserCommand(site, 'integration', ['check', '#check'], env);
    assert.match(await runBrowserCommand(site, 'integration', ['is', 'checked', '#check'], env), /true/);
    await runBrowserCommand(site, 'integration', ['uncheck', '#check'], env);
    await runBrowserCommand(site, 'integration', ['wait', '#same-origin'], env);
    await runBrowserCommand(site, 'integration', ['wait', '--text', 'same'], env);
    await runBrowserCommand(site, 'integration', ['scroll', 'down', '10'], env);
    await runBrowserCommand(site, 'integration', ['scrollintoview', '#same-origin'], env);
    await runBrowserCommand(site, 'integration', ['get', 'title'], env);
    await runBrowserCommand(site, 'integration', ['get', 'url'], env);
    await runBrowserCommand(site, 'integration', ['get', 'count', 'button'], env);
    await runBrowserCommand(site, 'integration', ['get', 'box', '#same-origin'], env);
    await runBrowserCommand(site, 'integration', ['get', 'styles', '#same-origin'], env);
    await runBrowserCommand(site, 'integration', ['find', 'text', 'same', 'text'], env);
    await runBrowserCommand(site, 'integration', ['read', '--filter', 'same'], env);
    await runBrowserCommand(site, 'integration', ['dialog', 'status'], env);
    await runBrowserCommand(site, 'integration', ['reload'], env);

    const status = await runBrowserCommand(site, 'integration', ['tab', 'list'], env);
    assert.equal(JSON.parse(status).success, true);

    const configPath = join(paths.configs, `${managedSessionName('example', 'integration')}.json`);
    JSON.parse(await readFile(configPath, 'utf8'));
    const { binary } = await verifyAgentBrowserBinary();
    const directEnv = { ...env, AGENT_BROWSER_SOCKET_DIR: paths.socketDirectory };
    const denied = await run(binary, ['--config', configPath, '--json', 'screenshot'], directEnv);
    assert.notEqual(denied.code, 0);
    assert.match(`${denied.stdout}${denied.stderr}`, /denied by policy|not in the allow list/);
    const allowed = await run(binary, ['--config', configPath, '--json', 'snapshot', '-i'], directEnv);
    assert.equal(allowed.code, 0);
    assert.equal(JSON.parse(allowed.stdout.trim()).success, true);
    const stream = await run(binary, ['--config', configPath, '--json', 'stream', 'status'], directEnv);
    const streamData = JSON.parse(stream.stdout.trim()).data;
    assert.equal(streamData.connected, true);
    assert.equal(streamData.enabled, false);
    assert.equal(streamData.port, null);
    assert.equal(streamData.screencasting, false);

    await runBrowserCommand(site, 'integration', ['click', '#same-origin'], env);
    const tabs = JSON.parse(await runBrowserCommand(site, 'integration', ['tab', 'list'], env));
    assert.equal(tabs.data.tabs.length, 2);
    await runBrowserCommand(site, 'integration', ['tab', 'close', 't2'], env);

    await assert.rejects(
      runBrowserCommand(site, 'integration', ['click', '#external-origin'], env),
      /BROWSER_POLICY_DENIED/,
    );
    await assert.rejects(
      runBrowserCommand(site, 'integration', ['snapshot'], env),
      /SESSION_NOT_OPEN/,
    );

    const audit = (await readFile(paths.audit, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(audit.some((entry) => entry.outcome === 'failure' && entry.code === 'BROWSER_POLICY_DENIED'));
    assert.ok(audit.every((entry) => !('commandArgs' in entry) && !('output' in entry)));
    const remainingProfiles = await readdir(paths.workingProfiles).catch(() => []);
    assert.deepEqual(remainingProfiles, []);
  } finally {
    await runBrowserCommand(site, 'integration', ['close'], env).catch(() => {});
    await closeServer(app);
    await closeServer(external);
    await rm(paths.socketDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

integrationTest('profile authentication operates on a private copy and leaves the canonical profile unchanged', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-profile-engine-'));
  const app = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>profile fixture</title><p id="ready">ready</p>');
  });
  const address = await listen(app);
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: root, XDG_RUNTIME_DIR: tmpdir() };
  const site = {
    id: 'profile',
    baseUrl: `${origin}/`,
    loginUrl: `${origin}/login`,
    allowedOrigins: [origin],
    authMode: 'profile',
    browser: {
      channel: 'chromium',
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      locale: 'ja-JP',
      captureHeaded: false,
    },
  };
  const paths = siteRuntimePaths(site.id, env);
  try {
    await runBrowserCommand(site, 'integration', ['open'], env);
    const ready = await runBrowserCommand(site, 'integration', ['get', 'text', '#ready'], env);
    assert.match(ready, /ready/);
    await runBrowserCommand(site, 'integration', ['close'], env);
    assert.deepEqual(await readdir(paths.profile), []);
    assert.deepEqual(await readdir(paths.workingProfiles).catch(() => []), []);
  } finally {
    await runBrowserCommand(site, 'integration', ['close'], env).catch(() => {});
    await closeServer(app);
    await rm(paths.socketDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

integrationTest('login save validates and atomically publishes state for later read-only sessions', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-login-engine-'));
  const app = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': 'fixture_session=ready; Path=/; HttpOnly; SameSite=Lax',
    });
    response.end('<!doctype html><title>login fixture</title><p id="ready">ready</p>');
  });
  const address = await listen(app);
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: root, XDG_RUNTIME_DIR: tmpdir() };
  const site = {
    id: 'login',
    baseUrl: `${origin}/`,
    loginUrl: `${origin}/login`,
    allowedOrigins: [origin],
    authMode: 'state',
    browser: {
      channel: 'chromium',
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      locale: 'ja-JP',
      captureHeaded: false,
    },
  };
  const paths = siteRuntimePaths(site.id, env);
  try {
    await openLogin(site, env);
    const cleanupReached = deferred();
    const continueCleanup = deferred();
    const saving = saveLogin(site, env, {
      lifecycleHooks: {
        beforeCleanup: async () => {
          cleanupReached.resolve();
          await continueCleanup.promise;
        },
      },
    });
    await cleanupReached.promise;
    const name = managedSessionName(site.id, 'login', 'login');
    const metadataPath = join(paths.sessions, `${name}.json`);
    const configPath = join(paths.configs, `${name}.json`);
    const workingProfile = join(paths.workingProfiles, name);
    assert.equal(await exists(metadataPath), true);
    assert.equal(await exists(configPath), true);
    assert.equal(await exists(workingProfile), true);
    assert.match((await readLock(paths.lock)).owner, /^login:login:/);
    await assert.rejects(openLogin(site, env), /SESSION_BUSY/);
    continueCleanup.resolve();
    await saving;

    const state = JSON.parse(await readFile(paths.authState, 'utf8'));
    assert.ok(Array.isArray(state.cookies));
    assert.ok(Array.isArray(state.origins));
    assert.equal((await stat(paths.authState)).mode & 0o777, 0o600);
    await openLogin(site, env);
    assert.equal(await exists(metadataPath), true);
    assert.equal(await exists(configPath), true);
    assert.equal(await exists(workingProfile), true);
    assert.match((await readLock(paths.lock)).owner, /^login:login:/);
    await closeLogin(site, env);
    await runBrowserCommand(site, 'integration', ['open'], env);
    await runBrowserCommand(site, 'integration', ['close'], env);
  } finally {
    await closeLogin(site, env).catch(() => {});
    await runBrowserCommand(site, 'integration', ['close'], env).catch(() => {});
    await closeServer(app);
    await rm(paths.socketDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

integrationTest('profile login close serializes cleanup before the next open lifecycle', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-profile-login-lifecycle-'));
  const app = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>profile login fixture</title><p id="ready">ready</p>');
  });
  const address = await listen(app);
  const origin = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: root, XDG_RUNTIME_DIR: tmpdir() };
  const site = {
    id: 'profile-login',
    baseUrl: `${origin}/`,
    loginUrl: `${origin}/login`,
    allowedOrigins: [origin],
    authMode: 'profile',
    browser: {
      channel: 'chromium',
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      locale: 'ja-JP',
      captureHeaded: false,
    },
  };
  const paths = siteRuntimePaths(site.id, env);
  const name = managedSessionName(site.id, 'login', 'login');
  const metadataPath = join(paths.sessions, `${name}.json`);
  const configPath = join(paths.configs, `${name}.json`);
  try {
    await openLogin(site, env);
    const cleanupReached = deferred();
    const continueCleanup = deferred();
    const closing = closeLogin(site, env, {
      lifecycleHooks: {
        beforeCleanup: async () => {
          cleanupReached.resolve();
          await continueCleanup.promise;
        },
      },
    });
    await cleanupReached.promise;
    assert.equal(await exists(metadataPath), true);
    assert.equal(await exists(configPath), true);
    assert.equal(await exists(paths.profile), true);
    assert.match((await readLock(paths.lock)).owner, /^login:profile-login:/);
    await assert.rejects(openLogin(site, env), /SESSION_BUSY/);
    continueCleanup.resolve();
    await closing;

    await openLogin(site, env);
    assert.equal(await exists(metadataPath), true);
    assert.equal(await exists(configPath), true);
    assert.equal(await exists(paths.profile), true);
    assert.match((await readLock(paths.lock)).owner, /^login:profile-login:/);
    await closeLogin(site, env);
  } finally {
    await closeLogin(site, env).catch(() => {});
    await closeServer(app);
    await rm(paths.socketDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
