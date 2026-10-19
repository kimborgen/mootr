// Permission rules stam writes into every Claude Code agent's generated settings (S-570).
// Only read-only commands are allowed: an allow rule skips auto mode's classifier, whose
// false denials stalled agents on read-only `cat`, `sed -n`, `grep` and `git status`.
// The deny rules keep `cat` and `grep` away from stam's secrets; Bash patterns match
// command text, not resolved paths, so they are best effort. The Read rules deny the token
// files by resolved path too (S-743): the peer token must not be readable from an agent's tty,
// and Bash's text match alone lets a variable or a tilde path slip past.
// Never added: `rm` (the built-in path check outranks an allow rule anyway), `sed -i`, `find`,
// heredoc interpreters, push/fetch/gh, test runners, kill, tmux, ssh, sudo, docker.
import { realpathSync } from 'node:fs';
import { DEFAULT_STAM_HOME, STAM_HOME } from '../config.ts';

const GIT_READ = ['status', 'diff', 'log', 'show', 'rev-parse', 'merge-base', 'ls-files'];
const READ_CMDS = ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'sed -n'];

export function allowRules(): string[] {
  // `//` makes a Read path absolute. Images only: a worktree can hold a `.env`.
  const worktrees = `/${DEFAULT_STAM_HOME}/worktrees`;
  return [
    ...GIT_READ.map((c) => `Bash(git ${c}:*)`),
    'Bash(git remote -v)',
    'Bash(git branch --show-current)',
    'Bash(git branch -a)',
    'Bash(git branch --list:*)',
    ...READ_CMDS.map((c) => `Bash(${c}:*)`),
    `Read(${worktrees}/**/*.png)`,
    `Read(//tmp/claude-${process.getuid?.() ?? 1000}/**/*.png)`,
  ];
}

// The homes whose secrets are denied: the daemon's own STAM_HOME as given and resolved (a
// symlinked home is read through either path), plus the default home (S-903).
export function secretHomes(stamHome: string = STAM_HOME): string[] {
  const homes = [stamHome];
  try {
    homes.push(realpathSync(stamHome));
  } catch {
    // not created yet: the given path is all there is
  }
  homes.push(DEFAULT_STAM_HOME);
  return [...new Set(homes)];
}

export function denyRules(stamHome: string = STAM_HOME): string[] {
  // `//` makes a Read path absolute, as in the allow rules: the home is outside the working directories.
  const reads = secretHomes(stamHome).flatMap((h) => [
    `Read(/${h}/token)`,
    `Read(/${h}/peer-token)`,
    `Read(/${h}/settings.json)`,
    `Read(/${h}/settings.shared.json)`,
    `Read(/${h}/settings.json.*)`,
    // The OpenRouter and ElevenLabs keys and the MCP OAuth tokens (S-1888).
    `Read(/${h}/opencode.env)`,
    `Read(/${h}/voice.env)`,
    `Read(/${h}/mcp-auth.json)`,
  ]);
  return [
    'Bash(*stam/stam.db*)',
    'Bash(*stam/token*)',
    'Bash(*stam/peer-token*)',
    'Bash(*stam/settings.json*)',
    'Bash(*stam/settings.shared.json*)',
    'Bash(*stam/registry.json*)',
    'Bash(*stam/opencode.env*)',
    'Bash(*stam/voice.env*)',
    'Bash(*stam/mcp-auth.json*)',
    'Bash(cat *.env)',
    'Bash(*/.ssh/*)',
    // The Read tool too, not only Bash (S-743), so the peer token and the settings holding it
    // (and their backups) are refused by resolved path.
    ...reads,
  ];
}
