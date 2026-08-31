import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import {
  agentBrowserPolicyPath,
  verifyAgentBrowserBinary,
  verifyAgentBrowserPolicy,
} from './agent-browser-binary.js';
import { appendAudit } from './audit.js';
import { resolveBrowserExecutable } from './browser.js';
import { managedAgentBrowserEnvironment, withoutProxyEnvironment } from './environment.js';
import { verifiedBrowserFontEnvironment } from './fonts.js';
import {
  agentBrowserNamespace,
  repositoryRoot,
  siteRuntimePaths,
  temporarySibling,
} from './paths.js';
import { cloneProfile, removeWorkingProfile } from './profile-workspace.js';
import {
  acquireLock,
  archiveRuntimeFile,
  createLockOwner,
  ensurePrivateDirectory,
  exists,
  processIsAlive,
  readLock,
  reclaimLock,
  releaseLock,
  writeJsonAtomic,
} from './runtime.js';

const MAX_UPSTREAM_OUTPUT = 100_000;
const MAX_AUTH_STATE_BYTES = 10 * 1024 * 1024;
const FIND_LOCATORS = new Set(['role', 'text', 'label', 'placeholder', 'alt', 'title', 'testid', 'first', 'last', 'nth']);
const FIND_ACTIONS = new Set(['click', 'fill', 'check', 'hover', 'text']);
const GET_ACTIONS = new Set(['text', 'title', 'url', 'count', 'box', 'styles']);
const MANAGED_GLOBAL_OPTIONS = new Set([
  '--action-policy', '--allowed-domains', '--allow-file-access', '--annotate', '--args',
  '--auto-connect', '--ca-cert', '--cdp', '--clear-ca-cert', '--color-scheme', '--config',
  '--confirm-actions', '--confirm-interactive', '--content-boundaries', '--debug', '--device',
  '--download-path', '--enable', '--engine', '--executable-path', '--extension', '--headed',
  '--hide-scrollbars', '--idle-timeout', '--ignore-https-errors', '--init-script', '--json',
  '--max-output', '--model', '--namespace', '--no-auto-dialog', '--no-ca-cert', '--no-pin-tab',
  '--pin-tab', '--profile', '--provider', '--proxy', '--proxy-bypass', '--restore',
  '--restore-check-fn', '--restore-check-text', '--restore-check-url', '--restore-save',
  '--screenshot-dir', '--screenshot-format', '--screenshot-quality', '--session',
  '--session-name', '--state', '--user-agent', '--verbose', '--webgpu', '-p', '-q', '-v',
]);

class BrowserAgentError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function policyError(message) {
  return new BrowserAgentError('BROWSER_POLICY_DENIED', message);
}

function commandError(action) {
  return new BrowserAgentError('AGENT_BROWSER_COMMAND_FAILED', `${action} failed; page-derived error details were suppressed`);
}

function requireCount(args, minimum, maximum, usage) {
  if (args.length < minimum || args.length > maximum) throw policyError(`usage: ${usage}`);
}

function requireInteger(value, label, { minimum = 0 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw policyError(`${label} must be an integer of at least ${minimum}`);
  return number;
}

function normalizeNavigationUrl(value, site) {
  let parsed;
  try {
    parsed = new URL(value ?? site.baseUrl, site.baseUrl);
  } catch {
    throw policyError('navigation requires a valid URL or relative path');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !site.allowedOrigins.includes(parsed.origin)) {
    throw policyError('navigation target is outside the configured top-level origins');
  }
  return parsed.href;
}

function parseSnapshot(args) {
  const normalized = ['snapshot'];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (['-i', '--interactive', '-u', '--urls', '-c', '--compact'].includes(arg)) {
      normalized.push(arg);
    } else if (['-d', '--depth'].includes(arg)) {
      const value = args[index + 1];
      requireInteger(value, '--depth', { minimum: 1 });
      normalized.push(arg, value);
      index += 1;
    } else if (['-s', '--selector'].includes(arg) && args[index + 1]) {
      normalized.push(arg, args[index + 1]);
      index += 1;
    } else {
      throw policyError('snapshot option is not allowed');
    }
  }
  return normalized;
}

function parseRead(args) {
  const normalized = ['read'];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--outline') {
      normalized.push('--outline');
    } else if (args[index] === '--filter' && args[index + 1]) {
      normalized.push('--filter', args[index + 1]);
      index += 1;
    } else {
      throw policyError('read accepts only the active DOM with --outline or --filter');
    }
  }
  return normalized;
}

function parseWait(args) {
  if (args.length === 0) throw policyError('usage: wait <selector|ms|--url|--load|--text> [--timeout <ms>]');
  const normalized = ['wait'];
  let modeSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--timeout') {
      requireInteger(args[index + 1], '--timeout');
      normalized.push(arg, args[index + 1]);
      index += 1;
    } else if (['--url', '-u', '--text', '-t'].includes(arg) && !modeSeen && args[index + 1]) {
      normalized.push(arg, args[index + 1]);
      index += 1;
      modeSeen = true;
    } else if (['--load', '-l'].includes(arg) && !modeSeen && ['load', 'domcontentloaded', 'networkidle'].includes(args[index + 1])) {
      normalized.push(arg, args[index + 1]);
      index += 1;
      modeSeen = true;
    } else if (!arg.startsWith('-') && !modeSeen) {
      normalized.push(arg);
      modeSeen = true;
    } else {
      throw policyError('wait option is not allowed');
    }
  }
  return normalized;
}

