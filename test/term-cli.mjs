// A real-terminal `stam attach` for test/e2e-term-size.sh: runs the CLI in a PTY of the
// given size, as a human's terminal would, and forwards this process's stdin to it, so a
// test types a key by writing to a FIFO. Ends when the attach does, or when killed.
// Usage: node test/term-cli.mjs AGENT_ID COLS ROWS STAM_BIN   (STAM_* from test/lib.sh)
import pty from 'node-pty';
const [id, cols, rows, bin] = process.argv.slice(2);
const term = pty.spawn(bin, ['attach', id], {
  name: 'xterm-256color',
  cols: Number(cols),
  rows: Number(rows),
  env: process.env,
});
term.onData(() => {});
term.onExit(({ exitCode }) => process.exit(exitCode));
process.stdin.on('data', (d) => term.write(d.toString()));
process.stdin.on('end', () => term.kill());
process.on('SIGTERM', () => term.kill());
