import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeId, sitesRoot } from './paths.js';

const LOCATOR_TYPES = new Set(['role', 'label', 'text', 'testId', 'placeholder', 'css']);
const PREPARE_ACTIONS = new Set(['click', 'hover', 'press', 'scrollIntoView', 'waitFor']);
const WAIT_STATES = new Set(['attached', 'detached', 'visible', 'hidden']);
const PRIVACY_MODES = new Set(['masked', 'public']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function string(value, path, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty string');
  return value;
}

function boolean(value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function positiveInteger(value, path, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) fail(path, 'must be a positive integer');
  return value;
}

function validateDeviceScaleFactor(value, path, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || value > 4) {
    fail(path, 'must be a number between 1 and 4');
  }
  return value;
}

function nonNegativeInteger(value, path, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) fail(path, 'must be a non-negative integer');
  return value;
}

function onlyKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown property');
  }
}

export function validateMatch(value, path) {
  if (value === undefined || value === 'one') return { kind: 'one' };
  if (value === 'all') return { kind: 'all' };
  if (isObject(value) && Object.keys(value).length === 1 && Number.isInteger(value.count) && value.count > 0) {
    return { kind: 'count', count: value.count };
  }
  fail(path, 'must be "one", "all", or { "count": N }');
}

export function validateLocator(value, path) {
  if (!isObject(value)) fail(path, 'must be an object');
  onlyKeys(value, new Set(['type', 'role', 'name', 'value', 'exact']), path);
  const type = string(value.type, `${path}.type`);
  if (!LOCATOR_TYPES.has(type)) fail(`${path}.type`, `must be one of ${[...LOCATOR_TYPES].join(', ')}`);
  const exact = boolean(value.exact, `${path}.exact`, true);

  if (type === 'role') {
    const role = string(value.role, `${path}.role`);
    const name = string(value.name, `${path}.name`, { optional: true });
    if (value.value !== undefined) fail(`${path}.value`, 'is not valid for role locators');
    return { type, role, ...(name ? { name } : {}), exact };
  }

  if (value.role !== undefined || value.name !== undefined) {
    fail(path, 'role and name are only valid for role locators');
  }
  return { type, value: string(value.value, `${path}.value`), exact };
}

function validateTarget(value, path, { annotation = false } = {}) {
  if (!isObject(value)) fail(path, 'must be an object');
  const allowed = new Set(['locator', 'match', 'required']);
  if (annotation) {
    allowed.add('label');
    allowed.add('color');
    allowed.add('margin');
    allowed.add('strokeWidth');
  }
  onlyKeys(value, allowed, path);
  const target = {
    locator: validateLocator(value.locator, `${path}.locator`),
    match: validateMatch(value.match, `${path}.match`),
    required: boolean(value.required, `${path}.required`, true),
  };
  if (annotation) {
    target.label = string(value.label, `${path}.label`, { optional: true });
    target.color = value.color === undefined ? '#dc2626' : validateColor(value.color, `${path}.color`);
    target.margin = nonNegativeInteger(value.margin, `${path}.margin`, 4);
    target.strokeWidth = positiveInteger(value.strokeWidth, `${path}.strokeWidth`, 4);
  }
  return target;
}

export function validateMaskTarget(value, path = 'mask') {
  return validateTarget(value, path);
}

export function validateAnnotationTarget(value, path = 'annotation') {
  return validateTarget(value, path, { annotation: true });
}

function validateReadiness(value, path) {
  if (value === undefined) value = {};
  if (!isObject(value)) fail(path, 'must be an object');
  onlyKeys(value, new Set(['fonts', 'images', 'timeoutMs', 'ignoreImages']), path);
  const ignoreImages = value.ignoreImages ?? [];
  if (!Array.isArray(ignoreImages)) fail(`${path}.ignoreImages`, 'must be an array');
  const images = boolean(value.images, `${path}.images`, true);
  if (!images && ignoreImages.length > 0) {
    fail(`${path}.ignoreImages`, 'requires images to be enabled');
  }
  return {
    fonts: boolean(value.fonts, `${path}.fonts`, true),
    images,
    timeoutMs: positiveInteger(value.timeoutMs, `${path}.timeoutMs`, 10_000),
    ignoreImages: ignoreImages.map((target, index) => validateTarget(target, `${path}.ignoreImages[${index}]`)),
  };
}

export function assertCapturePrivacy(capture, path = 'capture') {
  const privacy = capture.privacy ?? 'masked';
  if (!PRIVACY_MODES.has(privacy)) fail(`${path}.privacy`, 'must be "masked" or "public"');
  if (privacy === 'masked' && !capture.masks?.some((mask) => mask.required !== false)) {
    fail(`${path}.masks`, 'masked captures require at least one required mask; use privacy "public" only for verified public pages');
  }
  return { ...capture, privacy };
}

function validateColor(value, path) {
  string(value, path);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) fail(path, 'must be a six-digit hex color');
  return value;
}

export function validatePrepare(value, path = 'prepare') {
  if (!isObject(value)) fail(path, 'must be an object');
  const action = string(value.action, `${path}.action`);
  if (!PREPARE_ACTIONS.has(action)) fail(`${path}.action`, `must be one of ${[...PREPARE_ACTIONS].join(', ')}`);
  onlyKeys(value, new Set(['action', 'locator', 'match', 'key', 'state', 'timeoutMs']), path);

  const step = { action };
  if (action !== 'press' || value.locator !== undefined) {
    step.locator = validateLocator(value.locator, `${path}.locator`);
    step.match = validateMatch(value.match, `${path}.match`);
  } else if (value.match !== undefined) {
    fail(`${path}.match`, 'requires a locator');
  }

  if (action === 'press') step.key = string(value.key, `${path}.key`);
  else if (value.key !== undefined) fail(`${path}.key`, 'is only valid for press');

  if (action === 'waitFor') {
    step.state = value.state ?? 'visible';
    if (!WAIT_STATES.has(step.state)) fail(`${path}.state`, `must be one of ${[...WAIT_STATES].join(', ')}`);
    step.timeoutMs = positiveInteger(value.timeoutMs, `${path}.timeoutMs`, 10_000);
  } else if (value.state !== undefined || value.timeoutMs !== undefined) {
    fail(path, 'state and timeoutMs are only valid for waitFor');
  }
  return step;
}

