// A test helper: drive `stam mcp` for one tool call over stdio and print the response
// line. Closing stdin right after writing would let the process exit before an async tool
// finishes, so this waits for the response first, then stops the child.
//   STAM_BIN=<bin/stam> STAM_AGENT_ID=<id> node test/mcp-call.mjs '<json-rpc request>'
import { spawn } from 'node:child_process';

const request = process.argv[2];
if (!request) {
  console.error('usage: mcp-call.mjs <json>');
  process.exit(2);
}
const child = spawn(process.env.STAM_BIN, ['mcp'], { env: process.env });
let buf = '';
let done = false;
child.stdout.on('data', (d) => {
  buf += d;
  const i = buf.indexOf('\n');
  if (i >= 0 && !done) {
    done = true;
    child.kill();
    process.stdout.write(buf.slice(0, i), () => process.exit(0));
  }
});
const fail = () => {
  if (!done) {
    done = true;
    console.error('mcp-call: no response');
    process.exit(1);
  }
};
child.on('error', fail);
child.on('exit', fail);
setTimeout(fail, 15000);
child.stdin.write(request + '\n');
