// The one LIGHT rule (S-3660): a `node --test` file that matches this starts a daemon, tmux, browser or server, so it
// stays out of test/run.sh's LIGHT list. light-check.mjs (the CLI) and light-list.test.mjs both call it, so they agree.
// It reads only the file's own text: a spawn inside src or in an imported helper isn't seen.

// A tmux start is a new-session, a server start, a newSession/newShell call, a tmux-socket import (a lifecycle launch's
// killTmuxServer), or a literal 'tmux' command; a pure src/tmux.ts export (sessionCommand) is allowed (S-3414). The bare
// STAM_TMUX_SOCKET env name isn't a start: many tests only set it to isolate a socket, so it stays out.
// Wall-clock asserts and event-loop delay bounds flake beside heavy runs, so they stay out of LIGHT too.
const heavy = new RegExp([
  'new-session|start-server|newSession\\(|newShell\\(|tmux-socket|[\'"]tmux[\'"]',
  'chromium|playwright|createServer|\\.listen\\(|[^a-zA-Z]spawn\\(|flock|systemctl|fake-codex|daemon run',
  'stam-fast|decide-stub|spawnProcess\\(|execFile\\(|\\bfork\\(|new Worker|monitorEventLoopDelay',
  'assert[\\w.]*\\([^\\n]*(performance\\.now|Date\\.now\\(\\) -)',
  // The shell-era patterns (the e2e-test-slot check's old grep), kept so both checks stay one rule.
  'lib\\.sh|createServer\\(|\\.listen\\(|[\'"`]tmux\\b|[\'"/]playwright|[\'"/]chromium|chromium\\.',
  '(tsx|execPath)[^;]*cli\\.ts|[\'"/]stam-fast|fork\\(|dist/(cli|daemon)|bin/stam[\'"]|[\'"]serve[\'"]',
  '-e[\'"], DAEMON|spawn\\(process\\.execPath, \\[[^\\]]*scripts/[^\\]]*\\.mjs',
].join('|'));

// A comment line is skipped: a name that appears only in a comment doesn't start anything.
const comment = /^\s*(\/\/|\*|#)/;

// The matched token in a test file's source, or null when the file passes LIGHT.
export function lightHit(source) {
  const body = source.split('\n').filter((line) => !comment.test(line)).join('\n');
  const match = body.match(heavy);
  return match ? match[0] : null;
}

// The failure line both checks print for a hit, so the developer sees the token without a rerun.
export function lightMessage(name, file, token) {
  return `${name} (${file}) matched "${token}": LIGHT excludes daemon/browser tests`;
}
