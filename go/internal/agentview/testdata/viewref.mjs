#!/usr/bin/env node
// S-4198: src/adapters/claude-transcript.ts and src/agent-view.ts's pure parts over the cases on stdin, for
// parity_test.go to compare with the Go port byte for byte. Run with HOME and STAM_HOME in a temp folder: agent-view.ts
// imports db.ts. Each case is one of:
//   {kind: 'transcript', file, steps: [{append} | {replace}]}: the file is written step by step (base64, so a step
//     may end mid-character), read after each, and a
//     follower's take printed; prints per step {messages, take, resets, position}.
//   {kind: 'interleave', messages}: prints interleave(messages).
//   {kind: 'turnTools', messages, hi}: prints turnTools(messages, hi).
//   {kind: 'store', steps: [{merge} | {running} | {ask} | {hasOlder}]}: a ViewStore through the steps; prints per step
//     {events: flush(), messages, older}.
//   {kind: 'opencode', messages, events, permissions}: OpenCode's fromOpenCode over the stored messages, permissionOf over
//     the permissions, and applyEvent over the events into one ViewStore; prints {messages, perms, steps: [{r, messages,
//     permissions, running}]}, r being 0 (nothing), 1 (changed) or 2 (resync).
// One JSON.stringify line per case.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const root = new URL('../../../../', import.meta.url);
// The adapters' index first, as the daemon loads them: opencode-view imports opencode, which imports the index.
await import(new URL('src/adapters/index.ts', root));
const { Transcript } = await import(new URL('src/adapters/claude-transcript.ts', root));
const { ViewStore, interleave, turnTools } = await import(new URL('src/agent-view.ts', root));
const { fromOpenCode, permissionOf, applyEvent } = await import(new URL('src/adapters/opencode-view.ts', root));

const cases = JSON.parse(readFileSync(0, 'utf8'));
const out = [];
for (const c of cases) {
  switch (c.kind) {
    case 'transcript': {
      writeFileSync(c.file, '');
      const t = new Transcript(c.file);
      t.watchers = 1;
      const steps = [];
      for (const s of c.steps) {
        if (s.replace !== undefined) writeFileSync(c.file, Buffer.from(s.replace, 'base64'));
        else appendFileSync(c.file, Buffer.from(s.append, 'base64'));
        t.read();
        // Written now: later reads change the messages in place.
        steps.push(JSON.stringify({ messages: t.messages, take: t.take(), resets: t.resets, position: t.position }));
      }
      out.push(`[${steps.join(',')}]`);
      break;
    }
    case 'interleave':
      out.push(JSON.stringify(interleave(c.messages)));
      break;
    case 'turnTools':
      out.push(JSON.stringify(turnTools(c.messages, c.hi)));
      break;
    case 'store': {
      const s = new ViewStore();
      const steps = [];
      for (const st of c.steps) {
        if (st.merge) s.merge(st.merge);
        if (st.running !== undefined) s.setRunning(st.running);
        if (st.ask) s.ask(st.ask);
        if (st.hasOlder !== undefined) s.hasOlder = st.hasOlder;
        steps.push(JSON.stringify({ events: s.flush(), messages: s.messages, older: s.older }));
      }
      out.push(`[${steps.join(',')}]`);
      break;
    }
    case 'opencode': {
      const store = new ViewStore();
      const steps = [];
      for (const ev of c.events ?? []) {
        const r = applyEvent(store, ev);
        // Written now: later events change the messages in place.
        steps.push(JSON.parse(JSON.stringify({ r: r === 'resync' ? 2 : r ? 1 : 0, messages: store.messages, permissions: store.permissions, running: store.running })));
      }
      out.push(JSON.stringify({ messages: (c.messages ?? []).map(fromOpenCode), perms: (c.permissions ?? []).map(permissionOf), steps }));
      break;
    }
    default:
      throw new Error(`no case kind ${c.kind}`);
  }
}
process.stdout.write(out.join('\n') + '\n');
