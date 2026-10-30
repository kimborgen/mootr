#!/usr/bin/env node
// One daemon process, for test/input-notice-restart.test.mjs (S-4155). Typing is a fake Claude Code box: it claims the
// approval through the real `proceed` and, on a yes, appends the line to LOG as Enter would submit it.
//   approve AGENT ID SHA LOG: the human's approval through approveInput. STAM_TEST_INPUT_CRASH in the parent's env stops
//     the process at that step (exit 75), as a crash would; without it the approval runs to the end and the process
//     exits with the notice still queued in memory.
//   restart AGENT LOG: a fresh start on the home: restores the answer notices, runs the held-input sweep once, takes the
//     agent's notices the way a hook does (and acks them), and prints the rows the restore found, what was taken, and
//     the lines submitted so far.
import { appendFileSync, readFileSync } from 'node:fs';
import * as db from '../src/db.ts';
import * as mail from '../src/mail.ts';
import * as perm from '../src/permissions.ts';
import { adapters } from '../src/adapters/index.ts';

const [mode, agentId, ...rest] = process.argv.slice(2);
const log = rest.at(-1);
adapters.claude.typeLiteralInput = async (agent, text, proceed) => {
  if (agent.activity !== 'idle' && agent.activity !== 'waiting') return 'busy';
  if (!(await proceed(() => true))) return 'cancelled';
  appendFileSync(log, `${text}\n`);
  return 'typed';
};
const submitted = () => {
  try {
    return readFileSync(log, 'utf8');
  } catch {
    return '';
  }
};
db.open();
if (mode === 'approve') {
  const [id, sha] = rest;
  const out = await perm.approveInput(id, sha);
  process.stdout.write(JSON.stringify({ outcome: out.outcome, why: out.why ?? null }));
} else {
  mail.restoreAnswerNotices();
  const rowsAfterRestore = db.answerNotices().filter((r) => r.agent_id === agentId).length;
  await perm.retryHeldInputs();
  const take = mail.inTurnTake(agentId);
  for (const row of take?.rows ?? []) mail.ackNotice(agentId, row);
  process.stdout.write(JSON.stringify({ rowsAfterRestore, taken: take?.text ?? '', submitted: submitted() }));
}
process.exit(0);
