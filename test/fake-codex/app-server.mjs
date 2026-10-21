// The fake `codex app-server` (test/fake-codex/codex) for UI checks, on server.mjs:
//   app-server --listen unix://SOCK [-c key=value]...   a thread per agent, its history from
//     STAM_FAKE_CODEX_THREAD (a JSON file of turns, as thread/read returns them) when set;
//     a prompt (turn/start) gets the user message and the reply "ok" as one finished turn.
//   app-server --listen stdio:// -c hooks.EVENT=...      answers stam's hook probe
//     (initialize, hooks/list) with one hook per -c hooks.EVENT, hashed by its text.
// No model; nothing is spent.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { startFakeCodex } from './server.mjs';

const args = process.argv.slice(2);
const listen = args[args.indexOf('--listen') + 1] ?? '';
const overrides = args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));

if (listen === 'stdio://') {
  // The hook probe: one hook per `-c hooks.EVENT=[{hooks=[{type,command}]}]`.
  const hooks = overrides.filter((o) => o.startsWith('hooks.') && !o.startsWith('hooks.state')).map((o) => {
    const [k, v] = [o.slice(6, o.indexOf('=')), o.slice(o.indexOf('=') + 1)];
    const command = /"command"=("(?:[^"\\]|\\.)*")/.exec(v)?.[1];
    return { key: k, command: command ? JSON.parse(command) : '', currentHash: createHash('sha256').update(o).digest('hex').slice(0, 16) };
  });
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'fake-codex' } });
    else if (m.method === 'hooks/list') send({ id: m.id, result: { data: [{ hooks }] } });
  });
} else {
  const sock = listen.replace(/^unix:\/\//, '');
  const seeded = () => {
    try { return JSON.parse(readFileSync(process.env.STAM_FAKE_CODEX_THREAD, 'utf8')).turns ?? []; } catch { return []; }
  };
  let thread = null;
  let turns = null;
  let n = 0;
  const fake = await startFakeCodex(sock, {
    responses: {
      'thread/start': () => { thread = `thr-fake-${process.pid}`; turns = seeded(); return { thread: { id: thread } }; },
      'thread/name/set': () => ({}),
      'thread/loaded/list': () => ({ data: thread ? [thread] : [] }),
      'thread/read': (p) => ({ thread: { id: p.threadId, turns: turns ?? seeded() } }),
      // A resumed thread is loaded, as in the real app-server, so a restarted fake finds it.
      'thread/resume': (p) => { thread = p.threadId; return { thread: { id: p.threadId, status: { type: 'idle' } }, model: 'gpt-6.1-sol', approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } }; },
      'turn/start': (p) => {
        const id = `turn-fake-${++n}`;
        const text = (p.input ?? []).map((x) => x.text ?? '').join('');
        const items = [
          { id: `u-fake-${n}`, type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] },
          { id: `m-fake-${n}`, type: 'agentMessage', text: 'ok' },
        ];
        (turns ??= seeded()).push({ id, status: 'completed', startedAt: Date.now(), items });
        setTimeout(() => {
          fake.notify('thread/status/changed', { threadId: p.threadId, status: { type: 'active', activeFlags: [] } });
          fake.notify('turn/started', { threadId: p.threadId, turn: { id, items: [], status: 'inProgress' } });
          for (const item of items) fake.notify('item/completed', { threadId: p.threadId, turnId: id, item });
          fake.notify('turn/completed', { threadId: p.threadId, turn: { id, items: [], status: 'completed' } });
          fake.notify('thread/status/changed', { threadId: p.threadId, status: { type: 'idle' } });
        }, 50);
        return { turn: { id, items: [], status: 'inProgress' } };
      },
    },
  });
}
