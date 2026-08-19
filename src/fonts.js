import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataRoot, repositoryRoot } from './paths.js';

export const fontsDirectory = join(repositoryRoot, 'assets', 'fonts');
export const fontconfigFile = join(repositoryRoot, 'config', 'fontconfig', 'browser-agent-fonts.conf');

export const FONT_ASSETS = Object.freeze([
  Object.freeze({
    family: 'Noto Sans JP',
    filename: 'NotoSansJP-Variable.ttf',
    url: 'https://raw.githubusercontent.com/google/fonts/e1118da94a8cb00cf6d06cdac9ef13eb1e5c6ab7/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf',
    sha256: 'c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f',
  }),
  Object.freeze({
    family: 'Inter Variable',
    filename: 'InterVariable.ttf',
    url: 'https://raw.githubusercontent.com/rsms/inter/v4.1/docs/font-files/InterVariable.ttf',
    sha256: '4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf',
  }),
]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export async function verifyBundledFonts(directory = fontsDirectory) {
  const verified = [];
  for (const asset of FONT_ASSETS) {
    const path = join(directory, asset.filename);
    let buffer;
    try {
      buffer = await readFile(path);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`bundled font is missing: ${path}; run node scripts/fetch-fonts.js`);
      }
      throw error;
    }
    const actual = sha256(buffer);
    if (actual !== asset.sha256) {
      throw new Error(`bundled font hash mismatch: ${asset.filename}; expected ${asset.sha256}, received ${actual}`);
    }
    verified.push({ ...asset, path, size: buffer.length });
  }
  return verified;
}

export function browserFontEnvironment(env = process.env) {
  const runtimeRoot = join(dataRoot(env), 'fontconfig');
  return {
    ...env,
    FONTCONFIG_FILE: fontconfigFile,
    XDG_CONFIG_HOME: join(runtimeRoot, 'config'),
    XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
  };
}

export async function verifiedBrowserFontEnvironment(env = process.env) {
  await verifyBundledFonts();
  const browserEnv = browserFontEnvironment(env);
  await mkdir(browserEnv.XDG_CONFIG_HOME, { recursive: true, mode: 0o700 });
  await mkdir(browserEnv.XDG_CACHE_HOME, { recursive: true, mode: 0o700 });
  return browserEnv;
}
