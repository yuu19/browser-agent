import test from 'node:test';
import assert from 'node:assert/strict';
import { managedAgentBrowserEnvironment, withoutProxyEnvironment } from '../src/environment.js';

test('browser environments remove standard proxy variables', () => {
  const clean = withoutProxyEnvironment({
    PATH: '/bin',
    HTTP_PROXY: 'http://proxy.invalid',
    https_proxy: 'http://proxy.invalid',
    NO_PROXY: 'localhost',
  });
  assert.deepEqual(clean, { PATH: '/bin' });
});

test('agent-browser environment removes inherited controls and sets only the managed socket root', () => {
  const clean = managedAgentBrowserEnvironment({
    PATH: '/bin',
    AGENT_BROWSER_PROFILE: '/tmp/unsafe',
    AGENT_BROWSER_ALLOWED_DOMAINS: '*',
    BROWSER_AGENT_DATA_DIR: '/tmp/data',
  }, '/tmp/managed-sockets');
  assert.equal(clean.AGENT_BROWSER_PROFILE, undefined);
  assert.equal(clean.AGENT_BROWSER_ALLOWED_DOMAINS, undefined);
  assert.equal(clean.AGENT_BROWSER_SOCKET_DIR, '/tmp/managed-sockets');
  assert.equal(clean.BROWSER_AGENT_DATA_DIR, '/tmp/data');
});
