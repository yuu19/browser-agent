import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAudit } from '../src/audit.js';
import { siteRuntimePaths } from '../src/paths.js';

test('site-wide audit updates retain concurrent records from different sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'browser-agent-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = siteRuntimePaths('example', {
    ...process.env,
    BROWSER_AGENT_DATA_DIR: root,
    XDG_RUNTIME_DIR: root,
  });
  const records = Array.from({ length: 40 }, (_, index) => ({
    timestamp: new Date().toISOString(),
    site: 'example',
    session: `session-${index % 4}`,
    action: `action-${index}`,
    outcome: 'success',
  }));

  await Promise.all(records.map((record) => appendAudit(paths, record)));

  const actual = (await readFile(paths.audit, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(actual.length, records.length);
  assert.deepEqual(
    new Set(actual.map((record) => record.action)),
    new Set(records.map((record) => record.action)),
  );
});
