import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { captureScreenshot } from '../src/capture.js';

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

function fixtureUrl() {
  const html = `<!doctype html>
    <html><body style="margin:0;background:white">
      <div data-testid="secret" style="position:absolute;left:100px;top:100px;width:200px;height:50px">secret@example.com</div>
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
  assert.deepEqual((await readdir(join(root, 'artifacts'))).sort(), ['result.png']);
});
