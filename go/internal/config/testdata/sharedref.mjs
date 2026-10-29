#!/usr/bin/env node
// S-3782 6c: the shared-settings parts of src/settings.ts, src/permissions.ts and src/settings-sync.ts run on the cases
// of settings_shared_test.go. Argv: the case list as JSON, each {parts: value}, {split: [patch, fill, cache]} (cache
// null for none), {withLocal: [text, local]}, {unredact: [patch, current]} or {payload: {settings, registry,
// instructions, templates}} (file texts; null leaves a file out). Prints the results as a JSON list: [localPart,
// sharedPart], {local, shared}, the text, {value} or {error}, and the payload.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
const home = tempHome('stam-shared-ref-');
process.env.STAM_HOME = home;
process.env.STAM_TMUX_SOCKET = `shared-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];

const s = await import(new URL('src/settings.ts', root));
const permissions = await import(new URL('src/permissions.ts', root));
const sync = await import(new URL('src/settings-sync.ts', root));
const put = (name, text) => (text === null ? rmSync(join(home, name), { force: true, recursive: true }) : writeFileSync(join(home, name), text));
const out = [];
for (const c of JSON.parse(process.argv[2])) {
  if (c.parts !== undefined) out.push([s.localPart(c.parts), s.sharedPart(c.parts)]);
  else if (c.split) {
    // The split reads the cache; settings.json names another home, so this daemon isn't the home.
    put('settings.json', JSON.stringify({ home: 'elsewhere' }));
    if (c.split[2] === null) put('settings.shared.json', null);
    else s.writeSharedCache(JSON.stringify({ rev: 'r', settings: c.split[2] }));
    s.settingsChanged();
    out.push(s.splitSettingsPatch(c.split[0], c.split[1]));
  } else if (c.withLocal) out.push(s.withLocalKeys(c.withLocal[0], c.withLocal[1]));
  else if (c.unredact) {
    try {
      out.push({ value: permissions.unredactedChange({ kind: 'patch', patch: c.unredact[0], fill: false }, c.unredact[1]) });
    } catch (e) {
      out.push({ error: e.message });
    }
  } else {
    const p = c.payload;
    put('settings.shared.json', null);
    put('settings.json', p.settings ?? '');
    put('registry.json', p.registry);
    put('instructions.md', p.instructions);
    put('templates', null);
    if (p.templates) {
      mkdirSync(join(home, 'templates'));
      for (const [name, text] of Object.entries(p.templates)) writeFileSync(join(home, 'templates', name), text);
    }
    s.settingsChanged();
    out.push(sync.sharedPayload());
  }
}
process.stdout.write(JSON.stringify(out));
