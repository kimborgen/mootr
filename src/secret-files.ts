// The files under STAM_HOME that hold credentials. Every agent harness denies them (S-1888): Claude
// Code through its settings, OpenCode through its session permissions, Codex through its sandbox
// profile. This is the one list: a new secret file is added here and every adapter picks it up.
import { realpathSync } from 'node:fs';
import { DEFAULT_HOMES, STAM_HOME } from './config.ts';

// Names under a home. A `*` is a glob in each harness's rule syntax (S-2114's secrets.json.* covers its
// in-flight temp files too).
export const SECRET_FILES = [
  'token',
  'peer-token',
  // The MCP lease token (S-3176) and its rotation's temp files.
  'mcp-lease-token',
  'mcp-lease-token.*',
  'settings.json',
  'settings.shared.json',
  'settings.json.*',
  // The OpenRouter and ElevenLabs keys and the MCP OAuth tokens (S-1888).
  'opencode.env',
  'voice.env',
  'mcp-auth.json',
  // The secret store (S-2114) and its in-flight temp files.
  'secrets.json',
  'secrets.json.*',
];

// The homes whose secrets are denied: the daemon's own STAM_HOME as given and resolved (a
// symlinked home is read through either path), plus both spellings of the default home (S-903, S-3347).
export function secretHomes(stamHome: string = STAM_HOME): string[] {
  const homes = [stamHome];
  try {
    homes.push(realpathSync(stamHome));
  } catch {
    // not created yet: the given path is all there is
  }
  homes.push(...DEFAULT_HOMES);
  return [...new Set(homes)];
}

// Absolute paths of every secret file under every such home.
export function secretPaths(stamHome: string = STAM_HOME): string[] {
  return secretHomes(stamHome).flatMap((h) => SECRET_FILES.map((f) => `${h}/${f}`));
}

// Command-text patterns for a shell tool (a Bash command). Best effort: a command can name a secret
// file in a form these don't match, so the path rules above are the real gate.
export function secretCommandPatterns(): string[] {
  return SECRET_FILES.flatMap((f) => [`*stam/${f}*`, `*mootr/${f}*`]);
}