function parseScroll(args) {
  const normalized = ['scroll'];
  let positional = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (['--selector', '-s'].includes(arg) && args[index + 1]) {
      normalized.push(arg, args[index + 1]);
      index += 1;
    } else if (positional === 0 && ['up', 'down', 'left', 'right'].includes(arg)) {
      normalized.push(arg);
      positional += 1;
    } else if (positional <= 1 && /^\d+$/.test(arg)) {
      normalized.push(arg);
      positional = 2;
    } else {
      throw policyError('scroll option is not allowed');
    }
  }
  return normalized;
}

function parseFind(args) {
  if (!FIND_LOCATORS.has(args[0])) throw policyError('find locator is not allowed');
  const actionIndex = args[0] === 'nth' ? 3 : 2;
  const minimum = args[0] === 'nth' ? 4 : 3;
  if (args.length < minimum || !FIND_ACTIONS.has(args[actionIndex])) {
    throw policyError('find requires an explicit allowed action');
  }
  if (args[0] === 'nth') requireInteger(args[1], 'find nth index');
  let fillValueSeen = false;
  for (let index = actionIndex + 1; index < args.length; index += 1) {
    if (args[index] === '--exact') continue;
    if (args[index] === '--name' && args[index + 1]) {
      index += 1;
      continue;
    }
    if (args[actionIndex] === 'fill' && !fillValueSeen && !args[index].startsWith('-')) {
      fillValueSeen = true;
      continue;
    }
    throw policyError('find option is not allowed');
  }
  if (args[actionIndex] === 'fill' && !fillValueSeen) throw policyError('find fill requires non-sensitive text');
  return ['find', ...args];
}

export function normalizeBrowserCommand(site, commandArgs) {
  if (commandArgs.length === 0) throw policyError('browser requires a command');
  for (const arg of commandArgs.slice(1)) {
    const option = arg.split('=', 1)[0];
    if (MANAGED_GLOBAL_OPTIONS.has(option)) throw policyError(`${option} is managed and cannot be overridden`);
  }
  const [command, ...args] = commandArgs;
  let normalized;
  let navigationUrl;

  switch (command) {
    case 'open':
      requireCount(args, 0, 1, 'open [url-or-path]');
      navigationUrl = normalizeNavigationUrl(args[0], site);
      normalized = ['open', navigationUrl];
      break;
    case 'back':
    case 'forward':
    case 'reload':
    case 'close':
      requireCount(args, 0, 0, command);
      normalized = [command];
      break;
    case 'snapshot':
      normalized = parseSnapshot(args);
      break;
    case 'read':
      normalized = parseRead(args);
      break;
    case 'click':
      if (args.length === 2 && args[1] === '--new-tab') normalized = [command, ...args];
      else {
        requireCount(args, 1, 1, 'click <selector> [--new-tab]');
        normalized = [command, ...args];
      }
      break;
    case 'fill':
      requireCount(args, 2, 2, 'fill <selector> <non-sensitive-text>');
      if (args[1].startsWith('-')) throw policyError('fill text cannot be an option');
      normalized = [command, ...args];
      break;
    case 'type':
      requireCount(args, 2, Number.MAX_SAFE_INTEGER, 'type <selector> <non-sensitive-text>');
      if (args[1].startsWith('-')) throw policyError('type text cannot be an option');
      for (let index = 2; index < args.length; index += 1) {
        if (args[index] === '--delay') {
          requireInteger(args[index + 1], '--delay');
          index += 1;
        } else if (args[index] === '--clear') {
          // Allowed modifier.
        } else if (args[index].startsWith('-')) {
          throw policyError('type option is not allowed');
        }
      }
      normalized = [command, ...args];
      break;
    case 'keyboard':
      if (!['type', 'inserttext'].includes(args[0]) || args.length !== 2) throw policyError('keyboard accepts type or inserttext with non-sensitive text');
      if (args[1].startsWith('-')) throw policyError('keyboard text cannot be an option');
      normalized = [command, ...args];
      break;
    case 'hover':
    case 'focus':
    case 'check':
    case 'uncheck':
    case 'scrollintoview':
      requireCount(args, 1, 1, `${command} <selector>`);
      normalized = [command, ...args];
      break;
    case 'press':
      requireCount(args, 1, 1, 'press <key>');
      normalized = [command, ...args];
      break;
    case 'select':
      requireCount(args, 2, Number.MAX_SAFE_INTEGER, 'select <selector> <value...>');
      if (args.slice(1).some((value) => value.startsWith('-'))) throw policyError('select values cannot be options');
      normalized = [command, ...args];
      break;
    case 'scroll':
      normalized = parseScroll(args);
      break;
    case 'wait':
      normalized = parseWait(args);
      break;
    case 'get':
      if (!GET_ACTIONS.has(args[0])) throw policyError('get operation is not allowed');
      if (['title', 'url'].includes(args[0])) requireCount(args, 1, 1, `get ${args[0]}`);
      else requireCount(args, 2, 2, `get ${args[0]} <selector>`);
      normalized = [command, ...args];
      break;
    case 'is':
      if (!['visible', 'enabled', 'checked'].includes(args[0])) throw policyError('is operation is not allowed');
      requireCount(args, 2, 2, `is ${args[0]} <selector>`);
      normalized = [command, ...args];
      break;
    case 'find':
      normalized = parseFind(args);
      break;
    case 'tab':
      if (args.length === 0 || (args.length === 1 && args[0] === 'list')) normalized = ['tab', 'list'];
      else if (args[0] === 'close') {
        requireCount(args, 1, 2, 'tab close [tab]');
        normalized = [command, ...args];
      } else {
        requireCount(args, 1, 1, 'tab <tab>');
        if (args[0] === 'new') throw policyError('opening tabs directly is not allowed');
        normalized = [command, ...args];
      }
      break;
    case 'dialog':
      if (args[0] === 'accept') requireCount(args, 1, 2, 'dialog accept [non-sensitive-text]');
      else if (['dismiss', 'status'].includes(args[0])) requireCount(args, 1, 1, `dialog ${args[0]}`);
      else throw policyError('dialog operation is not allowed');
      normalized = [command, ...args];
      break;
    default:
      throw policyError(`${command} is not allowed by the browser wrapper`);
  }

  return { action: command, args: normalized, navigationUrl, closes: command === 'close' };
}

