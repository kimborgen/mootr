// Import first in a standalone node test that sets its own STAM_HOME or spawns the CLI or a daemon without test/tmphome.mjs (S-3140).
// A reader takes MOOTR_X before STAM_X (src/env.ts), and a stam agent's environment carries both names, so a stray one points the
// test at the live home, daemon or token. This drops each live-reaching name and its twin; the test then sets what it needs.
// tmphome.mjs scrubs MOOTR_ names for the tests that use it; test/mootr-env-guard.test.mjs requires one of the two in every test
// that touches a home or spawns the CLI or a daemon.
import { withMootrTwins } from '../src/env.ts';

export const SCRUBBED = withMootrTwins(['HOME', 'PORT', 'URL', 'TOKEN', 'MACHINE', 'AGENT_ID', 'TMUX_SOCKET'].map((n) => `STAM_${n}`));
for (const k of SCRUBBED) delete process.env[k];
