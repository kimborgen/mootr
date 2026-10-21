// An invented `GET /api/processes` answer for the stories and the tests: the dev-change process
// with about thirty ITSAs spread over the nodes that carry statuses. Every name is made up
// (fixture-*); nothing comes from a live database.
import type { Process, ProcessCount, ProcessItsa, ProcessesResponse } from './types'

// A small generator so the fixture stays readable: keys run S-101 upward, one per entry.
let seq = 100
const itsa = (owner: string | null, status: string, title: string): ProcessItsa => {
  const key = `S-${++seq}`
  return { key, id: `fixture-${key.toLowerCase()}`, title, status, owner }
}
const count = (rows: ProcessItsa[]): ProcessCount => ({ count: rows.length, itsas: rows })

// Thirty ITSAs, by the node whose status they sit in today.
const code = [
  itsa('fixture-dev', 'in_progress', 'Route the process list in the daemon'),
  itsa('fixture-dev', 'in_progress', 'Load process YAML and validate it'),
  itsa('fixture-dev', 'in_progress', 'Colour the harness mark in the tree'),
  itsa('fixture-dev', 'in_progress', 'Fix the mail thread scope on a peer'),
  itsa('fixture-dev-2', 'in_progress', 'Retry a failed deploy fetch'),
  itsa('fixture-dev-2', 'in_progress', 'Bump the node base image'),
  itsa('fixture-dev-3', 'in_progress', 'Fold the token columns on a phone'),
  itsa('fixture-dev-3', 'in_progress', 'Keep the ring list in one query'),
  itsa('fixture-dev-4', 'in_progress', 'Reap a dead tmux server'),
  itsa('fixture-dev-4', 'in_progress', 'Cache the settings home copy'),
]
const review = [
  itsa('fixture-review', 'in_review', 'Read the process view for layout bugs'),
  itsa('fixture-review', 'in_review', 'Check the loader against bad YAML'),
  itsa('fixture-review-2', 'in_review', 'Review the phone board'),
  itsa('fixture-review-2', 'in_review', 'Check the watcher hold path'),
  itsa('fixture-review', 'in_review', 'Read the usage charts'),
  itsa('fixture-review-2', 'in_review', 'Check the archive sweep'),
  itsa('fixture-review', 'in_review', 'Review the mail title model'),
  itsa('fixture-review-2', 'in_review', 'Check the suggestion input flow'),
]
const approve = [
  itsa('fixture-cos', 'needs_approval', 'Raise the OpenRouter cap'),
  itsa('fixture-cos', 'needs_approval', 'Merge the wide-tables change'),
]
const merge = [
  itsa('fixture-manager', 'ready_to_merge', 'Merge the process schema'),
  itsa('fixture-manager', 'merging', 'Merge the live event stream fix'),
  itsa('fixture-manager', 'ready_to_merge', 'Merge the phone legend'),
  itsa('fixture-manager', 'merging', 'Merge the notice reader'),
  itsa('fixture-manager-2', 'ready_to_merge', 'Merge the peer write refusal'),
  itsa('fixture-manager-2', 'merging', 'Merge the settings split'),
]
const deploy = [
  itsa('fixture-watcher', 'deploying', 'Deploy the process route'),
  itsa('fixture-watcher', 'deploying', 'Deploy the settings split'),
  itsa('fixture-watcher', 'deploying', 'Deploy the mail title model'),
  itsa('fixture-watcher', 'deploying', 'Deploy the phone legend'),
]

export const DEV_CHANGE: Process = {
  id: 'dev-change',
  title: 'Dev change',
  description: 'How a request becomes a deployed change: mail in, a developer builds it, a reviewer reads it, the human approves, a manager merges, and the watcher deploys.',
  appliesTo: { kind: ['issue'] },
  lanes: {
    human: { type: 'human' },
    cos: { type: 'cos', label: 'Chief of staff' },
    manager: { type: 'manager' },
    developer: { type: 'developer' },
    reviewer: { type: 'reviewer', fallback: 'reviewer-fallback' },
    watcher: { type: 'script', label: 'Deploy watcher' },
  },
  nodes: {
    request: { kind: 'start', lane: 'human', label: 'Mail from the user', triggers: [
      { source: 'mail', actors: ['human'], label: 'Mail from the user' },
      { source: 'github', subjects: ['github:example/repo'], types: ['issues.opened'] },
      { source: 'timer', cron: '0 6 * * *' },
      { source: 'feedback', types: ['created'] },
    ] },
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
    code: count(code),
    review: count(review),
    approve: count(approve),
    merge: count(merge),
    deploy: count(deploy),
  },
}

// A second, tiny process, so the picker has something to switch to in the stories and tests.
export const RELEASE: Process = {
  id: 'release',
  title: 'Release',
  description: 'Cut a release from main and watch it deploy.',
  appliesTo: { kind: ['project'] },
  lanes: { human: { type: 'human' }, manager: { type: 'manager' }, watcher: { type: 'script', label: 'Deploy watcher' } },
  nodes: {
    ask: { kind: 'start', lane: 'human', label: 'The user says tag it', triggers: [{ source: 'mail', actors: ['human'] }] },
    tag: { kind: 'script', lane: 'manager', label: 'Tag and push', run: 'scripts/release.mjs', statuses: ['ready_to_merge'] },
    live: { kind: 'end', lane: 'watcher', status: 'done', label: 'Live' },
  },
  edges: [{ from: 'ask', to: 'tag' }, { from: 'tag', to: 'live' }],
  counts: { tag: count([itsa('fixture-manager', 'ready_to_merge', 'Tag v2.5.0')]) },
}

export const PROCESSES: ProcessesResponse = {
  processes: [DEV_CHANGE, RELEASE],
  errors: [{ file: 'processes/old-flow.yaml', message: 'unknown node kind "gate" on node "check"' }],
}
