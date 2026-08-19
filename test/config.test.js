import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCapture, validateSite } from '../src/config.js';

test('site defaults to profile auth and a reproducible viewport', () => {
  const site = validateSite({ baseUrl: 'https://example.com' }, 'example');
  assert.equal(site.authMode, 'profile');
  assert.deepEqual(site.browser.viewport, { width: 1440, height: 900 });
  assert.equal(site.browser.deviceScaleFactor, 2);
  assert.equal(site.browser.captureHeaded, false);
});

test('site accepts a bounded device scale factor', () => {
  const site = validateSite({
    baseUrl: 'https://example.com',
    browser: { deviceScaleFactor: 1.5 },
  }, 'example');
  assert.equal(site.browser.deviceScaleFactor, 1.5);
  assert.throws(
    () => validateSite({
      baseUrl: 'https://example.com',
      browser: { deviceScaleFactor: 5 },
    }, 'example'),
    /must be a number between 1 and 4/,
  );
});

test('site rejects non-http origins', () => {
  assert.throws(
    () => validateSite({ baseUrl: 'javascript:alert(1)' }, 'bad'),
    /must be an absolute URL|must use http or https/,
  );
});

test('capture normalizes structured locators and match policies', () => {
  const capture = validateCapture({
    path: '/users',
    output: 'docs/users.png',
    masks: [
      {
        locator: { type: 'css', value: '[data-private]' },
        match: 'all',
      },
      {
        locator: { type: 'testId', value: 'token' },
        match: { count: 2 },
        required: false,
      },
    ],
  }, 'users');

  assert.deepEqual(capture.masks[0].match, { kind: 'all' });
  assert.deepEqual(capture.masks[1].match, { kind: 'count', count: 2 });
  assert.equal(capture.masks[0].required, true);
  assert.equal(capture.masks[1].required, false);
});

test('capture requires a required mask unless the page is explicitly public', () => {
  assert.throws(
    () => validateCapture({ path: '/', output: 'shot.png' }, 'private'),
    /masked captures require at least one required mask/,
  );
  const capture = validateCapture({
    path: '/',
    output: 'shot.png',
    privacy: 'public',
  }, 'public');
  assert.equal(capture.privacy, 'public');
});

test('capture normalizes strict readiness checks and reviewed image exceptions', () => {
  const capture = validateCapture({
    path: '/',
    output: 'shot.png',
    privacy: 'public',
    readiness: {
      timeoutMs: 2_000,
      ignoreImages: [{
        locator: { type: 'testId', value: 'optional-image' },
        match: 'one',
      }],
    },
  }, 'public');
  assert.equal(capture.readiness.fonts, true);
  assert.equal(capture.readiness.images, true);
  assert.equal(capture.readiness.timeoutMs, 2_000);
  assert.deepEqual(capture.readiness.ignoreImages[0].match, { kind: 'one' });
});

test('capture rejects arbitrary preparation actions and unknown fields', () => {
  assert.throws(
    () => validateCapture({
      path: '/',
      output: 'shot.png',
      prepare: [{ action: 'fill', locator: { type: 'css', value: 'input' } }],
    }, 'bad'),
    /must be one of/,
  );
  assert.throws(
    () => validateCapture({ path: '/', output: 'shot.png', javascript: 'alert(1)' }, 'bad'),
    /unknown property/,
  );
});
