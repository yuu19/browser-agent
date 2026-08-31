import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  browserRuntimeCheck,
  recommendedBrowserChannel,
  resolveBrowserExecutable,
  resolveBrowserChannel,
} from '../src/browser.js';

test('Linux Arm64 selects Playwright Chromium', () => {
  const runtime = { platform: 'linux', arch: 'arm64' };
  assert.equal(recommendedBrowserChannel(runtime), 'chromium');
  assert.equal(resolveBrowserChannel('auto', runtime), 'chromium');
  assert.equal(resolveBrowserChannel(undefined, runtime), 'chromium');
});

test('other supported hosts keep Google Chrome as the automatic channel', () => {
  assert.equal(recommendedBrowserChannel({ platform: 'linux', arch: 'x64' }), 'chrome');
  assert.equal(recommendedBrowserChannel({ platform: 'darwin', arch: 'arm64' }), 'chrome');
});

test('runtime checks use the bundled Chromium executable on Linux Arm64', async () => {
  const executable = await realpath('/bin/sh');
  assert.deepEqual(
    await browserRuntimeCheck('auto', {
      platform: 'linux',
      arch: 'arm64',
      chromiumExecutablePath: '/bin/sh',
    }),
    {
      channel: 'chromium',
      label: 'Playwright Chromium',
      command: executable,
      args: ['--version'],
    },
  );
});

test('explicit branded channels resolve an immutable fixed system path', async () => {
  const executable = await realpath('/bin/sh');
  const check = await browserRuntimeCheck('chrome', {
    platform: 'linux',
    arch: 'arm64',
    chromiumExecutablePath: '/unused',
    trustedBrowserCandidates: new Map([['chrome', ['/bin/sh']]]),
  });
  assert.equal(check.channel, 'chrome');
  assert.equal(check.command, executable);
});

test('branded browser resolution ignores caller PATH and rejects user-writable fixed paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-browser-trust-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shim = join(root, 'google-chrome');
  await writeFile(shim, '#!/bin/sh\nexit 0\n');
  await chmod(shim, 0o755);

  await assert.rejects(
    resolveBrowserExecutable('chrome', {
      env: { PATH: root },
      trustedBrowserCandidates: new Map([['chrome', ['/definitely/missing/google-chrome']]]),
    }),
    /trusted browser executable is missing/,
  );
  await assert.rejects(
    resolveBrowserExecutable('chrome', {
      trustedBrowserCandidates: new Map([['chrome', [shim]]]),
    }),
    /writable by the current user/,
  );
});
