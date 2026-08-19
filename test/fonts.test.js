import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  FONT_ASSETS,
  fontsDirectory,
  verifiedBrowserFontEnvironment,
  verifyBundledFonts,
} from '../src/fonts.js';

const execFileAsync = promisify(execFile);

test('bundled fonts match their pinned SHA-256 values', async () => {
  const verified = await verifyBundledFonts();
  assert.deepEqual(verified.map((font) => font.family), ['Noto Sans JP', 'Inter Variable']);
  assert.ok(verified.every((font) => font.size > 0));
});

test('bundled font verification rejects modified bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-font-tamper-'));
  for (const asset of FONT_ASSETS) {
    await copyFile(join(fontsDirectory, asset.filename), join(root, asset.filename));
  }
  const target = join(root, FONT_ASSETS[0].filename);
  const original = await readFile(target);
  await writeFile(target, Buffer.concat([original, Buffer.from('tampered')]));
  await assert.rejects(verifyBundledFonts(root), /font hash mismatch/);
});

test('dedicated fontconfig selects repository-local fallback fonts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-font-env-'));
  const env = await verifiedBrowserFontEnvironment({
    ...process.env,
    BROWSER_AGENT_DATA_DIR: join(root, 'data'),
  });
  const format = '%{family}|%{file}';
  const japanese = await execFileAsync('fc-match', ['-f', format, 'sans-serif:lang=ja'], { env });
  const english = await execFileAsync('fc-match', ['-f', format, 'sans-serif:lang=en'], { env });
  assert.match(japanese.stdout, /Noto Sans JP.*NotoSansJP-Variable\.ttf/);
  assert.match(english.stdout, /Inter Variable.*InterVariable\.ttf/);
});

test('font provenance manifest matches runtime verification constants', async () => {
  const manifest = JSON.parse(await readFile(join(fontsDirectory, 'SOURCE.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(
    manifest.fonts.map(({ family, file, downloadUrl, sha256 }) => ({ family, filename: file, url: downloadUrl, sha256 })),
    FONT_ASSETS,
  );
});
