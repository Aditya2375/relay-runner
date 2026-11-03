import { lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';

// Model-selected files must never expose credentials or runner/repository state.
export function protectedName(name) {
  return ['.git', '.relay', 'node_modules'].includes(name) ||
    /^\.env(?:\.|$)/i.test(name) ||
    /(?:^|[._-])(?:credentials|service-account|id_rsa|id_ed25519)(?:[._-]|$)/i.test(name) ||
    /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name);
}

export function guardedPath(root, p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    throw new Error(`Unsafe edit path: ${p}`);
  }
  const base = realpathSync(resolve(root));
  const target = resolve(base, p);
  if (target === base || !target.startsWith(base + sep)) throw new Error(`path escapes workspace: ${p}`);
  const parts = relative(base, target).split(sep);
  if (parts.some(protectedName)) throw new Error(`path targets a protected file or directory: ${p}`);
  let cursor = base;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Refusing a symlink path: ${p}`);
    } catch (err) {
      if (err.code === 'ENOENT') break;
      throw err;
    }
  }
  return target;
}
