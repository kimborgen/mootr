// The TS side of retro_test.go: runs src/retro.ts runRetro over scripted daemons, and src/feedback-screen.ts
// redactScreen and boundedScreen over lines, and prints what each says, so the Go port is compared with it.
//
// stdin: {"scenarios":[{"by","args","routes":{"METHOD /path": reply | {"$status": N, "$error": "text"}}}],
//         "redact":["line", ...], "bounded":[["line", ...], ...]}
// stdout: {"scenarios":[{"out"|"err", "calls":[{"method","path","body"}]}], "redact":[...], "bounded":[{"text","truncated"}]}
import { resolve } from 'node:path';

const root = resolve(new URL('../../../../', import.meta.url).pathname);
const { runRetro } = await import(`${root}/src/retro.ts`);
const { redactScreen, boundedScreen } = await import(`${root}/src/feedback-screen.ts`);

let input = '';
for await (const chunk of process.stdin) input += chunk;
const req = JSON.parse(input);

const scenarios = [];
for (const sc of req.scenarios ?? []) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body: body === undefined ? null : body });
    const key = `${method} ${path}`;
    if (!(key in sc.routes)) throw Object.assign(new Error(`no route ${key}`), { status: 404 });
    const r = sc.routes[key];
    if (r && typeof r === 'object' && '$status' in r) throw Object.assign(new Error(r.$error), { status: r.$status });
    return structuredClone(r);
  };
  try {
    scenarios.push({ out: await runRetro(api, sc.by, sc.args), calls });
  } catch (e) {
    scenarios.push({ err: e instanceof Error ? e.message : String(e), calls });
  }
}
process.stdout.write(
  JSON.stringify({
    scenarios,
    redact: (req.redact ?? []).map((l) => redactScreen(l)),
    bounded: (req.bounded ?? []).map((ls) => boundedScreen(ls)),
  }),
);
