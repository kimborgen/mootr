#!/usr/bin/env node
// Seeds STAM_HOME (a throwaway home, set by test/e2e-activity-peers.sh before its daemon starts) with the
// realistic-scale activity fixture (S-1079, test/activity-fixture.mjs), then keeps one machine's share:
//   [ITSAS=1] node test/activity-peers-seed.mjs all|even|odd [agents] [days]
// `even` and `odd` keep the agents at those positions (their items, usage and samples); the ITSAs stay only
// with ITSAS=1, or for `all`. The trees cross machines.
import * as db from '../src/db.ts';
import { seedScale, splitFixture } from './activity-fixture.mjs';
import { hashToken } from '../src/agent-token.ts';

const home = process.env.STAM_HOME;
if (!home || home.includes('/.local/share/stam')) {
  console.error('refusing: STAM_HOME must be a throwaway home');
  process.exit(1);
}
const part = process.argv[2] ?? 'all';
const f = seedScale(db, { agents: Number(process.argv[3] ?? 120), days: Number(process.argv[4] ?? 3), now: Number(process.env.SEED_NOW) || Date.now() });
const keep = splitFixture(db, part, { itsas: part === 'all' || process.env.ITSAS === '1' });
// Every agent has the token `tok-ID` (the e2e test's agent-caller checks).
for (const id of keep) db.setTokenHash(id, hashToken(`tok-${id}`));
console.log(`seeded ${keep.size} of ${f.agents} agents in ${home}`);