export function managedSessionName(siteId, session, kind = 'browser') {
  if (!/^[a-zA-Z0-9_-]+$/.test(siteId)) throw policyError('site contains unsupported characters');
  if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw policyError('session contains unsupported characters');
  if (!['browser', 'login'].includes(kind)) throw new Error('unsupported managed session kind');
  const digest = createHash('sha256')
    .update(JSON.stringify([kind, siteId, session]))
    .digest('hex')
    .slice(0, 32);
  return `ba-${digest}`;
}

function sessionMetadataPath(paths, name) {
  return join(paths.sessions, `${name}.json`);
}

async function parseJsonOutput(stdout, action) {
  const line = stdout.trim().split('\n').filter(Boolean).at(-1);
  let response;
  try {
    response = JSON.parse(line);
  } catch {
    throw commandError(action);
  }
  if (response?.success !== true) throw commandError(action);
  return response;
}

async function spawnCaptured(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const collect = (current, chunk) => `${current}${chunk}`.slice(-MAX_UPSTREAM_OUTPUT);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runtimeEnvironment(paths, env) {
  await ensurePrivateDirectory(paths.socketDirectory);
  const fontEnv = await verifiedBrowserFontEnvironment(withoutProxyEnvironment(env));
  return managedAgentBrowserEnvironment(fontEnv, paths.socketDirectory);
}

async function runAgentBrowser(paths, configPath, args, env, action = args[0]) {
  const [{ binary }] = await Promise.all([
    verifyAgentBrowserBinary(),
    verifyAgentBrowserPolicy(),
  ]);
  const result = await spawnCaptured(binary, [
    '--config', configPath,
    '--json',
    ...args,
  ], {
    cwd: repositoryRoot,
    env: await runtimeEnvironment(paths, env),
  });
  if (result.code !== 0 || result.signal) throw commandError(action);
  const response = await parseJsonOutput(result.stdout, action);
  return { response, stdout: result.stdout };
}

async function maintenanceConfig(paths, env) {
  const path = join(paths.configs, 'maintenance.json');
  await writeJsonAtomic(path, {
    json: true,
    namespace: agentBrowserNamespace(env),
    contentBoundaries: true,
    maxOutput: 50_000,
    actionPolicy: agentBrowserPolicyPath,
    idleTimeout: '1h',
    noAutoDialog: true,
    plugins: [],
    extensions: [],
    initScripts: [],
    enable: [],
    restoreSave: 'never',
  });
  return path;
}

async function listActiveSessions(paths, env) {
  const config = await maintenanceConfig(paths, env);
  const { response } = await runAgentBrowser(paths, config, ['session', 'list'], env, 'session list');
  const sessions = response.data?.sessions;
  if (!Array.isArray(sessions) || !sessions.every((item) => typeof item === 'string')) {
    throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', 'could not verify active agent-browser sessions');
  }
  return new Set(sessions);
}

async function processUsesProfile(profilePath) {
  if (!profilePath) return false;
  let entries;
  try {
    entries = await readdir('/proc', { withFileTypes: true });
  } catch {
    throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', 'could not inspect browser processes');
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const commandLine = await readFile(`/proc/${entry.name}/cmdline`, 'utf8');
      if (commandLine.split('\0').some((arg) => arg === `--user-data-dir=${profilePath}`)) return true;
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return false;
}

async function hasChromeProfileMarker(profilePath) {
  try {
    const [port, websocketPath] = (await readFile(join(profilePath, 'DevToolsActivePort'), 'utf8'))
      .trim()
      .split('\n');
    return Number.isInteger(Number(port))
      && Number(port) > 0
      && websocketPath.startsWith('/devtools/browser/');
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', 'Chrome profile marker could not be inspected');
  }
}

async function recordRuntimeIdentity(paths, metadata, env) {
  const { response } = await runAgentBrowser(paths, metadata.configPath, ['session', 'info'], env, 'session info');
  const daemonPid = response.data?.pid ?? response.data?.runtime?.backgroundPid;
  if (!Number.isInteger(daemonPid) || daemonPid <= 0) {
    throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', 'agent-browser daemon identity could not be verified');
  }
  const daemonAlive = processIsAlive(daemonPid);
  let profileActive = false;
  for (let attempt = 0; metadata.profilePath && attempt < 20 && !profileActive; attempt += 1) {
    profileActive = await hasChromeProfileMarker(metadata.profilePath);
    if (!profileActive) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!daemonAlive || !profileActive) {
    throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', 'Chrome profile identity could not be verified');
  }
  metadata.daemonPid = daemonPid;
  metadata.browserProfilePath = metadata.profilePath;
  await writeJsonAtomic(metadata.metadataPath, { ...metadata, metadataPath: undefined });
}

async function hasOpenFiles(profilePath, env) {
  if (!profilePath || !(await exists(profilePath))) return false;
  for (const [command, args] of [['lsof', ['+D', profilePath]], ['fuser', [profilePath]]]) {
    try {
      const result = await spawnCaptured(command, args, { env: withoutProxyEnvironment(env) });
      if (result.code === 0) return true;
      if (result.code === 1) return false;
      throw new Error('probe failed');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', 'could not verify profile file holders');
    }
  }
  throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', 'lsof or fuser is required for safe runtime recovery');
}

async function assertRuntimeInactive(metadata, paths, env) {
  const active = await listActiveSessions(paths, env);
  if (metadata.sessionName && active.has(metadata.sessionName)) {
    throw new BrowserAgentError('RUNTIME_ACTIVE', 'the managed browser session is still active');
  }
  if (metadata.profilePath && await processUsesProfile(metadata.profilePath)) {
    throw new BrowserAgentError('RUNTIME_ACTIVE', 'Chrome is still using the managed profile');
  }
  if (metadata.profilePath && await hasOpenFiles(metadata.profilePath, env)) {
    throw new BrowserAgentError('RUNTIME_ACTIVE', 'the managed profile still has open file holders');
  }
  if (metadata.browserProfilePath && metadata.browserProfilePath !== metadata.profilePath) {
    if (await processUsesProfile(metadata.browserProfilePath)) {
      throw new BrowserAgentError('RUNTIME_ACTIVE', 'Chrome is still using its recorded user-data directory');
    }
    if (await hasOpenFiles(metadata.browserProfilePath, env)) {
      throw new BrowserAgentError('RUNTIME_ACTIVE', 'the recorded user-data directory still has open file holders');
    }
  }
}

async function reclaimSiteLock(paths, env, { expectedOwner, hooks, verifyInactive } = {}) {
  return reclaimLock(paths.lock, paths.archive, 'stale-lock', async (metadata) => {
    if (expectedOwner && metadata.owner !== expectedOwner) {
      throw new BrowserAgentError('RUNTIME_ACTIVE', 'the site lock belongs to a different lifecycle');
    }
    assertManagedProfilePath(metadata.profilePath, paths);
    if (processIsAlive(metadata.pid)) throw new BrowserAgentError('RUNTIME_ACTIVE', 'the site profile owner is still running');
    if (verifyInactive) {
      await verifyInactive(metadata);
      return;
    }
    const candidates = metadata.profilePath ? [metadata.profilePath] : [paths.profile, paths.loginProfile];
    for (const profilePath of candidates) {
      await assertRuntimeInactive({ ...metadata, profilePath }, paths, env);
    }
  }, hooks);
}

export async function acquireSiteLock(paths, owner, metadata, env, { hooks, verifyInactive } = {}) {
  try {
    await acquireLock(paths.lock, owner, metadata);
    return;
  } catch (error) {
    if (error.code !== 'LOCK_HELD') throw error;
  }
  const reclaimed = await reclaimSiteLock(paths, env, { hooks, verifyInactive });
  if (!reclaimed) {
    throw new BrowserAgentError('RUNTIME_ACTIVE', 'the site profile lock changed during recovery');
  }
  try {
    await acquireLock(paths.lock, owner, metadata);
  } catch (error) {
    if (error.code === 'LOCK_HELD') {
      throw new BrowserAgentError('RUNTIME_ACTIVE', 'another site profile owner acquired the lock');
    }
    throw error;
  }
}

export async function acquireCommandLock(paths, name, { hooks } = {}) {
  const path = join(paths.commandLocks, `${name}.json`);
  const owner = createLockOwner(`command:${name}`);
  try {
    await acquireLock(path, owner);
    return { path, owner };
  } catch (error) {
    if (error.code !== 'LOCK_HELD') throw error;
  }
  const reclaimed = await reclaimLock(path, paths.archive, 'stale-command-lock', async (current) => {
    if (processIsAlive(current.pid)) throw new BrowserAgentError('SESSION_BUSY', 'another command is already running for this session');
  }, hooks);
  if (!reclaimed) throw new BrowserAgentError('SESSION_BUSY', 'the command lock changed during recovery');
  try {
    await acquireLock(path, owner);
    return { path, owner };
  } catch (error) {
    if (error.code === 'LOCK_HELD') {
      throw new BrowserAgentError('SESSION_BUSY', 'another command acquired the session lock');
    }
    throw error;
  }
}

async function writeManagedConfig(site, paths, metadata, env) {
  const executablePath = await resolveBrowserExecutable(site.browser.channel, { env });
  const config = {
    json: true,
    session: metadata.sessionName,
    namespace: agentBrowserNamespace(env),
    executablePath,
    headed: true,
    args: `--lang=${site.browser.locale},--accept-lang=${site.browser.locale}`,
    headers: JSON.stringify({ 'Accept-Language': site.browser.locale }),
    extensions: [],
    initScripts: [],
    enable: [],
    autoConnect: false,
    pinTab: false,
    allowFileAccess: false,
    ignoreHttpsErrors: false,
    hideScrollbars: false,
    downloadPath: metadata.downloadPath,
    contentBoundaries: true,
    maxOutput: 50_000,
    actionPolicy: agentBrowserPolicyPath,
    idleTimeout: '1h',
    noAutoDialog: true,
    engine: 'chrome',
    plugins: [],
    restoreSave: 'never',
  };
  if (metadata.profilePath) config.profile = metadata.profilePath;
  await writeJsonAtomic(metadata.configPath, config);
  return executablePath;
}

function originsFromTabs(tabs, site) {
  if (!Array.isArray(tabs) || tabs.length === 0) throw policyError('tab state could not be verified');
  const origins = [];
  let activeOrigin;
  let activeCount = 0;
  for (const tab of tabs) {
    if (!tab || tab.type !== 'page' || typeof tab.url !== 'string') throw policyError('an unknown top-level target was detected');
    if (tab.url === 'about:blank') {
      origins.push('about:blank');
      if (tab.active === true) {
        activeOrigin = 'about:blank';
        activeCount += 1;
      }
      continue;
    }
    let parsed;
    try {
      parsed = new URL(tab.url);
    } catch {
      throw policyError('a tab reported an invalid URL');
    }
    if (!site.allowedOrigins.includes(parsed.origin)) throw policyError('a tab left the configured top-level origins');
    origins.push(parsed.origin);
    if (tab.active === true) {
      activeOrigin = parsed.origin;
      activeCount += 1;
    }
  }
  if (activeCount !== 1) throw policyError('the active top-level tab could not be determined');
  return { origins: [...new Set(origins)].sort(), activeOrigin };
}

async function inspectTabs(site, paths, metadata, env) {
  try {
    const { response } = await runAgentBrowser(paths, metadata.configPath, ['tab', 'list'], env, 'tab list');
    return originsFromTabs(response.data?.tabs, site);
  } catch (error) {
    if (error.code === 'BROWSER_POLICY_DENIED') throw error;
    throw policyError('tab state could not be verified');
  }
}

async function assertStreamDisabled(paths, metadata, env) {
  try {
    const { response } = await runAgentBrowser(paths, metadata.configPath, ['stream', 'status'], env, 'stream status');
    if (response.data?.enabled !== false || response.data?.port !== null) {
      throw policyError('runtime streaming is enabled');
    }
  } catch (error) {
    if (error.code === 'BROWSER_POLICY_DENIED') throw error;
    throw policyError('runtime streaming state could not be verified');
  }
}

async function bootstrapSession(site, paths, metadata, env) {
  await runAgentBrowser(paths, metadata.configPath, ['open', 'about:blank'], env, 'bootstrap');
  await runAgentBrowser(paths, metadata.configPath, ['stream', 'disable'], env, 'stream disable');
  await assertStreamDisabled(paths, metadata, env);
  await runAgentBrowser(paths, metadata.configPath, [
    'set', 'viewport',
    String(site.browser.viewport.width),
    String(site.browser.viewport.height),
    String(site.browser.deviceScaleFactor),
  ], env, 'viewport bootstrap');
  await runAgentBrowser(paths, metadata.configPath, [
    'set', 'headers', JSON.stringify({ 'Accept-Language': site.browser.locale }),
  ], env, 'locale bootstrap');
  if (metadata.statePath) {
    await runAgentBrowser(paths, metadata.configPath, [
      'state', 'load', metadata.statePath,
    ], env, 'authentication state bootstrap');
  }
  const tabState = await inspectTabs(site, paths, metadata, env);
  if (tabState.origins.length !== 1 || tabState.activeOrigin !== 'about:blank') throw policyError('bootstrap did not remain on about:blank');
}

function managedChild(root, value, label, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', `${label} is missing from session metadata`);
  }
  const absoluteRoot = resolve(root);
  const target = resolve(value);
  const rel = relative(absoluteRoot, target);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', `${label} escapes its managed runtime directory`);
  }
  return target;
}

