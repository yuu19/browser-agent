import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// agent-browser 0.35.1 accepts managed Unix socket paths through 103 bytes;
// 104 bytes and above fail during bootstrap even though Linux sun_path is larger.
const agentBrowserUnixSocketPathMaxBytes = 103;
const managedSocketSuffixBytes = Buffer.byteLength(join(
  'namespaces',
  `ba-${'0'.repeat(16)}`,
  'run',
  `ba-${'0'.repeat(32)}.sock`,
)) + 1;
const agentBrowserSocketDirectoryMaxBytes = agentBrowserUnixSocketPathMaxBytes - managedSocketSuffixBytes;

export function dataRoot(env = process.env) {
  if (env.BROWSER_AGENT_DATA_DIR) return resolve(env.BROWSER_AGENT_DATA_DIR);
  const base = env.XDG_DATA_HOME ? resolve(env.XDG_DATA_HOME) : join(homedir(), '.local', 'share');
  return join(base, 'browser-agent');
}

export function sitesRoot(env = process.env) {
  return env.BROWSER_AGENT_SITES_DIR
    ? resolve(env.BROWSER_AGENT_SITES_DIR)
    : join(repositoryRoot, 'sites');
}

export function siteRuntimePaths(siteId, env = process.env) {
  const root = dataRoot(env);
  const runtimeRoot = join(root, 'runtime');
  const runtime = join(runtimeRoot, siteId);
  return {
    root,
    profile: join(root, 'profiles', siteId),
    loginProfile: join(root, 'profiles', `${siteId}-login`),
    authState: join(root, 'auth', `${siteId}.json`),
    runtimeRoot,
    runtime,
    socketDirectory: agentBrowserSocketDirectory(env),
    sessions: join(runtime, 'sessions'),
    workingProfiles: join(runtime, 'working-profiles'),
    downloads: join(runtime, 'downloads'),
    configs: join(runtime, 'configs'),
    audit: join(runtime, 'audit.jsonl'),
    archive: join(runtimeRoot, 'archive', siteId),
    lock: join(runtimeRoot, 'locks', `${siteId}.json`),
    commandLocks: join(runtimeRoot, 'command-locks'),
  };
}

export function agentBrowserNamespace(env = process.env) {
  const digest = createHash('sha256').update(dataRoot(env)).digest('hex').slice(0, 16);
  return `ba-${digest}`;
}

export function agentBrowserSocketDirectory(env = process.env) {
  const digest = createHash('sha256').update(dataRoot(env)).digest('hex').slice(0, 12);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const candidates = [];
  if (env.XDG_RUNTIME_DIR) {
    // XDG_RUNTIME_DIR is already private to the current user, so repeating the UID
    // wastes bytes from Linux's fixed-size Unix-domain socket pathname.
    candidates.push(join(resolve(env.XDG_RUNTIME_DIR), `ba-${digest}`));
  }
  candidates.push(join(tmpdir(), `ba-${uid}-${digest}`));

  const socketDirectory = candidates.find(
    (candidate) => Buffer.byteLength(candidate) <= agentBrowserSocketDirectoryMaxBytes,
  );
  if (!socketDirectory) {
    throw new Error(
      `agent-browser socket directory exceeds the ${agentBrowserSocketDirectoryMaxBytes}-byte managed limit`,
    );
  }
  return socketDirectory;
}

export function safeOutputPath(cwd, output) {
  if (typeof output !== 'string' || output.trim() === '') {
    throw new Error('capture output must be a non-empty relative path');
  }
  if (isAbsolute(output)) throw new Error(`absolute output paths are not allowed: ${output}`);

  const root = resolve(cwd);
  const target = resolve(root, output);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`output escapes the current project directory: ${output}`);
  }
  if (target === root) throw new Error('capture output must name a file');
  return target;
}

export async function safeOutputPathChecked(cwd, output) {
  const root = resolve(cwd);
  const target = safeOutputPath(root, output);
  const segments = relative(root, target).split(sep);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`output path contains a symbolic link: ${relative(root, current)}`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

export function temporarySibling(outputPath, suffix = '.png') {
  return join(dirname(outputPath), `.${randomUUID()}${suffix}`);
}

export function projectSessionId(cwd) {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 10);
}

export function assertSafeId(value, label = 'identifier') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new Error(`${label} must match /^[a-z0-9][a-z0-9_-]*$/`);
  }
  return value;
}
