const PROXY_VARIABLES = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

export function withoutProxyEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => !PROXY_VARIABLES.has(key)),
  );
}

export function managedAgentBrowserEnvironment(source, socketDirectory) {
  const clean = withoutProxyEnvironment(source);
  for (const key of Object.keys(clean)) {
    if (key.startsWith('AGENT_BROWSER_')) delete clean[key];
  }
  clean.AGENT_BROWSER_SOCKET_DIR = socketDirectory;
  return clean;
}
