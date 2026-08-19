import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCaptureArgs } from '../src/cli.js';

const definedCapture = {
  id: 'dashboard',
  privacy: 'masked',
  path: '/dashboard',
  output: 'artifacts/dashboard.png',
  masks: [{ required: true }],
  prepare: [],
  annotations: [],
};

test('defined captures reject path overrides that would invalidate reviewed masks', () => {
  assert.throws(
    () => parseCaptureArgs(['dashboard', '--path=/settings'], { dashboard: definedCapture }),
    /cannot override a defined capture/,
  );
});

test('ad-hoc captures require at least one required mask', () => {
  assert.throws(
    () => parseCaptureArgs(['--path=/', '--output=shot.png'], {}),
    /masked captures require at least one required mask/,
  );
  const { capture } = parseCaptureArgs([
    '--path=/',
    '--output=shot.png',
    '--mask={"locator":{"type":"testId","value":"secret"}}',
  ], {});
  assert.equal(capture.privacy, 'masked');
  assert.equal(capture.masks.length, 1);
});
