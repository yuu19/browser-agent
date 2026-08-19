import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { captureScreenshot } from '../src/capture.js';
import { verifiedBrowserFontEnvironment } from '../src/fonts.js';

const integrationTest = process.env.BROWSER_AGENT_INTEGRATION === '1' ? test : test.skip;

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
}

function fixtureUrl({ brokenImage = false } = {}) {
  const html = `<!doctype html>
    <html><body style="margin:0;background:white">
      <div data-testid="secret" style="position:absolute;left:100px;top:100px;width:200px;height:50px">secret@example.com</div>
      ${brokenImage ? '<img data-testid="optional-image" src="data:image/png;base64,broken" style="position:absolute;left:50px;top:300px;width:80px;height:80px">' : ''}
      <button aria-label="Open panel" style="position:absolute;left:400px;top:100px;width:100px;height:50px"
        onclick="document.querySelector('#panel').hidden=false">Open</button>
      <div id="panel" hidden style="position:absolute;left:400px;top:220px;width:180px;height:80px;background:#eee">Panel</div>
    </body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function fixtureSite(baseUrl) {
  return {
    id: 'fixture',
    baseUrl,
    loginUrl: baseUrl,
    authMode: 'profile',
    browser: {
      channel: 'chrome',
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 2,
      locale: 'en-US',
      captureHeaded: false,
    },
  };
}

function fixtureCapture(url, maskLocator = { type: 'testId', value: 'secret', exact: true }) {
  return {
    id: 'fixture',
    path: url,
    output: 'artifacts/result.png',
    fullPage: false,
    waitMs: 0,
    maskColor: '#112233',
    prepare: [
      {
        action: 'click',
        locator: { type: 'role', role: 'button', name: 'Open panel', exact: true },
        match: { kind: 'one' },
      },
    ],
    masks: [{ locator: maskLocator, match: { kind: 'one' }, required: true }],
    annotations: [
      {
        locator: { type: 'text', value: 'Panel', exact: true },
        match: { kind: 'one' },
        required: true,
        color: '#dc2626',
        margin: 4,
        strokeWidth: 4,
        label: '1',
      },
    ],
  };
}

integrationTest('capture masks before writing and adds an annotation', { timeout: 30_000 }, async () => {
  const url = fixtureUrl();
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-capture-'));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: join(root, 'data') };
  const output = await captureScreenshot(fixtureSite(url), fixtureCapture(url), { cwd: root, env });

  assert.equal(output, join(root, 'artifacts', 'result.png'));
  const dimensions = await commandOutput('magick', ['identify', '-format', '%w,%h', output]);
  assert.equal(dimensions, '1600,1200');
  const format = await commandOutput('magick', ['identify', '-format', '%m,%z,%[colorspace],%[channels]', output]);
  assert.equal(format, 'PNG,8,sRGB,srgb');
  const pixels = await commandOutput('magick', [output, '-format', '%[pixel:p{300,250}] %[pixel:p{792,500}]', 'info:']);
  assert.match(pixels.toLowerCase(), /1122?33|srgba?\(17,34,51(?:,1)?\)/);
  assert.match(pixels.toLowerCase(), /dc2626|srgba?\(220,38,38(?:,1)?\)/);
  assert.deepEqual((await readdir(join(root, 'artifacts'))).sort(), ['result.png']);
});

integrationTest('required mask failure preserves an existing output', { timeout: 30_000 }, async () => {
  const url = fixtureUrl();
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-fail-closed-'));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: join(root, 'data') };
  const output = join(root, 'artifacts', 'result.png');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(root, 'artifacts'));
  await writeFile(output, 'existing-safe-output');

  await assert.rejects(
    captureScreenshot(
      fixtureSite(url),
      fixtureCapture(url, { type: 'testId', value: 'missing', exact: true }),
      { cwd: root, env },
    ),
    /mask\[0\] locator did not match/,
  );
  assert.equal(await readFile(output, 'utf8'), 'existing-safe-output');
  assert.deepEqual((await readdir(join(root, 'artifacts'))).sort(), ['result.png']);
});

integrationTest('capture without annotations still publishes the final image', { timeout: 30_000 }, async () => {
  const url = fixtureUrl();
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-no-annotation-'));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: join(root, 'data') };
  const capture = fixtureCapture(url);
  capture.annotations = [];

  const output = await captureScreenshot(fixtureSite(url), capture, { cwd: root, env });
  const pixels = await commandOutput('magick', [output, '-format', '%[pixel:p{300,250}]', 'info:']);
  assert.match(pixels.toLowerCase(), /1122?33|srgba?\(17,34,51(?:,1)?\)/);
  const format = await commandOutput('magick', ['identify', '-format', '%m,%z,%[colorspace],%[channels]', output]);
  assert.equal(format, 'PNG,8,sRGB,srgb');
  assert.deepEqual((await readdir(join(root, 'artifacts'))).sort(), ['result.png']);
});

integrationTest('capture fails closed when a visible image cannot load', { timeout: 30_000 }, async () => {
  const url = fixtureUrl({ brokenImage: true });
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-broken-image-'));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: join(root, 'data') };

  await assert.rejects(
    captureScreenshot(fixtureSite(url), fixtureCapture(url), { cwd: root, env }),
    /visible image\(s\) failed to load/,
  );
  assert.deepEqual((await readdir(join(root, 'artifacts'))).sort(), []);
});

integrationTest('capture allows a reviewed exception for an intentionally broken image', { timeout: 30_000 }, async () => {
  const url = fixtureUrl({ brokenImage: true });
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-ignored-image-'));
  const env = { ...process.env, BROWSER_AGENT_DATA_DIR: join(root, 'data') };
  const capture = fixtureCapture(url);
  capture.readiness = {
    fonts: true,
    images: true,
    timeoutMs: 10_000,
    ignoreImages: [{
      locator: { type: 'testId', value: 'optional-image', exact: true },
      match: { kind: 'one' },
      required: true,
    }],
  };

  const output = await captureScreenshot(fixtureSite(url), capture, { cwd: root, env });
  const format = await commandOutput('magick', ['identify', '-format', '%m,%z,%[colorspace],%[channels]', output]);
  assert.equal(format, 'PNG,8,sRGB,srgb');
});

integrationTest('Chrome uses the repository-local fallback fonts', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-local-fonts-'));
  const env = await verifiedBrowserFontEnvironment({
    ...process.env,
    BROWSER_AGENT_DATA_DIR: join(root, 'data'),
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, env });
  try {
    const context = await browser.newContext({ locale: 'ja-JP' });
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body>
      <span id="ja" lang="ja" style="font-family:sans-serif">日本語</span>
      <span id="en" lang="en" style="font-family:sans-serif">English</span>
    </body></html>`);
    await page.evaluate(() => document.fonts.ready);

    const session = await context.newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root: documentNode } = await session.send('DOM.getDocument');
    for (const [selector, expected] of [['#ja', /Noto Sans JP/], ['#en', /Inter Variable/]]) {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector });
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      assert.ok(fonts.some((font) => expected.test(font.familyName)), `${selector} used ${fonts.map((font) => font.familyName).join(', ')}`);
    }
  } finally {
    await browser.close();
  }
});
