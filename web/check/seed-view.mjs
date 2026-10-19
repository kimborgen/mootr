// Seeds a conversation for stam's own view of an agent (S-79) into the fake OpenCode server
// (test/fake-opencode): 52 older messages, so the view pages, then a mixed exchange with
// markdown, mail components, thinking, a finished tool call, and a running one that waits
// on a permission. With DB_PATH, two mails to the agent join it (S-203): one from the human
// that the agent read before the test run, and one from FROM_ID still unread, written to the
// daemon's DB as already pushed, so the fake is never prompted with them; and one the agent
// sent the human with the counts, which the human has read (S-255). A test daemon only
// (web/check/daemon.sh with OWN_VIEW=1).
//   node seed-view.mjs OPENCODE_PORT SESSION_ID [DB_PATH AGENT_ID FROM_ID]
import { DatabaseSync } from 'node:sqlite';
const [port, session, dbPath, agent, fromId] = process.argv.slice(2);
const F = '```';
// An hour ago, a minute apart, so what the check sends comes after them.
const t0 = Date.now() - 3_600_000;
let n = 0;
const at = () => t0 + n++ * 60_000;
const next = () => `msg_seed${String(n).padStart(4, '0')}`;
const user = (text) => { const id = next(); return { id, type: 'user', text, time: { created: at() } }; };
const done = (content) => { const id = next(), created = at(); return { id, type: 'assistant', content, time: { created, completed: created + 1000 } }; };
const messages = [];
for (let i = 1; i <= 26; i++) messages.push(user(`Earlier step ${i}: check part ${i}.`), done([{ type: 'text', text: `Part ${i} checks out.` }]));
messages.push(
  user('Run the test suite and summarise it for me.'),
  done([
    { type: 'reasoning', text: 'The suite lives in test/. Run it once, then read the counts and the one skip.' },
    { type: 'tool', id: 'call_test', name: 'shell', state: { status: 'completed', input: { command: 'npm test', description: 'Run the test suite' }, content: [{ type: 'text', text: '212 passed\n1 skipped (needs a GPU)\n0 failed' }] } },
    { type: 'tool', id: 'call_git', name: 'shell', state: { status: 'completed', input: { command: 'git status --short' }, content: [{ type: 'text', text: '' }] } },
    { type: 'tool', id: 'call_build', name: 'shell', state: { status: 'completed', input: { command: 'npm run build' }, content: [{ type: 'text', text: 'built in 4.1 s' }] } },
    { type: 'tool', id: 'call_tsc', name: 'shell', state: { status: 'completed', input: { command: 'npx tsc --noEmit' }, content: [{ type: 'text', text: '' }] } },
    { type: 'text', text: `The suite is **green**: 212 passed, one skipped because it needs a GPU.

> [!DONE]
> Every test that can run here passes.

${F}metrics
Tests: 212/213 [success]
Skipped: 1 — needs a GPU [warning]
Time: 48 s
${F}

| Suite | Tests | Time |
|---|--:|--:|
| unit | 180 | 12 s |
| e2e | 32 | 36 s |

${F}checklist
- [x] unit tests
- [x] e2e tests
- [-] GPU tests
${F}` },
  ]),
  user('Good. Clean the build folder before the next run.'),
);
// A stam mail notice (templates/mail-notice.md) for the unread mail below, just before it, joined
// with a child's notice as src/mail.ts sends them: an OpenCode synthetic message, which the view
// shows as a notice row, and only the mail folds (S-296).
messages.push({ id: 'msg_seednotice', type: 'synthetic', text: 'Child kid finished: the build cache is cold.\n\n[stam] You have 1 unread mail. Unless stopping now would leave something broken or unsafe, stop what you are doing, read your inbox with the stam `read_mail` tool, and then continue your work. Latest unread:\n- m_seedunread from cos: Clean build/ before the next run', time: { created: t0 + 54.4 * 60_000 } });
const runningAt = at();
const running = { id: 'msg_seedrun', type: 'assistant', content: [
  { type: 'text', text: 'Removing the old `build/` folder first.' },
  { type: 'tool', id: 'call_rm', name: 'shell', state: { status: 'running', input: { command: 'rm -rf build', description: 'Remove the build folder' } } },
], time: { created: runningAt } };
messages.push(running);
const permissions = [{ id: 'per_seed1', action: 'shell', resources: ['rm -rf build'], source: { messageID: running.id, id: 'call_rm' } }];
if (dbPath) {
  const db = new DatabaseSync(dbPath);
  // The check daemon writes to this DB while we seed it; wait for its lock instead of failing with SQLITE_BUSY.
  db.exec('PRAGMA busy_timeout = 10000');
  const iso = (t) => new Date(t).toISOString();
  const mail = (id, from, fromName, subject, body, created, read) => {
    db.prepare('INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, from, fromName, subject, body, iso(created), id);
    db.prepare('INSERT INTO mail_recipients (mail_id, agent_id, read_at, pushed_at) VALUES (?, ?, ?, ?)').run(id, agent, read ? iso(read) : null, iso(created));
  };
  // Before the test run's prompt (msg_seed0052), read a minute later; and before the running turn.
  mail('m_seedread', 'human', 'human', 'Run the suite before the release', 'Run the whole suite and tell me what fails.\n\nIf the GPU tests skip, say so; I know this box has no GPU.\n\nThe release waits on this, so keep the summary short: counts, the one skip, and anything red.\n\nPost the counts in the release thread too.', t0 + 51.5 * 60_000, t0 + 52 * 60_000);
  // After the summary (msg_seed0053), before the next prompt.
  db.prepare('INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run('m_seedsent', agent, 'oc', 'Suite green: 212 passed, 1 skipped', 'The suite is green: 212 passed, one skipped because it needs a GPU. Nothing red.', iso(t0 + 53.5 * 60_000), 'm_seedread');
  db.prepare('INSERT INTO mail_recipients (mail_id, agent_id, read_at, pushed_at) VALUES (?, ?, ?, ?)').run('m_seedsent', 'human', iso(t0 + 53.8 * 60_000), iso(t0 + 53.5 * 60_000));
  mail('m_seedunread', fromId, null, 'Clean build/ before the next run', 'Stale files in `build/` broke the last deploy. Clear it before the next run.', t0 + 54.5 * 60_000, null);
}
const r = await fetch(`http://127.0.0.1:${port}/__fake/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, messages, permissions, active: true }) });
if (!r.ok) throw new Error(`seed: HTTP ${r.status}`);
