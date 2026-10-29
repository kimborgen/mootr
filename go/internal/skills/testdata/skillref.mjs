#!/usr/bin/env node
// S-3782 6g: src/instructions.ts (parseSkill, skillInfos, relinkSkills) and src/skill-import.ts run on the cases of the
// Go parity tests. Stdin: {home, userHome, agents, op, ...}; HOME is userHome, STAM_HOME home, STAM_AGENTS_SKILLS agents.
//   {op: 'source', cases: [{input, allowFile}]}: parseSource of each.
//   {op: 'parse', texts}: parseSkill of each.
//   {op: 'stats', answers}: statsFromApi of each.
//   {op: 'steps', steps}: each step in turn, with file:// sources allowed:
//     {fn: 'import', source} | {fn: 'update', name} | {fn: 'check', name} | {fn: 'recover'} | {fn: 'relink'} | {fn: 'infos'}
// Prints the results as JSON, with {error} for a call that throws. Only the Go test's local repositories are reached.
const input = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8'));
process.env.HOME = input.userHome;
process.env.STAM_HOME = input.home;
process.env.STAM_AGENTS_SKILLS = input.agents;
process.env.STAM_TMUX_SOCKET = `skill-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'MOOTR_AGENTS_SKILLS', 'MOOTR_HOME']) delete process.env[k];
console.log = console.warn = () => {};

const root = new URL('../../../../', import.meta.url);
const ins = await import(new URL('src/instructions.ts', root));
const imp = await import(new URL('src/skill-import.ts', root));
const settle = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), refused: e instanceof imp.ImportError };
  }
};
const info = ({ body, ...rest }) => ({ ...rest, body });
const out = [];
if (input.op === 'source') {
  for (const c of input.cases) out.push(await settle(() => imp.parseSource(c.input, { allowFile: c.allowFile })));
} else if (input.op === 'parse') {
  for (const t of input.texts) out.push(ins.parseSkill(t));
} else if (input.op === 'stats') {
  for (const a of input.answers) out.push(await settle(() => imp.statsFromApi(a)));
} else if (input.op === 'steps') {
  const opts = { allowFile: true };
  for (const s of input.steps) {
    if (s.fn === 'import') out.push(await settle(() => imp.importSkill(s.source, opts)));
    else if (s.fn === 'update') out.push(await settle(() => imp.updateSkill(s.name, opts)));
    else if (s.fn === 'check') out.push(await settle(() => imp.checkUpdate(s.name, opts)));
    else if (s.fn === 'recover') out.push((imp.recoverImports(), null));
    else if (s.fn === 'relink') out.push((ins.relinkSkills(), null));
    else if (s.fn === 'infos') out.push(ins.skillInfos().map(info));
  }
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
