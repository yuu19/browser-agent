import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { extname, dirname } from 'node:path';
import { chromium } from 'playwright';
import { buildLocator, resolveStepTargets, resolveTarget } from './locator.js';
import { safeOutputPathChecked, siteRuntimePaths, temporarySibling } from './paths.js';
import { acquireLock, exists, releaseLock, replaceFileAtomic } from './runtime.js';

function resolveUrl(site, path) {
  const base = new URL(site.baseUrl);
  const target = new URL(path, base);
  if (target.origin !== base.origin) {
    throw new Error(`capture URL must stay on the configured origin ${base.origin}`);
  }
  return target.href;
}

async function runPreparation(page, steps) {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const purpose = `prepare[${index}] ${step.action}`;
    if (step.action === 'waitFor') {
      const locator = buildLocator(page, step.locator);
      await locator.first().waitFor({ state: step.state, timeout: step.timeoutMs });
      if (step.state === 'visible') await resolveStepTargets(page, step, purpose);
      continue;
    }
    const targets = await resolveStepTargets(page, step, purpose);
    switch (step.action) {
      case 'click':
        for (const target of targets) await target.click();
        break;
      case 'hover':
        for (const target of targets) await target.hover();
        break;
      case 'press':
        if (targets.length === 0) await page.keyboard.press(step.key);
        else for (const target of targets) await target.press(step.key);
        break;
      case 'scrollIntoView':
        for (const target of targets) await target.scrollIntoViewIfNeeded();
        break;
      default:
        throw new Error(`unsupported preparation action: ${step.action}`);
    }
  }
}

async function resolveMasks(page, definitions) {
  const masks = [];
  for (let index = 0; index < definitions.length; index += 1) {
    masks.push(...await resolveTarget(page, definitions[index], `mask[${index}]`));
  }
  return masks;
}

async function resolveAnnotations(page, definitions, fullPage, viewport, deviceScaleFactor) {
  const scroll = fullPage
    ? await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))
    : { x: 0, y: 0 };
  const annotations = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index];
    const targets = await resolveTarget(page, definition, `annotation[${index}]`);
    for (const target of targets) {
      const box = await target.boundingBox();
      if (!box) throw new Error(`annotation[${index}] has no renderable bounding box`);
      if (!fullPage && (box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height)) {
        throw new Error(`annotation[${index}] is outside the viewport; add a scrollIntoView preparation step or enable fullPage`);
      }
      annotations.push({
        x: (box.x + scroll.x) * deviceScaleFactor,
        y: (box.y + scroll.y) * deviceScaleFactor,
        width: box.width * deviceScaleFactor,
        height: box.height * deviceScaleFactor,
        color: definition.color,
        margin: definition.margin * deviceScaleFactor,
        strokeWidth: definition.strokeWidth * deviceScaleFactor,
        scale: deviceScaleFactor,
        label: definition.label ?? String(index + 1),
      });
    }
  }
  return annotations;
}

function annotationArguments(width, height, annotations) {
  const args = [];
  for (const item of annotations) {
    const x = Math.max(0, item.x - item.margin);
    const y = Math.max(0, item.y - item.margin);
    const rectWidth = Math.min(width - x, item.width + item.margin * 2);
    const rectHeight = Math.min(height - y, item.height + item.margin * 2);
    const radius = 14 * item.scale;
    const labelX = Math.min(width - radius, Math.max(radius, x));
    const labelY = Math.min(height - radius, Math.max(radius, y));
    args.push(
      '-stroke', item.color,
      '-strokewidth', String(item.strokeWidth),
      '-fill', 'none',
      '-draw', `rectangle ${x},${y} ${x + rectWidth},${y + rectHeight}`,
      '-stroke', 'none',
      '-fill', item.color,
      '-draw', `circle ${labelX},${labelY} ${labelX + radius},${labelY}`,
      '-fill', '#ffffff',
      '-font', 'DejaVu-Sans',
      '-pointsize', String(16 * item.scale),
      '-gravity', 'NorthWest',
      '-annotate', `+${Math.max(0, labelX - 5 * item.scale)}+${Math.max(0, labelY - 10 * item.scale)}`, item.label,
    );
  }
  return args;
}

async function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function imageDimensions(magick, path) {
  const output = await runProcess(magick, ['identify', '-format', '%w,%h', path]);
  const [width, height] = output.trim().split(',').map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('ImageMagick returned invalid image dimensions');
  return { width, height };
}

async function annotateImage(source, destination, annotations, env = process.env) {
  if (annotations.length === 0) {
    await replaceFileAtomic(source, destination);
    return;
  }
  const magick = env.BROWSER_AGENT_MAGICK || 'magick';
  const { width, height } = await imageDimensions(magick, source);
  await runProcess(magick, [source, ...annotationArguments(width, height, annotations), destination]);
}

async function openCaptureContext(site, paths, headed) {
  const options = {
    channel: site.browser.channel,
    headless: !headed,
    viewport: site.browser.viewport,
    deviceScaleFactor: site.browser.deviceScaleFactor,
    locale: site.browser.locale,
  };
  if (site.authMode === 'profile') {
    await mkdir(paths.profile, { recursive: true, mode: 0o700 });
    const context = await chromium.launchPersistentContext(paths.profile, options);
    return { browser: null, context };
  }
  if (!(await exists(paths.authState))) {
    throw new Error(`authentication state is missing for ${site.id}; run login open and login save first`);
  }
  const browser = await chromium.launch({ channel: site.browser.channel, headless: !headed });
  const context = await browser.newContext({
    viewport: site.browser.viewport,
    deviceScaleFactor: site.browser.deviceScaleFactor,
    locale: site.browser.locale,
    storageState: paths.authState,
  });
  return { browser, context };
}

export async function captureScreenshot(site, capture, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const output = await safeOutputPathChecked(cwd, options.output ?? capture.output);
  if (extname(output).toLowerCase() !== '.png') throw new Error('capture output must use the .png extension');
  await mkdir(dirname(output), { recursive: true });

  const fullPage = options.fullPage ?? capture.fullPage;
  const headed = options.headed ?? site.browser.captureHeaded;
  const paths = siteRuntimePaths(site.id, env);
  const lockOwner = `capture:${process.pid}`;
  const masked = temporarySibling(output, '.masked.png');
  const annotated = temporarySibling(output, '.annotated.png');
  let browser;
  let context;
  if (site.authMode === 'profile') await acquireLock(paths.lock, lockOwner);
  try {
    ({ browser, context } = await openCaptureContext(site, paths, headed));
    const pages = context.pages();
    const page = pages[0] ?? await context.newPage();
    await page.goto(resolveUrl(site, options.path ?? capture.path), { waitUntil: 'domcontentloaded' });
    await runPreparation(page, capture.prepare);
    if (capture.waitMs > 0) await page.waitForTimeout(capture.waitMs);

    // Resolve every required target before writing any image.
    const masks = await resolveMasks(page, capture.masks);
    const annotations = await resolveAnnotations(
      page,
      capture.annotations,
      fullPage,
      site.browser.viewport,
      site.browser.deviceScaleFactor,
    );
    await page.screenshot({
      path: masked,
      fullPage,
      scale: 'device',
      mask: masks,
      maskColor: capture.maskColor,
      animations: 'disabled',
      caret: 'hide',
    });

    await annotateImage(masked, annotated, annotations, env);
    await replaceFileAtomic(annotated, output);
    return output;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await rm(masked, { force: true });
    await rm(annotated, { force: true });
    if (site.authMode === 'profile') await releaseLock(paths.lock, lockOwner).catch(() => {});
  }
}
