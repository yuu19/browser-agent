#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FONT_ASSETS, fontsDirectory } from '../src/fonts.js';

const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!['--check', '--force'].includes(arg)) throw new Error(`unknown option: ${arg}`);
}
if (args.has('--check') && args.has('--force')) throw new Error('--check and --force cannot be combined');

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function existingStatus(path, expected) {
  try {
    const buffer = await readFile(path);
    return { exists: true, valid: digest(buffer) === expected };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, valid: false };
    throw error;
  }
}

async function download(asset, destination) {
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`font download failed for ${asset.family}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const actual = digest(buffer);
  if (actual !== asset.sha256) {
    throw new Error(`downloaded font hash mismatch for ${asset.filename}; expected ${asset.sha256}, received ${actual}`);
  }

  const temporary = join(fontsDirectory, `.${randomUUID()}.font`);
  try {
    await writeFile(temporary, buffer, { mode: 0o644 });
    await rename(temporary, destination);
    await chmod(destination, 0o644);
  } finally {
    await rm(temporary, { force: true });
  }
}

await mkdir(fontsDirectory, { recursive: true });
for (const asset of FONT_ASSETS) {
  const destination = join(fontsDirectory, asset.filename);
  const status = await existingStatus(destination, asset.sha256);
  if (status.valid) {
    console.log(`ok  ${asset.family}: ${asset.filename}`);
    continue;
  }
  if (args.has('--check')) {
    throw new Error(status.exists
      ? `font hash mismatch: ${asset.filename}`
      : `font is missing: ${asset.filename}`);
  }
  if (status.exists && !args.has('--force')) {
    throw new Error(`refusing to replace a mismatched font: ${asset.filename}; review the file and rerun with --force`);
  }
  await download(asset, destination);
  console.log(`downloaded  ${asset.family}: ${asset.filename}`);
}
