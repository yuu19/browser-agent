import test from 'node:test';
import assert from 'node:assert/strict';
import { runBrowserCommand } from '../src/playwright-cli.js';

const site = {
  id: 'example',
  authMode: 'profile',
  browser: {},
};

test('browser mode rejects persistent unmasked image commands', async () => {
  await assert.rejects(
    runBrowserCommand(site, 'test', ['screenshot']),
    /disabled in browser mode/,
  );
  await assert.rejects(
    runBrowserCommand(site, 'test', ['pdf']),
    /disabled in browser mode/,
  );
});