function assertManagedProfilePath(profilePath, paths) {
  if (profilePath === undefined) return;
  const target = resolve(profilePath);
  if (target === resolve(paths.profile) || target === resolve(paths.loginProfile)) return;
  managedChild(paths.workingProfiles, target, 'profile path');
}

async function removeSessionArtifacts(paths, metadata) {
  if (metadata.workingProfile) await removeWorkingProfile(metadata.workingProfile, paths.workingProfiles);
  if (metadata.downloadPath) await rm(metadata.downloadPath, { recursive: true, force: true });
  if (metadata.configPath) await rm(metadata.configPath, { force: true });
  if (metadata.metadataPath) await rm(metadata.metadataPath, { force: true });
}

async function closeSession(paths, metadata, env, { archive = false, lifecycleHooks } = {}) {
  await runAgentBrowser(paths, metadata.configPath, ['close'], env, 'close');
  await lifecycleHooks?.afterEngineClose?.(metadata);
  if (archive && metadata.metadataPath) {
    await archiveRuntimeFile(metadata.metadataPath, paths.archive, 'stale-session');
    metadata.metadataPath = null;
  }
  await lifecycleHooks?.beforeCleanup?.(metadata);
  await removeSessionArtifacts(paths, metadata);
  if (metadata.siteLockOwner) await releaseLock(paths.lock, metadata.siteLockOwner);
}

