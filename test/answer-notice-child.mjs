#!/usr/bin/env node
// One daemon start, for test/answer-notice-restart.test.mjs (S-3923): opens the home's database, restores the answer
// notices a restart finds, takes the agent's notices the way a hook does, and prints the rows left after the restore and
// what was taken. With `ack` as the third argument, the hook's client printed the response and acknowledged the rows it
// carried (POST /api/notices/:id/ack/:row); without it, the response was lost (a timed-out client) and the rows stay. A
// fresh process is a fresh start, so nothing in memory carries over. Usage: node answer-notice-child.mjs AGENT_ID [ack]
import * as db from '../src/db.ts';
import * as mail from '../src/mail.ts';

const [agentId, mode] = process.argv.slice(2);
db.open();
mail.restoreAnswerNotices();
const rowsAfterRestore = db.answerNotices().length;
const take = mail.inTurnTake(agentId);
if (mode === 'ack') for (const row of take?.rows ?? []) mail.ackNotice(agentId, row);
process.stdout.write(JSON.stringify({ rowsAfterRestore, taken: take?.text ?? '' }));
process.exit(0);
