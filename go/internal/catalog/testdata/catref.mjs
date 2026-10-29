#!/usr/bin/env node
// S-3782 6f: src/tiny-models.ts, src/model-catalog.ts, src/llm/openrouter.ts listModels, src/onboarding.ts and
// src/settings.ts permissionModesOf run on the cases of the Go parity tests. Stdin: {op, ...}:
//   {op: 'tiny', texts}: each settings.json text written, then [tinyModels(), settings().permissionModes].
//   {op: 'harness', registry, harnesses}: registry.json written, then harnessModels(h) for each h.
//   {op: 'openrouter', base, calls}: listModels() against the Go test's loopback fake, `calls` times.
//   {op: 'onboarding', inputs}: onboardingStatus(input) for each.
// Prints the results as JSON, with {error} for a call that throws. No network is reached but the loopback fake.
const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const { readFileSync, writeFileSync } = await import('node:fs');
const { join } = await import('node:path');
const home = tempHome('stam-cat-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `cat-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'MOOTR_OPENROUTER_URL', 'STAM_OPENROUTER_URL']) delete process.env[k];
console.log = console.warn = () => {};

const input = JSON.parse(readFileSync(0, 'utf8'));
const settle = async (fn) => {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
let out = [];
if (input.op === 'tiny') {
  const s = await import(new URL('src/settings.ts', root));
  const { tinyModels } = await import(new URL('src/tiny-models.ts', root));
  for (const t of input.texts) {
    s.writeSettingsText(t);
    out.push([tinyModels(), s.settings().permissionModes]);
  }
} else if (input.op === 'harness') {
  writeFileSync(join(home, 'registry.json'), JSON.stringify(input.registry));
  const { harnessModels } = await import(new URL('src/model-catalog.ts', root));
  for (const h of input.harnesses) out.push(await settle(() => harnessModels(h)));
} else if (input.op === 'openrouter') {
  process.env.STAM_OPENROUTER_URL = input.base;
  const { openrouter } = await import(new URL('src/llm/openrouter.ts', root));
  for (let i = 0; i < input.calls; i++) out.push(await settle(() => openrouter.listModels()));
} else if (input.op === 'onboarding') {
  const { onboardingStatus } = await import(new URL('src/onboarding.ts', root));
  for (const i of input.inputs) out.push(onboardingStatus(i));
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
