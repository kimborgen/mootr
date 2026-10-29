#!/usr/bin/env node
// S-3807: src/usage-scope.ts scopeSummary on a summary and a visible set. Argv: the summary as JSON, the visible ids as
// a JSON array. Prints the scoped summary as JSON.stringify writes it.
const root = new URL('../../../../', import.meta.url);
const { tempHome } = await import(new URL('test/tmphome.mjs', root));
process.env.STAM_HOME = tempHome('stam-scope-ref-');
process.env.STAM_TMUX_SOCKET = `scope-ref-${process.pid}`;
for (const k of ['STAM_URL', 'STAM_TOKEN', 'STAM_AGENT_ID', 'STAM_PORT']) delete process.env[k];
const [summaryJSON, visibleJSON] = process.argv.slice(2);
const { scopeSummary } = await import(new URL('src/usage-scope.ts', root));
console.log(JSON.stringify(scopeSummary(JSON.parse(summaryJSON), new Set(JSON.parse(visibleJSON)))));
process.exit(0);
