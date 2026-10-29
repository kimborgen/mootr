#!/usr/bin/env node
// S-3782 6e: src/secrets.ts run on the cases of secretstore_test.go. Argv: {opencodeEnv, ops, names}, where opencodeEnv
// is written to the home's opencode.env first, each op is {list: true}, {set: [name, body]}, {remove: name} or
// {test: [name, ok, detail]} on one home in order, and names are {mcp: server}, {env: variable} or {scrub: [text,
// value]}. Prints {ops, names, file}: each op's result ({error} when it throws), the names, and secrets.json at the end.
// Times are blanked, so the output is stable.
const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const { writeFileSync, readFileSync } = await import('node:fs');
const { join } = await import('node:path');
const home = tempHome('stam-secrets-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `secrets-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
console.log = console.warn = () => {};

const input = JSON.parse(process.argv[2]);
if (input.opencodeEnv) writeFileSync(join(home, 'opencode.env'), input.opencodeEnv, { mode: 0o600 });
const secrets = await import(new URL('src/secrets.ts', root));
const blank = (info) => ({ ...info, setAt: '', ...(info.test ? { test: { ...info.test, at: '' } } : {}) });
const ops = [];
for (const op of input.ops) {
  try {
    if (op.list) ops.push(secrets.list().map(blank));
    else if (op.set) ops.push(blank(secrets.set(op.set[0], op.set[1])));
    else if (op.remove) ops.push(secrets.remove(op.remove));
    else if (op.test) ops.push((secrets.recordTest(op.test[0], { ok: op.test[1], detail: op.test[2] }), null));
  } catch (e) {
    ops.push({ error: e.message });
  }
}
const names = input.names.map((n) => (n.mcp !== undefined ? secrets.mcpClientSecretName(n.mcp) ?? null : n.env !== undefined ? secrets.nameForEnv(n.env) : secrets.scrub(n.scrub[0], n.scrub[1])));
let file = '';
try {
  file = readFileSync(join(home, 'secrets.json'), 'utf8').replace(/"(setAt|at)": "[^"]*"/g, '"$1": ""');
} catch {}
process.stdout.write(JSON.stringify({ ops, names, file }));