async function failClosed(paths, metadata, env) {
  try {
    await closeSession(paths, metadata, env);
    return true;
  } catch {
    // Keep metadata and private artifacts for verified recovery.
    return false;
  }
}

async function readSessionMetadata(path, paths) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value
      || typeof value !== 'object'
      || Array.isArray(value)
      || !['browser', 'login'].includes(value.kind)
      || value.siteId !== basename(paths.runtime)
      || typeof value.sessionName !== 'string'
      || !/^ba-[a-z0-9_-]+$/i.test(value.sessionName)
      || basename(path, '.json') !== value.sessionName
      || typeof value.profilePath !== 'string'
      || typeof value.createdAt !== 'string'
      || !Number.isFinite(Date.parse(value.createdAt))) {
      throw new Error('invalid');
    }
    value.configPath = managedChild(paths.configs, value.configPath, 'config path');
    value.downloadPath = managedChild(paths.downloads, value.downloadPath, 'download path');
    value.workingProfile = managedChild(paths.workingProfiles, value.workingProfile, 'working profile', { optional: true });
    assertManagedProfilePath(value.profilePath, paths);
    if (value.workingProfile && resolve(value.profilePath) !== value.workingProfile) throw new Error('profile mismatch');
    if (value.statePath !== undefined && resolve(value.statePath) !== resolve(paths.authState)) throw new Error('state mismatch');
    if (value.browserProfilePath !== undefined && resolve(value.browserProfilePath) !== resolve(value.profilePath)) throw new Error('browser profile mismatch');
    if (value.daemonPid !== undefined && (!Number.isInteger(value.daemonPid) || value.daemonPid <= 0)) throw new Error('invalid daemon pid');
    if (value.siteLockOwner !== undefined && (typeof value.siteLockOwner !== 'string' || value.siteLockOwner.length === 0)) throw new Error('invalid lock owner');
    return { ...value, metadataPath: path };
  } catch {
    throw new BrowserAgentError('RUNTIME_INSPECTION_FAILED', 'session metadata is damaged');
  }
}

