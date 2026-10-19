#!/usr/bin/env node
// A test helper: drive `stam mcp-proxy NAME` over stdio for a sequence of JSON-RPC
// messages and print every response line it writes, one per line, to stdout. Exits 1 if it
// doesn't get one response per request that carries an `id` (notifications get none).
//   STAM_BIN=<bin/stam> STAM_AGENT_ID=<id> STAM_URL=... STAM_TOKEN=... \
//     node test/mcp-proxy-call.mjs NAME '<json>' ['<json>' ...]
import { spawn } from 'node:child_process';

const [name, ...requests] = process.argv.slice(2);
if (!name) {
  console.error('usage: mcp-proxy-call.mjs NAME <json>...');
  process.exit(2);
}
const expected = requests.filter((r) => JSON.parse(r).id !== undefined).length;
const child = spawn(process.env.STAM_BIN, ['mcp-proxy', name], { env: process.env });
let buf = '';
const lines = [];
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) lines.push(line);
  }
});
const finish = (code) => {
  child.kill();
  process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''), () => process.exit(code));
};
const tick = setInterval(() => {
  if (lines.length >= expected) {
    clearInterval(tick);
    finish(0);
  }
}, 50);
setTimeout(() => {
  clearInterval(tick);
  finish(lines.length >= expected ? 0 : 1);
}, 15000);
child.on('error', () => finish(1));
for (const r of requests) child.stdin.write(r + '\n');
