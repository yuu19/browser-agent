import { chromium } from 'playwright';
import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

export const BROWSER_CHANNELS = new Set([
  'auto',
  'chromium',
  'chrome',
  'chrome-beta',
  'chrome-dev',
  'chrome-canary',
  'msedge',
  'msedge-beta',
  'msedge-dev',
  'msedge-canary',
]);

const TRUSTED_BROWSER_CANDIDATES = new Map([
  ['chrome', [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]],
  ['chrome-beta', [
    '/usr/bin/google-chrome-beta',
    '/opt/google/chrome-beta/google-chrome-beta',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  ]],
  ['chrome-dev', [
    '/usr/bin/google-chrome-unstable',
    '/opt/google/chrome-unstable/google-chrome-unstable',
    '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
  ]],
  ['chrome-canary', [
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ]],
  ['msedge', [
    '/usr/bin/microsoft-edge',
    '/opt/microsoft/msedge/microsoft-edge',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]],
  ['msedge-beta', [
    '/usr/bin/microsoft-edge-beta',
    '/opt/microsoft/msedge-beta/microsoft-edge-beta',
    '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
  ]],
  ['msedge-dev', [
    '/usr/bin/microsoft-edge-dev',
    '/opt/microsoft/msedge-dev/microsoft-edge-dev',
    '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
  ]],
  ['msedge-canary', [
    '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary',
  ]],
]);

async function assertCallerCannotReplace(path) {
  let current = path;
  while (current !== dirname(current)) {
    try {
      await access(current, constants.W_OK);
      throw new Error(`trusted browser path is writable by the current user: ${current}`);
    } catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'EROFS') throw error;
    }
    current = dirname(current);
  }
}

async function resolveTrustedBrowser(channel, candidates) {
  if (!candidates) throw new Error('the configured browser channel is not supported');
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      await assertCallerCannotReplace(dirname(candidate));
      await assertCallerCannotReplace(resolved);
      return resolved;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EROFS'].includes(error.code)) throw error;
    }
  }
  throw new Error(`trusted browser executable is missing for channel ${channel}`);
}

export function recommendedBrowserChannel({ platform = process.platform, arch = process.arch } = {}) {
  return platform === 'linux' && arch === 'arm64' ? 'chromium' : 'chrome';
}

export function resolveBrowserChannel(channel, runtime = {}) {
  const requestedChannel = channel ?? 'auto';
  return requestedChannel === 'auto' ? recommendedBrowserChannel(runtime) : requestedChannel;
}

export async function resolveBrowserExecutable(channel, {
  platform = process.platform,
  arch = process.arch,
  chromiumExecutablePath = chromium.executablePath(),
  trustedBrowserCandidates = TRUSTED_BROWSER_CANDIDATES,
} = {}) {
  const resolvedChannel = resolveBrowserChannel(channel, { platform, arch });
  if (resolvedChannel === 'chromium') {
    await access(chromiumExecutablePath, constants.X_OK);
    return realpath(chromiumExecutablePath);
  }
  return resolveTrustedBrowser(resolvedChannel, trustedBrowserCandidates.get(resolvedChannel));
}

export async function browserRuntimeCheck(channel, {
  platform = process.platform,
  arch = process.arch,
  chromiumExecutablePath = chromium.executablePath(),
  trustedBrowserCandidates = TRUSTED_BROWSER_CANDIDATES,
} = {}) {
  const resolvedChannel = resolveBrowserChannel(channel, { platform, arch });
  const command = await resolveBrowserExecutable(resolvedChannel, {
    platform,
    arch,
    chromiumExecutablePath,
    trustedBrowserCandidates,
  });
  return {
    channel: resolvedChannel,
    label: resolvedChannel === 'chromium' ? 'Playwright Chromium' : `Browser (${resolvedChannel})`,
    command,
    args: ['--version'],
  };
}