async function reconcileSession(paths, metadataPath, env) {
  const metadata = await readSessionMetadata(metadataPath, paths);
  if (metadata.siteLockOwner && await exists(paths.lock)) {
    const lock = await readLock(paths.lock);
    if (processIsAlive(lock.pid)) throw new BrowserAgentError('RUNTIME_ACTIVE', 'the site profile owner is still running');
  }
  await assertRuntimeInactive(metadata, paths, env);
  await archiveRuntimeFile(metadataPath, paths.archive, 'stale-session');
  metadata.metadataPath = null;
  await removeSessionArtifacts(paths, metadata);
  if (metadata.siteLockOwner && await exists(paths.lock)) {
    await reclaimSiteLock(paths, env, { expectedOwner: metadata.siteLockOwner });
  }
  return true;
}

async function prepareOperationSession(site, session, paths, env, { create }) {
  const name = managedSessionName(site.id, session);
  const metadataPath = sessionMetadataPath(paths, name);
  if (await exists(metadataPath)) {
    const metadata = await readSessionMetadata(metadataPath, paths);
    const active = await listActiveSessions(paths, env);
    if (active.has(name)) return { metadata, created: false };
    await reconcileSession(paths, metadataPath, env);
  }
  if (!create) throw new BrowserAgentError('SESSION_NOT_OPEN', 'run browser open before using this session');

  const workingProfile = join(paths.workingProfiles, name);
  const downloadPath = join(paths.downloads, name);
  const configPath = join(paths.configs, `${name}.json`);
  await ensurePrivateDirectory(paths.workingProfiles);
  await ensurePrivateDirectory(paths.downloads);
  await ensurePrivateDirectory(paths.configs);
  if (site.authMode === 'state' && !(await exists(paths.authState))) {
    throw new BrowserAgentError('AUTH_STATE_MISSING', `authentication state is missing for ${site.id}`);
  }
  const metadata = {
    kind: 'browser',
    siteId: site.id,
    sessionName: name,
    profilePath: workingProfile,
    workingProfile,
    statePath: site.authMode === 'state' ? paths.authState : undefined,
    downloadPath,
    configPath,
    metadataPath,
    createdAt: new Date().toISOString(),
  };
  let engineAttempted = false;
  try {
    // Record ownership before creating resources so unlock can always discover an interrupted setup.
    await writeJsonAtomic(metadataPath, { ...metadata, metadataPath: undefined });
    if (site.authMode === 'profile') {
      const owner = createLockOwner(`profile-copy:${name}`);
      await acquireSiteLock(paths, owner, { profilePath: paths.profile }, env);
      try {
        await cloneProfile(paths.profile, workingProfile, paths.workingProfiles);
      } finally {
        await releaseLock(paths.lock, owner);
      }
    } else {
      await ensurePrivateDirectory(workingProfile);
    }
    await mkdir(downloadPath, { recursive: true, mode: 0o700 });
    await writeManagedConfig(site, paths, metadata, env);
    engineAttempted = true;
    await bootstrapSession(site, paths, metadata, env);
    await recordRuntimeIdentity(paths, metadata, env);
    return { metadata, created: true };
  } catch (error) {
    if (!engineAttempted) await removeSessionArtifacts(paths, metadata);
    else await failClosed(paths, metadata, env);
    throw error;
  }
}

