import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as db from './db.ts';
import { STAM_HOME } from './config.ts';

// Each agent's own daemon token (S-237). A launch mints a new one: 24 random bytes, base64url.
// Only its sha256 is stored, and the plain token goes into the agent's environment as
// STAM_TOKEN. A new launch replaces the hash, so the token from the previous launch stops working.
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function mintAgentToken(agentId: string): string {
  const token = randomBytes(24).toString('base64url');
  db.setTokenHash(agentId, hashToken(token));
  return token;
}

// The OpenCode server's token (S-240). One shared server runs every OpenCode agent's `stam mcp`,
// which names its agent with `self`, so the server gets a token of its own: minted when the server
// starts, passed in its environment as STAM_TOKEN. The daemon keeps only its sha256, in
// STAM_HOME/opencode-token (mode 0600). No file means a server from before this one, which keeps
// the shared token until it restarts.
const SERVER_TOKEN_FILE = join(STAM_HOME, 'opencode-token');

export function mintServerToken(): string {
  const token = randomBytes(24).toString('base64url');
  writeFileSync(SERVER_TOKEN_FILE, hashToken(token), { mode: 0o600 });
  chmodSync(SERVER_TOKEN_FILE, 0o600);
  return token;
}

export function serverTokenHash(): string | undefined {
  try {
    return readFileSync(SERVER_TOKEN_FILE, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}
