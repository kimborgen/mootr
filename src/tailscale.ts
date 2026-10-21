// Whether this machine has a tailscale binary on PATH (S-2121). Tailscale is optional: with none, the daemon
// skips its tailscale calls (the bind address, serve discovery, the owner and agent-IP lookups) instead of
// spawning one that fails on every boot and retry. The answer is kept a minute, so an install shows up
// without a restart and a hot path stats nothing.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

let cached: { path: string; at: number; has: boolean } | undefined;

export function hasTailscale(path = process.env.PATH ?? '', now = Date.now()): boolean {
  if (cached?.path === path && now - cached.at < 60_000) return cached.has;
  const has = path.split(delimiter).some((dir) => {
    if (!dir) return false;
    try {
      accessSync(join(dir, 'tailscale'), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  cached = { path, at: now, has };
  return has;
}