export async function runBrowserCommand(site, session, commandArgs, env = process.env) {
  const paths = siteRuntimePaths(site.id, env);
  const name = managedSessionName(site.id, session);
  const { path: lockPath, owner: commandLockOwner } = await acquireCommandLock(paths, name);
  let parsed = { action: 'unknown' };
  let metadata;
  let beforeOrigins = [];
  try {
    try {
      parsed = normalizeBrowserCommand(site, commandArgs);
    } catch (error) {
      const metadataPath = sessionMetadataPath(paths, name);
      if (error.code === 'BROWSER_POLICY_DENIED' && await exists(metadataPath)) {
        metadata = await readSessionMetadata(metadataPath, paths);
        const active = await listActiveSessions(paths, env);
        if (active.has(name)) await failClosed(paths, metadata, env);
        else await reconcileSession(paths, metadataPath, env);
      }
      throw error;
    }
    ({ metadata } = await prepareOperationSession(site, session, paths, env, { create: parsed.action === 'open' }));
    await assertStreamDisabled(paths, metadata, env);
    beforeOrigins = (await inspectTabs(site, paths, metadata, env)).origins;
    const { stdout } = await runAgentBrowser(paths, metadata.configPath, parsed.args, env, parsed.action);
    const afterState = parsed.closes ? { origins: [], activeOrigin: undefined } : await inspectTabs(site, paths, metadata, env);
    if (parsed.navigationUrl && afterState.activeOrigin === 'about:blank') {
      throw policyError('navigation did not finish on a configured top-level origin');
    }
    const afterOrigins = afterState.origins;
    await appendAudit(paths, {
      timestamp: new Date().toISOString(),
      site: site.id,
      session,
      action: parsed.action,
      outcome: 'success',
      beforeOrigins,
      afterOrigins,
    });
    if (parsed.closes) await removeSessionArtifacts(paths, metadata);
    return stdout.trimEnd();
  } catch (error) {
    if (metadata && error.code === 'BROWSER_POLICY_DENIED') await failClosed(paths, metadata, env);
    await appendAudit(paths, {
      timestamp: new Date().toISOString(),
      site: site.id,
      session,
      action: parsed.action,
      outcome: 'failure',
      beforeOrigins,
      afterOrigins: [],
      code: error.code ?? 'AGENT_BROWSER_COMMAND_FAILED',
    }).catch(() => {});
    throw error;
  } finally {
    await releaseLock(lockPath, commandLockOwner).catch(() => {});
  }
}

async function prepareLogin(site, paths, env) {
  const name = managedSessionName(site.id, 'login', 'login');
  const metadataPath = sessionMetadataPath(paths, name);
  if (await exists(metadataPath)) {
    const metadata = await readSessionMetadata(metadataPath, paths);
    const active = await listActiveSessions(paths, env);
    if (active.has(name)) throw new BrowserAgentError('RUNTIME_ACTIVE', 'a login session is already active');
    await reconcileSession(paths, metadataPath, env);
  }
  const owner = createLockOwner(`login:${site.id}`);
  const profilePath = site.authMode === 'profile' ? paths.profile : join(paths.workingProfiles, name);
  await acquireSiteLock(paths, owner, { sessionName: name, profilePath }, env);
  const metadata = {
    kind: 'login',
    siteId: site.id,
    sessionName: name,
    profilePath,
    workingProfile: site.authMode === 'state' ? profilePath : undefined,
    downloadPath: join(paths.downloads, name),
    configPath: join(paths.configs, `${name}.json`),
    metadataPath,
    siteLockOwner: owner,
    createdAt: new Date().toISOString(),
  };
  let engineAttempted = false;
  try {
    // The metadata is the recovery record and must exist before any disposable resource.
    await writeJsonAtomic(metadataPath, { ...metadata, metadataPath: undefined });
    await ensurePrivateDirectory(paths.workingProfiles);
    await ensurePrivateDirectory(profilePath);
    await ensurePrivateDirectory(metadata.downloadPath);
    await writeManagedConfig(site, paths, metadata, env);
    engineAttempted = true;
    await bootstrapSession(site, paths, metadata, env);
    await recordRuntimeIdentity(paths, metadata, env);
    return metadata;
  } catch (error) {
    if (!engineAttempted) {
      await removeSessionArtifacts(paths, metadata);
      await releaseLock(paths.lock, owner);
    } else {
      await failClosed(paths, metadata, env);
    }
    throw error;
  }
}

async function withLoginLifecycle(site, env, lifecycleHooks, operation) {
  const paths = siteRuntimePaths(site.id, env);
  const name = managedSessionName(site.id, 'login', 'login');
  const commandLock = await acquireCommandLock(paths, name);
  try {
    await lifecycleHooks?.afterLock?.({ paths, name });
    return await operation({ paths, name });
  } finally {
    await releaseLock(commandLock.path, commandLock.owner).catch(() => {});
  }
}

export async function openLogin(site, env = process.env, { lifecycleHooks } = {}) {
  return withLoginLifecycle(site, env, lifecycleHooks, async ({ paths }) => {
    const metadata = await prepareLogin(site, paths, env);
    try {
      const { stdout } = await runAgentBrowser(paths, metadata.configPath, ['open', site.loginUrl], env, 'login open');
      await inspectTabs(site, paths, metadata, env);
      return stdout.trimEnd();
    } catch (error) {
      await failClosed(paths, metadata, env);
      throw error;
    }
  });
}

