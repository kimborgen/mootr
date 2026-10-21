// The `GET /api/processes` answer the UI checks stub, so the Process view (S-873) has something to
// draw before the daemon route (S-872) lands, and draws the same thing on every run. Invented
// names only; the numbers of ITSAs are small here (the story fixture has the full set).
const itsa = (n, owner, status, title) => ({ key: `S-${n}`, id: `fixture-s-${n}`, title, status, owner })
const count = (rows) => ({ count: rows.length, itsas: rows })

export const PROCESSES = {
  processes: [{
    id: 'dev-change',
    title: 'Dev change',
    description: 'How a request becomes a deployed change.',
    appliesTo: { kind: ['issue'] },
    lanes: {
      human: { type: 'human' },
      cos: { type: 'cos', label: 'Chief of staff' },
      manager: { type: 'manager' },
      developer: { type: 'developer' },
      reviewer: { type: 'reviewer' },
      watcher: { type: 'script', label: 'Deploy watcher' },
    },
    nodes: {
      request: { kind: 'start', lane: 'human', label: 'Mail from the user', triggers: [{ source: 'mail', actors: ['human'], label: 'Mail from the user' }, { source: 'github', types: ['issues.opened'] }, { source: 'timer', cron: '0 9 * * 1' }, { source: 'slack', types: ['message.channels'] }, { source: 'linear', types: ['issue.created'] }, { source: 'webhook', label: 'a long webhook trigger name that overflows' }] },
      code: { kind: 'agent', lane: 'developer', label: 'Implement, test, pr_open', statuses: ['in_progress'], doneWhen: 'pr_opened', boundary: [{ on: 'cost', action: 'pause' }] },
      review: { kind: 'agent', lane: 'reviewer', statuses: ['in_review'] },
      verdict: { kind: 'exclusive', lane: 'reviewer', label: 'Approved?' },
      approve: { kind: 'human', lane: 'human', ask: 'approve', statuses: ['needs_approval'], label: 'Human approves' },
      merge: { kind: 'script', lane: 'manager', run: 'npm run build', statuses: ['ready_to_merge', 'merging'], label: 'Merge the pull request' },
      deploy: { kind: 'wait', lane: 'watcher', event: 'deploy', statuses: ['deploying'], label: 'Deploy finishes' },
      done: { kind: 'end', lane: 'watcher', status: 'done', label: 'Deployed' },
    },
    edges: [
      { from: 'request', to: 'code' },
      { from: 'code', to: 'review' },
      { from: 'review', to: 'verdict' },
      { from: 'verdict', to: 'code', when: 'verdict == changes', label: 'changes' },
      { from: 'verdict', to: 'approve', label: 'approve' },
      { from: 'approve', to: 'merge' },
      { from: 'merge', to: 'deploy' },
      { from: 'deploy', to: 'done' },
    ],
    counts: {
      code: count([
        itsa(101, 'fixture-dev', 'in_progress', 'Route the process list'),
        itsa(102, 'fixture-dev', 'in_progress', 'Fold the token columns'),
        itsa(103, 'fixture-dev-2', 'in_progress', 'Bump the node image'),
      ]),
      review: count([
        itsa(104, 'fixture-review', 'in_review', 'Check the loader against bad YAML'),
        itsa(105, 'fixture-review', 'in_review', 'Read the phone board'),
      ]),
      merge: count([
        itsa(106, 'fixture-manager', 'ready_to_merge', 'Merge the process schema'),
        itsa(107, 'fixture-manager', 'merging', 'Merge the notice reader'),
      ]),
    },
  }, {
    id: 'release',
    title: 'Release',
    description: 'Cut a release from main and watch it deploy.',
    lanes: { human: { type: 'human' }, manager: { type: 'manager' }, watcher: { type: 'script', label: 'Deploy watcher' } },
    nodes: {
      ask: { kind: 'start', lane: 'human', label: 'The user says tag it', triggers: [{ source: 'mail', actors: ['human'] }] },
      tag: { kind: 'script', lane: 'manager', label: 'Tag and push', run: 'scripts/release.mjs', statuses: ['ready_to_merge'] },
      live: { kind: 'end', lane: 'watcher', status: 'done', label: 'Live' },
    },
    edges: [{ from: 'ask', to: 'tag' }, { from: 'tag', to: 'live' }],
    counts: { tag: count([itsa(108, 'fixture-manager', 'ready_to_merge', 'Tag v2.5.0')]) },
  }],
  errors: [{ file: 'processes/old-flow.yaml', message: 'unknown node kind "gate" on node "check"' }],
}
