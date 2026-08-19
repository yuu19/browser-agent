import test from 'node:test';
import assert from 'node:assert/strict';
import { imageMagickRuntimeFor } from '../src/imagemagick.js';

test('ImageMagick 7 uses the unified magick command', () => {
  const runtime = imageMagickRuntimeFor('magick', 'Version: ImageMagick 7.1.2');
  assert.deepEqual(runtime.convert, { command: 'magick', prefix: [] });
  assert.deepEqual(runtime.identify, { command: 'magick', prefix: ['identify'] });
});

test('ImageMagick 6 uses separate convert and identify commands', () => {
  const runtime = imageMagickRuntimeFor('/usr/bin/convert', 'Version: ImageMagick 6.9.12');
  assert.deepEqual(runtime.convert, { command: '/usr/bin/convert', prefix: [] });
  assert.deepEqual(runtime.identify, { command: '/usr/bin/identify', prefix: [] });
});
