import { spawn } from 'node:child_process';
import { captureScreenshot } from './capture.js';
import {
  listSiteIds,
  loadSite,
  validateAnnotationTarget,
  validateMaskTarget,
  validatePrepare,
} from './config.js';
import { projectSessionId } from './paths.js';
import {
  closeLogin,
  openLogin,
  runBrowserCommand,
  saveLogin,
  unlockSite,
} from './playwright-cli.js';

const HELP = `browser-agent

Usage:
  browser-agent sites
  browser-agent validate [site]
  browser-agent login open <site>
  browser-agent login save <site>
  browser-agent login close <site>
  browser-agent browser <site> [--session=<name>] <playwright-cli command...>
  browser-agent capture <site> [capture] [options]
  browser-agent unlock <site>
  browser-agent doctor

Capture options:
  --path=<path-or-url>       Override the configured capture path
  --output=<relative.png>    Override the output path (must stay under cwd)
  --headed | --headless      Override browser visibility
  --full-page | --no-full-page
  --wait-ms=<milliseconds>
  --mask-color=<#rrggbb>
  --prepare=<json>           Append one validated preparation step
  --mask=<json>              Append one validated mask target
  --annotation=<json>        Append one validated annotation target

Runtime state defaults to ~/.local/share/browser-agent and can be moved with
BROWSER_AGENT_DATA_DIR. Site definitions can be moved with BROWSER_AGENT_SITES_DIR.`;

function requireArg(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function optionValue(args, index, name) {
  const arg = args[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), consumed: 1 };
  if (arg === name) return { value: requireArg(args[index + 1], `${name} requires a value`), consumed: 2 };
  return null;
}

function jsonOption(source, name) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON: ${error.message}`);
  }
}

function parseNonNegativeInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${name} must be a non-negative integer`);
  return number;
}

function parseCaptureArgs(args, captures) {
  let captureId;
  if (args[0] && !args[0].startsWith('-')) captureId = args.shift();
  const base = captureId
    ? structuredClone(requireArg(captures[captureId], `unknown capture id: ${captureId}`))
    : {
        id: 'adhoc',
        path: undefined,
        output: undefined,
        fullPage: false,
        waitMs: 500,
        maskColor: '#1f2937',
        prepare: [],
        masks: [],
        annotations: [],
      };
  const options = {};

  for (let index = 0; index < args.length;) {
    const arg = args[index];
    let parsed;
    if ((parsed = optionValue(args, index, '--path'))) {
      options.path = parsed.value;
    } else if ((parsed = optionValue(args, index, '--output'))) {
      options.output = parsed.value;
    } else if ((parsed = optionValue(args, index, '--wait-ms'))) {
      base.waitMs = parseNonNegativeInteger(parsed.value, '--wait-ms');
    } else if ((parsed = optionValue(args, index, '--mask-color'))) {
      if (!/^#[0-9a-fA-F]{6}$/.test(parsed.value)) throw new Error('--mask-color must be a six-digit hex color');
      base.maskColor = parsed.value;
    } else if ((parsed = optionValue(args, index, '--prepare'))) {
      base.prepare.push(validatePrepare(jsonOption(parsed.value, '--prepare'), `--prepare[${base.prepare.length}]`));
    } else if ((parsed = optionValue(args, index, '--mask'))) {
      base.masks.push(validateMaskTarget(jsonOption(parsed.value, '--mask'), `--mask[${base.masks.length}]`));
    } else if ((parsed = optionValue(args, index, '--annotation'))) {
      base.annotations.push(validateAnnotationTarget(jsonOption(parsed.value, '--annotation'), `--annotation[${base.annotations.length}]`));
    } else if (arg === '--headed') {
      options.headed = true;
      parsed = { consumed: 1 };
    } else if (arg === '--headless') {
      options.headed = false;
      parsed = { consumed: 1 };
    } else if (arg === '--full-page') {
      options.fullPage = true;
      parsed = { consumed: 1 };
    } else if (arg === '--no-full-page') {
      options.fullPage = false;
      parsed = { consumed: 1 };
    } else {
      throw new Error(`unknown capture option: ${arg}`);
    }
    index += parsed.consumed;
  }

  if (options.path === undefined && base.path === undefined) throw new Error('ad-hoc capture requires --path');
  if (options.output === undefined && base.output === undefined) throw new Error('ad-hoc capture requires --output');
  return { capture: base, options };
}

async function validateSites(siteId) {
  const ids = siteId ? [siteId] : await listSiteIds();
  if (ids.length === 0) throw new Error('no site definitions found');
  for (const id of ids) {
    const { captures } = await loadSite(id);
    console.log(`${id}: valid (${Object.keys(captures).length} capture definitions)`);
  }
}

async function commandVersion(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code === 0 ? output.trim().split('\n')[0] : null));
  });
}

async function doctor() {
  const checks = [
    ['Google Chrome', 'google-chrome', ['--version']],
    ['ImageMagick', process.env.BROWSER_AGENT_MAGICK || 'magick', ['-version']],
  ];
  let failed = false;
  for (const [label, command, args] of checks) {
    const version = await commandVersion(command, args);
    if (version) console.log(`ok  ${label}: ${version}`);
    else {
      failed = true;
      console.log(`missing  ${label}: ${command}`);
    }
  }
  if (failed) throw new Error('required runtime dependencies are missing');
}

export async function main(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }

  if (command === 'sites') {
    for (const id of await listSiteIds()) console.log(id);
    return;
  }
  if (command === 'validate') {
    await validateSites(args.shift());
    if (args.length) throw new Error(`unexpected argument: ${args[0]}`);
    return;
  }
  if (command === 'doctor') {
    if (args.length) throw new Error(`unexpected argument: ${args[0]}`);
    await doctor();
    return;
  }

  if (command === 'login') {
    const action = requireArg(args.shift(), 'login requires open, save, or close');
    const siteId = requireArg(args.shift(), 'login requires a site id');
    if (args.length) throw new Error(`unexpected argument: ${args[0]}`);
    const { site } = await loadSite(siteId);
    if (action === 'open') await openLogin(site);
    else if (action === 'save') await saveLogin(site);
    else if (action === 'close') await closeLogin(site);
    else throw new Error(`unknown login action: ${action}`);
    return;
  }

  if (command === 'browser') {
    const siteId = requireArg(args.shift(), 'browser requires a site id');
    let session = projectSessionId(process.cwd());
    if (args[0]?.startsWith('--session=')) session = args.shift().slice('--session='.length);
    if (!/^[a-zA-Z0-9_-]+$/.test(session)) throw new Error('session must contain only letters, numbers, underscores, and hyphens');
    const { site } = await loadSite(siteId);
    await runBrowserCommand(site, session, args);
    return;
  }

  if (command === 'capture') {
    const siteId = requireArg(args.shift(), 'capture requires a site id');
    const { site, captures } = await loadSite(siteId);
    const { capture, options } = parseCaptureArgs(args, captures);
    const output = await captureScreenshot(site, capture, options);
    console.log(output);
    return;
  }

  if (command === 'unlock') {
    const siteId = requireArg(args.shift(), 'unlock requires a site id');
    if (args.length) throw new Error(`unexpected argument: ${args[0]}`);
    const { site } = await loadSite(siteId);
    await unlockSite(site);
    console.log(`${siteId}: lock removed`);
    return;
  }

  throw new Error(`unknown command: ${command}\n\n${HELP}`);
}
