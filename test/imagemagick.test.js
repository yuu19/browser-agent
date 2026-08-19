import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageMagickRuntimeFor, resolveImageMagick } from '../src/imagemagick.js';

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

test('ImageMagick probing waits for inherited output streams to close', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-magick-probe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const command = join(root, 'delayed-magick');
  await writeFile(command, `#!/bin/sh
(sleep 0.05; printf '%s\\n' 'Version: ImageMagick 7.1.2') &
exit 0
`);
  await chmod(command, 0o755);

  const runtime = await resolveImageMagick({ ...process.env, BROWSER_AGENT_MAGICK: command });
  assert.equal(runtime.version, 'Version: ImageMagick 7.1.2');
});
