// The PreToolUse guard's entrypoint: reads the hook's JSON on stdin and prints its answer.
// It imports only src/guard.ts, so it starts fast (bin/stam runs it for `guard`). Any error
// prints nothing, so the command runs: the guard fails open.
import { guardOutput } from './guard.ts';

async function main() {
  try {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const out = guardOutput(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (out) process.stdout.write(out);
  } catch {}
}

main();
