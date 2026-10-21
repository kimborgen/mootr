// The reference for run_test.go: what src/process-run.ts says for a matrix of stage entries over testdata/flow.yaml. Run by the test
// (node, no daemon, no home): argv[2] is the process file, argv[3] the output file.
import { readFileSync, writeFileSync } from 'node:fs';

const { parseProcessText } = await import('../../../../src/process-validate.ts');
const { stageEntryListener, answerEdge, evalCondition, prNumber, entryActions, describeAction, RUNNER_ACTOR } = await import('../../../../src/process-run.ts');

const text = readFileSync(process.argv[2], 'utf8');
const { process: p, errors } = parseProcessText(text, { file: `processes/${process.argv[4] ?? 'flow'}.yaml`, knownStatuses: new Set(['todo', 'in_progress', 'done', 'canceled', 'wont_do', 'blocked']) });
if (!p) {
  console.error(`runref: the process is invalid: ${errors.join('; ')}`);
  process.exit(2);
}

// stageEntryListener over every entry: the text it records, and whether the run, ask and agent hooks fired.
const hasAgentNodes = Object.values(p.nodes).some((n) => n.kind === 'agent');
const nodes = [...Object.keys(p.nodes), 'zzz', ''];
const actors = ['human', RUNNER_ACTOR, undefined, 'system:deploy-watch', 'achild'];
const linkSets = [[], [{ system: 'github', url: 'https://github.com/acme/app/pull/7' }, { system: 'github', url: 'https://github.com/other/app/pull/9' }]];
// The agent contexts an entry runs with: none, and combinations of the live owner/reviewer, the standing agent, the known types and the parent's owner.
const agentCtxs = [null];
for (const ownerLive of [false, true]) for (const reviewerLive of [false, true]) for (const cos of [null, 'cos-1']) for (const parentOwner of [null, 'boss-7']) for (const known of ['all', 'noghost', 'unset']) {
  agentCtxs.push({ id: 'i1', key: 'S-9', ownerLive, reviewerLive, cos, parentOwner, known });
}
const ctxOf = (c) => c && {
  id: c.id, key: c.key, ownerLive: c.ownerLive, parentOwner: c.parentOwner, cos: c.cos, reviewerLive: c.reviewerLive,
  ...(c.known === 'unset' ? {} : { typeKnown: (t) => c.known === 'all' || t !== 'ghost', isReviewerType: (t) => t === 'reviewer' || t === 'reviewer-lite' }),
};
const entries = [];
for (const mode of ['off', 'dry-run', 'on']) {
  for (const repo of ['', 'acme/app', 'ACME/App']) {
    for (const [li, links] of linkSets.entries()) {
      for (const actor of actors) {
        for (const to of nodes) for (const [ai, ac] of agentCtxs.entries()) {
          if (ai > 0 && (!hasAgentNodes || repo !== 'acme/app' || li !== 0)) continue;
          const seen = { record: [], run: 0, ask: 0, agent: 0, mail: 0, spawn: 0 };
          const listener = stageEntryListener({
            mode: () => mode,
            processesOf: () => [p],
            linksOf: () => links,
            repo: () => repo,
            record: (_id, t) => seen.record.push(t),
            run: () => void seen.run++,
            ask: () => void seen.ask++,
            agentOf: () => ctxOf(ac) ?? undefined,
            agent: (_i, _p, a) => void (seen.agent++, seen[a.do]++),
            log: () => {},
          });
          listener({ itsa: { id: 'i1', kind: 'work' }, from: 'x', to: to || null, actor });
          entries.push({ mode, repo, links: li, actor: actor ?? null, to, ctx: ai, record: seen.record[0] ?? null, run: seen.run, ask: seen.ask, mail: seen.mail, spawn: seen.spawn });
        }
      }
    }
  }
}

// An ITSA of another kind is not touched.
const other = { record: [] };
stageEntryListener({ mode: () => 'dry-run', processesOf: () => [p], linksOf: () => [], repo: () => '', record: (_i, t) => other.record.push(t), log: () => {} })({ itsa: { id: 'i2', kind: 'issue' }, from: null, to: 'draft', actor: 'human' });

// The pure pieces.
const conds = ['answered', ' answered ', 'verdict == approve', 'verdict != approve', 'verdict == "approve"', 'verdict==changes', 'Verdict == x', 'nope', '', undefined, 'answered == true', 'a.b', 'x != "y z"', 'x == 7.5-a'];
const facts = [{ answered: 'true' }, { answered: 'false' }, { verdict: 'approve' }, { verdict: 'changes' }, {}, { x: 'y' }, { x: '7.5-a' }];
const evals = [];
for (const when of conds) for (const f of facts) evals.push({ when: when ?? null, facts: f, ok: evalCondition(when, f) });
const answers = Object.keys(p.nodes).map((id) => [id, answerEdge(p, id)]);
const prs = [];
for (const repo of ['acme/app', 'ACME/APP', 'other/app', 'nobody/none', '']) {
  for (const links of [[], linkSets[1], [...linkSets[1]].reverse(), [{ system: 'linear', url: 'https://github.com/acme/app/pull/3' }], [{ system: 'github', url: 'https://github.com/acme/app/pull/3/files' }, { system: 'github', url: 'https://github.com/acme/app/pulls/4' }, { system: 'github', url: null }]]) {
    prs.push({ repo, links, pr: prNumber({ links }, repo) });
  }
}
const described = [];
for (const id of Object.keys(p.nodes)) for (const links of linkSets) for (const [ai, ac] of agentCtxs.entries()) {
  if (!hasAgentNodes && ai > 0) continue;
  const actions = entryActions(p, id, { links, agent: ctxOf(ac) ?? undefined }, 'acme/app');
  described.push({ node: id, links: linkSets.indexOf(links), ctx: ai, actions: actions.map((a) => ({ ...a, text: describeAction(a) })) });
}
writeFileSync(process.argv[3], JSON.stringify({ ctxs: agentCtxs, entries, other: other.record, evals, answers, prs, described }));
process.exit(0);
