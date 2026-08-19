import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserRuntimeCheck,
  recommendedBrowserChannel,
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

test('runtime checks use the bundled Chromium executable on Linux Arm64', () => {
  assert.deepEqual(
    browserRuntimeCheck('auto', {
      platform: 'linux',
      arch: 'arm64',
      chromiumExecutablePath: '/opt/playwright/chromium',
    }),
    {
      channel: 'chromium',
      label: 'Playwright Chromium',
      command: '/opt/playwright/chromium',
      args: ['--version'],
    },
  );
});

test('explicit branded channels keep their system command', () => {
  const check = browserRuntimeCheck('chrome', {
    platform: 'linux',
    arch: 'arm64',
    chromiumExecutablePath: '/unused',
  });
  assert.equal(check.channel, 'chrome');
  assert.equal(check.command, 'google-chrome');
});
