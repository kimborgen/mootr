// Prints src/agent-routes.ts matchActing and opencodeNamesAgent for each "METHOD PATH" on stdin (a JSON list), for
// go/internal/server's agent routes test (S-2881).
import { readFileSync } from 'node:fs';
import { matchActing, opencodeNamesAgent } from '../../../../src/agent-routes.ts';

const inputs = JSON.parse(readFileSync(0, 'utf8'));
const out = inputs.map((s) => {
  const [method, path] = s.split(' ');
  const hit = matchActing(method, path);
  return { in: s, acting: hit ? hit[1] : null, named: opencodeNamesAgent(method, path) };
});
process.stdout.write(JSON.stringify(out));
