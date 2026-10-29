#!/usr/bin/env node
// S-3782 6a: src/settings.ts run on the cases of settings_patch_test.go, over a throwaway home with the test's registry.
// Argv: the case list as JSON, the registry. Each case is {patch: {current, patch, fill}}, {redact: text} or
// {file: text}; prints the results as a JSON list: a patch's {text} or {problem, field}, a redaction's text, and a
// whole file's {problem, field} or null.
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-patch-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `patch-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];
const [casesJSON, registryJSON] = process.argv.slice(2);
writeFileSync(join(home, 'registry.json'), registryJSON);

const settings = await import(new URL('src/settings.ts', root));
const out = [];
for (const c of JSON.parse(casesJSON)) {
  if (c.patch) out.push(settings.patchedSettingsText(c.patch.current, c.patch.patch, c.patch.fill));
  else if (c.redact !== undefined) out.push(settings.redactSettingsText(c.redact));
  else out.push(settings.fileProblem(JSON.parse(c.file)));
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
