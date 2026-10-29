// The reference for ring_test.go: what src/ring.ts says for a matrix of topics and texts. Run by the test (node, no daemon): argv[2] is the output file.
import { writeFileSync } from 'node:fs';

const { verdictLine, verdictOf, splitLine } = await import('../../../../src/ring.ts');

export const topics = [
  'Review the change', 'Review PR 12', 'review pr #7 please', 'Review pull request 33 and PR 33', 'PR 5 and PR 6', 'the PRs 5',
  'pull request#8', 'PR 9', 'apr 3', 'PR 12abc', 'see PR 1, then PR 1', '', 'PR\v12', 'pull request\v#8',
  'Review PR #1300 (owner/repo). Its base PR #1299 has merged, so diff against origin/main.',
];
const texts = [
  '', 'looks fine', 'Verdict: approve', '  verdict : APPROVE  ', 'Verdict: approve.', 'I can’t approve this', 'changes requested', 'Request changes please',
  'requesting_changes now', 'requested changes', 'approve\nVerdict: approve\nmore', 'Verdict: request_changes', 'no changes requested here? changes requested',
  'verdict : approve', 'Verdict:\vapprove', '\vverdict\v:\vAPPROVE\v',
];
const givens = [undefined, 'approve', 'request_changes', 'maybe', ''];
const out = { line: [], of: [], split: [] };
for (const t of topics) for (const m of [false, true]) out.line.push({ t, m, v: verdictLine(t, m) });
for (const t of topics) for (const x of texts) for (const g of givens) {
  let v;
  try { v = verdictOf(t, x, g) ?? null; } catch (e) { v = { error: e.message }; }
  out.of.push({ t, x, g: g ?? null, v });
}
const subsets = [
  [], [{ agent_id: 'a', verdict: 'approve' }], [{ agent_id: 'a', verdict: 'approve' }, { agent_id: 'b', verdict: 'approve' }],
  [{ agent_id: 'a', verdict: 'approve' }, { agent_id: 'b', verdict: 'request_changes' }], [{ agent_id: 'a', verdict: null }, { agent_id: 'b', verdict: null }],
  [{ agent_id: 'a', verdict: 'approve' }, { agent_id: 'b', verdict: null }], [{ agent_id: 'a', verdict: 'request_changes' }],
];
for (const t of topics) subsets.forEach((subs, i) => out.split.push({ t, i, v: splitLine({ topic: t }, subs, (id) => 'n-' + id) }));
writeFileSync(process.argv[2], JSON.stringify(out));
