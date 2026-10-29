#!/usr/bin/env node
// S-3782 6h: src/llm/index.ts on the cases of the Go parity tests. Stdin: {home, env, refs, requests}; STAM_HOME is home
// (its settings.json and registry.json are the test's), and env is set over a scrubbed environment.
// With signs, [{method, url, headers, body, service, region, credentials, now}], src/llm/sigv4.ts signs each instead.
// Prints {parsed: [parseModelRef of each ref], hasKey: [hasKey of each ref], results: [complete of each request]}, a
// request's result as {text, model, usage, costUsd, priced} or, for a call that throws, {error, status, retryAfterMs}.
// Only the Go test's loopback stub is reached.
const input = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8'));
for (const k of Object.keys(process.env)) if (/^(STAM|MOOTR|AWS)_|_API_KEY$|_KEY$/.test(k)) delete process.env[k];
process.env.STAM_HOME = input.home;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
Object.assign(process.env, input.env);
console.log = console.warn = console.error = () => {};

if (input.signs) {
  const { sign } = await import(new URL('../../../../src/llm/sigv4.ts', import.meta.url));
  process.stdout.write(JSON.stringify(input.signs.map((o) => sign({ ...o, now: new Date(o.now) }))));
  process.exit(0);
}
const llm = await import(new URL('../../../../src/llm/index.ts', import.meta.url));
const results = [];
for (const req of input.requests) {
  try {
    const r = await llm.complete(req);
    results.push({ text: r.text, model: r.model, usage: r.usage, costUsd: r.costUsd ?? null, priced: r.priced ?? null });
  } catch (e) {
    results.push({ error: e instanceof Error ? e.message : String(e), status: e?.status ?? null, retryAfterMs: e?.retryAfterMs ?? null });
  }
}
process.stdout.write(JSON.stringify({ parsed: input.refs.map((r) => llm.parseModelRef(r)), hasKey: input.refs.map((r) => llm.hasKey(r)), results }));
process.exit(0);