async function validateAuthState(path, executablePath, site, env) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_AUTH_STATE_BYTES) throw new Error('size');
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(value.cookies) || !Array.isArray(value.origins)) throw new Error('shape');
    const browserEnv = await verifiedBrowserFontEnvironment(withoutProxyEnvironment(env));
    const browser = await chromium.launch({ executablePath, headless: true, env: browserEnv });
    try {
      const context = await browser.newContext({
        viewport: site.browser.viewport,
        deviceScaleFactor: site.browser.deviceScaleFactor,
        locale: site.browser.locale,
        storageState: path,
      });
      await context.close();
    } finally {
      await browser.close();
    }
  } catch {
    throw new BrowserAgentError('AUTH_STATE_INVALID', 'saved authentication state failed validation; existing state was not changed');
  }
}

export async function saveLogin(site, env = process.env, { lifecycleHooks } = {}) {
  if (site.authMode !== 'state') throw policyError(`site ${site.id} uses profile authentication; close the login session instead`);
  return withLoginLifecycle(site, env, lifecycleHooks, async ({ paths, name }) => {
    const metadataPath = sessionMetadataPath(paths, name);
    if (!(await exists(metadataPath))) throw new BrowserAgentError('SESSION_NOT_OPEN', 'login open must run before login save');
    const metadata = await readSessionMetadata(metadataPath, paths);
    const temporary = temporarySibling(paths.authState, '.storage-state.json');
    try {
      await ensurePrivateDirectory(join(paths.root, 'auth'));
      await assertStreamDisabled(paths, metadata, env);
      await inspectTabs(site, paths, metadata, env);
      await runAgentBrowser(paths, metadata.configPath, ['state', 'save', temporary], env, 'login save');
      const executablePath = await resolveBrowserExecutable(site.browser.channel, { env });
      await validateAuthState(temporary, executablePath, site, env);
      await chmod(temporary, 0o600);
      await rename(temporary, paths.authState);
      await closeSession(paths, metadata, env, { lifecycleHooks });
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

export async function closeLogin(site, env = process.env, { lifecycleHooks } = {}) {
  return withLoginLifecycle(site, env, lifecycleHooks, async ({ paths, name }) => {
    const metadataPath = sessionMetadataPath(paths, name);
    if (!(await exists(metadataPath))) throw new BrowserAgentError('SESSION_NOT_OPEN', 'no managed login session is open');
    const metadata = await readSessionMetadata(metadataPath, paths);
    await closeSession(paths, metadata, env, { lifecycleHooks });
  });
}

export async function unlockSite(site, env = process.env, { lockHooks } = {}) {
  const paths = siteRuntimePaths(site.id, env);
  const sessions = [];
  try {
    for (const entry of await readdir(paths.sessions, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const metadataPath = join(paths.sessions, entry.name);
      const metadata = await readSessionMetadata(metadataPath, paths);
      if (metadata.siteLockOwner && await exists(paths.lock)) {
        const lock = await readLock(paths.lock);
        if (processIsAlive(lock.pid)) {
          throw new BrowserAgentError('RUNTIME_ACTIVE', 'the site profile owner is still running');
        }
      }
      await assertRuntimeInactive(metadata, paths, env);
      sessions.push({ metadata, metadataPath });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const siteLock = await readLock(paths.lock);
  if (siteLock) {
    assertManagedProfilePath(siteLock.profilePath, paths);
    if (processIsAlive(siteLock.pid)) {
      throw new BrowserAgentError('RUNTIME_ACTIVE', 'the site profile owner is still running');
    }
    const candidates = siteLock.profilePath ? [siteLock.profilePath] : [paths.profile, paths.loginProfile];
    for (const profilePath of candidates) {
      await assertRuntimeInactive({ ...siteLock, profilePath }, paths, env);
    }
  }

  let archived = 0;
  for (const { metadata, metadataPath } of sessions) {
    await archiveRuntimeFile(metadataPath, paths.archive, 'stale-session');
    metadata.metadataPath = null;
    await removeSessionArtifacts(paths, metadata);
    archived += 1;
  }
  if (siteLock && await reclaimSiteLock(paths, env, { hooks: lockHooks })) {
    archived += 1;
  }
  return archived;
}

export async function createManagedProfileCopy(site, purpose, env = process.env) {
  if (!/^[a-z0-9_-]+$/.test(purpose)) throw policyError('profile copy purpose is invalid');
  const paths = siteRuntimePaths(site.id, env);
  const destination = temporarySibling(join(paths.workingProfiles, purpose), '.profile');
  const owner = createLockOwner(`profile-copy:${purpose}`);
  await acquireSiteLock(paths, owner, { profilePath: paths.profile }, env);
  try {
    await cloneProfile(paths.profile, destination, paths.workingProfiles);
  } finally {
    await releaseLock(paths.lock, owner);
  }
  return {
    profilePath: destination,
    cleanup: () => removeWorkingProfile(destination, paths.workingProfiles),
  };
}

export async function agentBrowserDoctor(env = process.env) {
  const verified = await verifyAgentBrowserBinary();
  await verifyAgentBrowserPolicy();
  const executablePath = await resolveBrowserExecutable('auto', { env });
  await access(agentBrowserPolicyPath, constants.R_OK);
  return { ...verified, executablePath };
}
