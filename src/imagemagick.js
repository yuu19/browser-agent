import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

function probeVersion(command, env) {
  return new Promise((resolve) => {
    const child = spawn(command, ['-version'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', () => {
      settled = true;
      resolve(null);
    });
    child.once('exit', (code) => {
      if (!settled) resolve(code === 0 ? output.trim().split('\n')[0] : null);
    });
  });
}

export function imageMagickRuntimeFor(command, version) {
  if (/ImageMagick 6\./.test(version)) {
    return {
      version,
      convert: { command, prefix: [] },
      identify: { command: join(dirname(command), 'identify'), prefix: [] },
    };
  }
  return {
    version,
    convert: { command, prefix: [] },
    identify: { command, prefix: ['identify'] },
  };
}

export async function resolveImageMagick(env = process.env) {
  const configured = env.BROWSER_AGENT_MAGICK;
  const candidates = configured ? [configured] : ['magick', 'convert'];
  for (const command of candidates) {
    const version = await probeVersion(command, env);
    if (version) return imageMagickRuntimeFor(command, version);
  }
  throw new Error(`ImageMagick is missing; checked: ${candidates.join(', ')}`);
}
