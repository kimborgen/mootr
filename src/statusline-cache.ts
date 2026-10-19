// The user's own status line runs for every agent on every refresh, and it can be `npx`, so
// about four copies ran at once with ~18 agents (S-171). This keeps its output per agent for
// 30 seconds: the file holds the time the command ran, then its output, and a refresh inside
// that time prints the saved output instead of running the command again. bin/stam-fast does
// the same in the shell, so the two paths print the same bytes.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUSLINE_TTL_MS = 30_000;
// An agent nobody is viewing (no tmux client, no web terminal, no open view) never refreshes its
// saved output: its model, context and branch don't change while it's idle, so the last output
// stays accurate. It runs again once someone views it (S-274, S-1055). A missing file still runs
// once, so the pane isn't blank.
export const STATUSLINE_IDLE_TTL_MS = Number.POSITIVE_INFINITY;

// The cache time for an agent: the daemon says whether anyone views it. Unknown (the daemon
// didn't answer) keeps the 30 s time.
export function statuslineTtl(viewed: boolean | undefined): number {
  return viewed === false ? STATUSLINE_IDLE_TTL_MS : STATUSLINE_TTL_MS;
}

// The saved output of `run` for `file`, running `run` again only when the file is missing,
// unreadable, or older than ttlMs. A write that fails still returns the fresh output.
export function throttled(file: string, run: () => string, now = Date.now(), ttlMs = STATUSLINE_TTL_MS): string {
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      const nl = text.indexOf('\n');
      const at = Number(nl < 0 ? NaN : text.slice(0, nl));
      if (Number.isFinite(at) && now - at >= 0 && now - at < ttlMs) return text.slice(nl + 1);
    }
  } catch {}
  const out = run();
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Written beside the file and renamed, so a refresh never reads half of it.
    writeFileSync(`${file}.tmp`, `${now}\n${out}`);
    renameSync(`${file}.tmp`, file);
  } catch {}
  return out;
}
