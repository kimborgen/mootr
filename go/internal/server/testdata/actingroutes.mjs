// Prints a request for every `acting` route in src/agent-routes.ts AGENT_ROUTES, as [{method, path}] with the path after
// the agent id: each alternation is expanded and each id group is `t1`. go/internal/server's acting gate test sends each
// to another agent's path (S-4237).
import { AGENT_ROUTES } from '../../../../src/agent-routes.ts';

const expand = (src) => {
  const m = src.match(/\(([^()]*)\)/);
  if (!m) return [src];
  const alts = m[1] === String.raw`[\w-]+` ? ['t1'] : m[1].split('|');
  return alts.flatMap((a) => expand(src.slice(0, m.index) + a + src.slice(m.index + m[0].length)));
};

const out = [];
for (const r of AGENT_ROUTES.filter((r) => r.auth === 'acting')) {
  for (const p of expand(r.path)) {
    const path = p.replaceAll('\\/', '/');
    if (!new RegExp(String.raw`^\/api\/agents\/([\w-]+)${r.path}$`).test('/api/agents/x' + path)) throw new Error(`${r.method} ${r.path}: ${path} doesn't match`);
    out.push({ method: r.method, path });
  }
}
process.stdout.write(JSON.stringify(out));
