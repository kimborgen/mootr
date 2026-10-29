#!/usr/bin/env node
// S-3782 6b: the settings ask's pure parts of src/permissions.ts, src/settings.ts and src/textdiff.ts run on the cases of
// settings_ask_test.go. Argv: the case list as JSON, each {diff: [a, b]}, {touched: [current, patch]},
// {restore: [text, current]} or {notes: [current, next]}. Prints the results as a JSON list: a diff's text, the
// touched text, a restore's {value} or {error}, and the notes.
const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
process.env.STAM_HOME = tempHome('stam-ask-ref-');
process.env.STAM_TMUX_SOCKET = `ask-ref-${process.pid}`;
process.env.STAM_EMBEDDER = 'stub';
process.env.STAM_MACHINE = 'test';
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT', 'OPENROUTER_API_KEY']) delete process.env[k];

const { unifiedDiff } = await import(new URL('src/textdiff.ts', root));
const { patchTouchedText } = await import(new URL('src/settings.ts', root));
const permissions = await import(new URL('src/permissions.ts', root));
const out = [];
for (const c of JSON.parse(process.argv[2])) {
  if (c.diff) out.push(unifiedDiff(c.diff[0], c.diff[1], 'settings now', 'settings if approved'));
  else if (c.touched) out.push(patchTouchedText(c.touched[0], c.touched[1]));
  else if (c.notes) out.push(permissions.keyDestinationNotes(c.notes[0], c.notes[1]));
  else {
    try {
      out.push({ value: permissions.unredactedChange({ kind: 'post', text: c.restore[0] }, c.restore[1]) });
    } catch (e) {
      out.push({ error: e.message });
    }
  }
}
process.stdout.write(JSON.stringify(out));
process.exit(0);
