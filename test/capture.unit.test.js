import test from 'node:test';
import assert from 'node:assert/strict';
import { captureScreenshot } from '../src/capture.js';

test('capture API rejects path overrides for defined captures before launching a browser', async () => {
  await assert.rejects(
    captureScreenshot(
      { id: 'example' },
      {
        id: 'dashboard',
        privacy: 'masked',
        path: '/dashboard',
        output: 'dashboard.png',
        masks: [{ required: true }],
      },
      { path: '/settings' },
    ),
    /cannot override a defined capture/,
  );
});
