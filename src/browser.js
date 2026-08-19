import { chromium } from 'playwright';

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

const BRANDED_BROWSER_COMMANDS = new Map([
  ['chrome', 'google-chrome'],
  ['chrome-beta', 'google-chrome-beta'],
  ['chrome-dev', 'google-chrome-unstable'],
  ['chrome-canary', 'google-chrome-canary'],
  ['msedge', 'microsoft-edge'],
  ['msedge-beta', 'microsoft-edge-beta'],
  ['msedge-dev', 'microsoft-edge-dev'],
  ['msedge-canary', 'microsoft-edge-canary'],
]);

export function recommendedBrowserChannel({ platform = process.platform, arch = process.arch } = {}) {
  return platform === 'linux' && arch === 'arm64' ? 'chromium' : 'chrome';
}

export function resolveBrowserChannel(channel, runtime = {}) {
  const requestedChannel = channel ?? 'auto';
  return requestedChannel === 'auto' ? recommendedBrowserChannel(runtime) : requestedChannel;
}

export function browserRuntimeCheck(channel, {
  platform = process.platform,
  arch = process.arch,
  chromiumExecutablePath = chromium.executablePath(),
} = {}) {
  const resolvedChannel = resolveBrowserChannel(channel, { platform, arch });
  if (resolvedChannel === 'chromium') {
    return {
      channel: resolvedChannel,
      label: 'Playwright Chromium',
      command: chromiumExecutablePath,
      args: ['--version'],
    };
  }
  return {
    channel: resolvedChannel,
    label: `Browser (${resolvedChannel})`,
    command: BRANDED_BROWSER_COMMANDS.get(resolvedChannel),
    args: ['--version'],
  };
}
