// A web terminal viewer for test/e2e-term-size.sh: opens an agent's terminal WebSocket at
// the given size, as web/src/term/TermSession.ts does, and stays open until killed.
// Usage: node test/term-web.mjs AGENT_ID COLS ROWS   (STAM_HOME, STAM_PORT from test/lib.sh)
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';
const [id, cols, rows] = process.argv.slice(2);
const home = process.env.STAM_HOME;
const token = readFileSync(home + '/token', 'utf8').trim();
const ws = new WebSocket(`ws://127.0.0.1:${process.env.STAM_PORT}/api/agents/${id}/tty?token=${token}&cols=${cols}&rows=${rows}`);
ws.on('message', () => {});
ws.on('open', () => console.log('open'));
ws.on('close', () => process.exit(0));
ws.on('error', (e) => { console.log('error', e.message); process.exit(1); });
