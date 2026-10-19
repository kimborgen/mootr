// Milestone 3 check: opens an agent's terminal over the web socket, types into it,
// and checks the screen and the echo come back. Usage: node test/web-tty.mjs AGENT_ID [--output-only]
// --output-only skips the echo check, for agents that may have a menu open over their input.
// Talks to the daemon in STAM_HOME and STAM_PORT, as the CLI does (a test daemon from test/lib.sh).
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
const home = process.env.STAM_HOME ?? process.env.HOME + '/.local/share/stam';
const port = process.env.STAM_PORT ?? '7878';
const token = readFileSync(home + '/token', 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/agents/` + process.argv[2] + '/tty?token=' + token + '&cols=120&rows=40');
let out = '';
ws.on('message', (d) => { out += d.toString(); });
ws.on('open', () => {
  setTimeout(() => ws.send('typed-from-web'), 1500);
  setTimeout(() => { const ok = out.length > 500 && (process.argv.includes('--output-only') || out.includes('typed-from-web'));
    console.log(ok ? 'PASS web-tty' : 'FAIL web-tty');
    process.exitCode = ok ? 0 : 1; ws.close(); }, 3500);
});
ws.on('error', (e) => console.log('error', e.message));