function validateBrowser(value, path) {
  if (value === undefined) value = {};
  if (!isObject(value)) fail(path, 'must be an object');
  onlyKeys(value, new Set(['channel', 'viewport', 'deviceScaleFactor', 'locale', 'captureHeaded']), path);
  const viewport = value.viewport ?? {};
  if (!isObject(viewport)) fail(`${path}.viewport`, 'must be an object');
  onlyKeys(viewport, new Set(['width', 'height']), `${path}.viewport`);
  return {
    channel: value.channel === undefined ? 'chrome' : string(value.channel, `${path}.channel`),
    viewport: {
      width: positiveInteger(viewport.width, `${path}.viewport.width`, 1440),
      height: positiveInteger(viewport.height, `${path}.viewport.height`, 900),
    },
    deviceScaleFactor: validateDeviceScaleFactor(value.deviceScaleFactor, `${path}.deviceScaleFactor`, 2),
    locale: value.locale === undefined ? 'ja-JP' : string(value.locale, `${path}.locale`),
    captureHeaded: boolean(value.captureHeaded, `${path}.captureHeaded`, false),
  };
}

export function validateSite(value, siteId, path = 'site.json') {
  if (!isObject(value)) fail(path, 'must be an object');
  onlyKeys(value, new Set(['baseUrl', 'loginUrl', 'authMode', 'browser']), path);
  const baseUrl = string(value.baseUrl, `${path}.baseUrl`);
  try {
    const parsed = new URL(baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) fail(`${path}.baseUrl`, 'must use http or https');
  } catch {
    fail(`${path}.baseUrl`, 'must be an absolute URL');
  }
  const loginUrl = value.loginUrl === undefined ? baseUrl : string(value.loginUrl, `${path}.loginUrl`);
  try {
    const parsed = new URL(loginUrl, baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) fail(`${path}.loginUrl`, 'must use http or https');
  } catch {
    fail(`${path}.loginUrl`, 'must be a valid URL');
  }
  const authMode = value.authMode ?? 'profile';
  if (!['profile', 'state'].includes(authMode)) fail(`${path}.authMode`, 'must be "profile" or "state"');
  return { id: siteId, baseUrl, loginUrl: new URL(loginUrl, baseUrl).href, authMode, browser: validateBrowser(value.browser, `${path}.browser`) };
}

export function validateCapture(value, captureId, path = 'captures.json') {
  if (!isObject(value)) fail(path, 'must be an object');
  onlyKeys(value, new Set(['path', 'output', 'privacy', 'fullPage', 'waitMs', 'maskColor', 'readiness', 'prepare', 'masks', 'annotations']), path);
  const prepare = value.prepare ?? [];
  const masks = value.masks ?? [];
  const annotations = value.annotations ?? [];
  if (!Array.isArray(prepare)) fail(`${path}.prepare`, 'must be an array');
  if (!Array.isArray(masks)) fail(`${path}.masks`, 'must be an array');
  if (!Array.isArray(annotations)) fail(`${path}.annotations`, 'must be an array');
  return assertCapturePrivacy({
    id: captureId,
    privacy: value.privacy ?? 'masked',
    path: string(value.path, `${path}.path`),
    output: string(value.output, `${path}.output`),
    fullPage: boolean(value.fullPage, `${path}.fullPage`, false),
    waitMs: nonNegativeInteger(value.waitMs, `${path}.waitMs`, 500),
    maskColor: value.maskColor === undefined ? '#1f2937' : validateColor(value.maskColor, `${path}.maskColor`),
    readiness: validateReadiness(value.readiness, `${path}.readiness`),
    prepare: prepare.map((step, index) => validatePrepare(step, `${path}.prepare[${index}]`)),
    masks: masks.map((target, index) => validateMaskTarget(target, `${path}.masks[${index}]`)),
    annotations: annotations.map((target, index) => validateAnnotationTarget(target, `${path}.annotations[${index}]`)),
  }, path);
}

async function readJson(path) {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`configuration file not found: ${path}`);
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${error.message}`);
  }
}

export async function loadSite(siteId, env = process.env) {
  assertSafeId(siteId, 'site id');
  const root = join(sitesRoot(env), siteId);
  const site = validateSite(await readJson(join(root, 'site.json')), siteId, `${siteId}/site.json`);
  const capturesValue = await readJson(join(root, 'captures.json'));
  if (!isObject(capturesValue)) fail(`${siteId}/captures.json`, 'must be an object keyed by capture id');
  const captures = {};
  for (const [captureId, capture] of Object.entries(capturesValue)) {
    assertSafeId(captureId, 'capture id');
    captures[captureId] = validateCapture(capture, captureId, `${siteId}/captures.json.${captureId}`);
  }
  return { site, captures, root };
}

export async function listSiteIds(env = process.env) {
  try {
    const entries = await readdir(sitesRoot(env), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && /^[a-z0-9][a-z0-9_-]*$/.test(entry.name)).map((entry) => entry.name).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
