import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryRoot } from './paths.js';

export const agentBrowserManifestPath = join(repositoryRoot, 'config', 'agent-browser-binaries.json');
export const agentBrowserPolicyPath = join(repositoryRoot, 'config', 'agent-browser-action-policy.json');

const APPROVED_ACTIONS = [
  'back', 'boundingbox', 'check', 'click', 'close', 'count', 'dialog', 'fill',
  'focus', 'forward', 'getbyalttext', 'getbylabel', 'getbyplaceholder', 'getbyrole',
  'getbytestid', 'getbytext', 'getbytitle', 'gettext', 'headers', 'hover',
  'ischecked', 'isenabled', 'isvisible', 'keyboard', 'launch', 'navigate', 'nth',
  'press', 'read', 'reload', 'scroll', 'scrollintoview', 'select', 'session_info',
  'snapshot', 'state_load', 'state_save', 'stream_disable', 'stream_status',
  'styles', 'tab_close', 'tab_list', 'tab_switch', 'title', 'type', 'uncheck',
  'url', 'viewport', 'wait', 'waitforloadstate', 'waitforurl',
].sort();

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error(`${label} is missing or invalid`);
  }
}

export async function verifyAgentBrowserBinary({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const platformKey = `${platform}-${arch}`;
  const manifest = await readJson(agentBrowserManifestPath, 'agent-browser binary manifest');
  const entry = manifest.platforms?.[platformKey];
  if (!entry || !['linux-x64', 'linux-arm64'].includes(platformKey)) {
    throw new Error(`agent-browser is not approved on platform ${platformKey}`);
  }

  const packageRoot = join(repositoryRoot, 'node_modules', 'agent-browser');
  const packageJson = await readJson(join(packageRoot, 'package.json'), 'local agent-browser package');
  if (packageJson.version !== manifest.version) {
    throw new Error('local agent-browser version does not match the approved manifest');
  }

  const binary = join(packageRoot, 'bin', entry.file);
  await access(binary, constants.X_OK);
  if (await sha256(binary) !== entry.sha256) {
    throw new Error(`agent-browser binary integrity check failed for ${platformKey}`);
  }
  return { binary, version: manifest.version, platformKey, sha256: entry.sha256 };
}

export async function verifyAgentBrowserPolicy({ policyPath = agentBrowserPolicyPath } = {}) {
  const policy = await readJson(policyPath, 'agent-browser action policy');
  const allow = Array.isArray(policy.allow) ? [...policy.allow].sort() : [];
  if (policy.default !== 'deny'
    || Object.keys(policy).sort().join(',') !== 'allow,default'
    || allow.length !== APPROVED_ACTIONS.length
    || allow.some((action, index) => action !== APPROVED_ACTIONS[index])) {
    throw new Error('agent-browser action policy does not match the approved default-deny policy');
  }
  return { default: policy.default, actions: allow.length };
}
