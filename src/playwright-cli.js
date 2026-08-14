import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { repositoryRoot, safeOutputPathChecked, siteRuntimePaths, temporarySibling } from './paths.js';
import { acquireLock, exists, releaseLock, writeJsonAtomic } from './runtime.js';

const cliPath = join(repositoryRoot, 'node_modules', '.bin', 'playwright-cli');

export async function runPlaywrightCli(args, { captureOutput = false } = {}) {
  if (!(await exists(cliPath))) {
    throw new Error('local playwright-cli is not installed; run npm install in the browser-agent repository');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: repositoryRoot,
      env: process.env,
      stdio: captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (captureOutput) {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) return resolve({ stdout, stderr });
      const detail = captureOutput ? `\n${stderr || stdout}` : '';
      reject(new Error(`playwright-cli exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail}`));
    });
  });
}

function browserConfig(site, runtimePaths, { headed, login = false } = {}) {
  const browser = {
    browserName: 'chromium',
    launchOptions: {
      channel: site.browser.channel,
      headless: !headed,
    },
    contextOptions: {
      viewport: site.browser.viewport,
      deviceScaleFactor: site.browser.deviceScaleFactor,
      locale: site.browser.locale,
    },
  };

  if (site.authMode === 'profile') {
    browser.userDataDir = runtimePaths.profile;
  } else if (login) {
    browser.userDataDir = runtimePaths.loginProfile;
  } else {
    browser.isolated = true;
    browser.contextOptions.storageState = runtimePaths.authState;
  }
  return { browser, outputDir: runtimePaths.runtime };
}

async function writeRuntimeConfig(site, runtimePaths, options) {
  const name = options.login ? 'login-cli.json' : `${options.session}-cli.json`;
  const path = join(runtimePaths.runtime, name);
  await writeJsonAtomic(path, browserConfig(site, runtimePaths, options));
  return path;
}

export async function openLogin(site, env = process.env) {
  const paths = siteRuntimePaths(site.id, env);
  const owner = `login:${site.id}`;
  await acquireLock(paths.lock, owner);
  try {
    await mkdir(site.authMode === 'profile' ? paths.profile : paths.loginProfile, { recursive: true, mode: 0o700 });
    const config = await writeRuntimeConfig(site, paths, { headed: true, login: true, session: `login-${site.id}` });
    await runPlaywrightCli([`-s=browser-agent-login-${site.id}`, 'open', site.loginUrl, `--config=${config}`]);
  } catch (error) {
    await releaseLock(paths.lock, owner);
    throw error;
  }
}

export async function saveLogin(site, env = process.env) {
  if (site.authMode !== 'state') {
    throw new Error(`site ${site.id} uses profile auth; browser state is saved automatically, use login close`);
  }
  const paths = siteRuntimePaths(site.id, env);
  const owner = `login:${site.id}`;
  const temporary = temporarySibling(paths.authState, '.storage-state.json');
  await mkdir(dirname(paths.authState), { recursive: true, mode: 0o700 });
  try {
    await runPlaywrightCli([`-s=browser-agent-login-${site.id}`, 'state-save', temporary]);
    await chmod(temporary, 0o600);
    await rename(temporary, paths.authState);
    await runPlaywrightCli([`-s=browser-agent-login-${site.id}`, 'close']);
    await releaseLock(paths.lock, owner);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function closeLogin(site, env = process.env) {
  const paths = siteRuntimePaths(site.id, env);
  const owner = `login:${site.id}`;
  await runPlaywrightCli([`-s=browser-agent-login-${site.id}`, 'close']);
  await releaseLock(paths.lock, owner);
}

const FORBIDDEN_OPEN_OPTIONS = ['--browser', '--config', '--extension', '--headed', '--persistent', '--profile'];

function assertControlledOpenArgs(args) {
  for (const arg of args) {
    if (FORBIDDEN_OPEN_OPTIONS.some((option) => arg === option || arg.startsWith(`${option}=`))) {
      throw new Error(`${arg} is managed by the site configuration and cannot be overridden`);
    }
  }
}

export async function runBrowserCommand(site, session, commandArgs, env = process.env) {
  if (commandArgs.length === 0) throw new Error('browser requires a playwright-cli command');
  const paths = siteRuntimePaths(site.id, env);
  const sessionName = `browser-agent-${site.id}-${session}`;
  const command = commandArgs[0];
  const owner = `browser:${sessionName}`;

  if (command === 'open') {
    assertControlledOpenArgs(commandArgs.slice(1));
    if (site.authMode === 'state' && !(await exists(paths.authState))) {
      throw new Error(`authentication state is missing for ${site.id}; run login open and login save first`);
    }
    if (site.authMode === 'profile') await acquireLock(paths.lock, owner);
    try {
      if (site.authMode === 'profile') await mkdir(paths.profile, { recursive: true, mode: 0o700 });
      const config = await writeRuntimeConfig(site, paths, { headed: true, login: false, session: sessionName });
      const rest = commandArgs.slice(1);
      const url = rest.length > 0 && !rest[0].startsWith('-') ? rest.shift() : site.baseUrl;
      await runPlaywrightCli([`-s=${sessionName}`, 'open', url, ...rest, `--config=${config}`]);
    } catch (error) {
      if (site.authMode === 'profile') await releaseLock(paths.lock, owner);
      throw error;
    }
    return;
  }

  const rewrittenArgs = [...commandArgs];
  if (['screenshot', 'snapshot', 'pdf'].includes(command)) {
    for (let index = 1; index < rewrittenArgs.length; index += 1) {
      if (rewrittenArgs[index] === '--filename') {
        const value = rewrittenArgs[index + 1];
        if (!value) throw new Error('--filename requires a value');
        const output = await safeOutputPathChecked(process.cwd(), value);
        await mkdir(dirname(output), { recursive: true });
        rewrittenArgs.splice(index, 2, `--filename=${output}`);
        break;
      }
      if (rewrittenArgs[index].startsWith('--filename=')) {
        const output = await safeOutputPathChecked(process.cwd(), rewrittenArgs[index].slice('--filename='.length));
        await mkdir(dirname(output), { recursive: true });
        rewrittenArgs[index] = `--filename=${output}`;
        break;
      }
    }
  }
  await runPlaywrightCli([`-s=${sessionName}`, ...rewrittenArgs]);
  if (command === 'close' && site.authMode === 'profile') await releaseLock(paths.lock, owner);
}

export async function unlockSite(site, env = process.env) {
  const paths = siteRuntimePaths(site.id, env);
  await releaseLock(paths.lock);
}
