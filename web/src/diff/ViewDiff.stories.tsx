// The "View diff" button on an ITSA's links (S-1533). Repos and links are invented.
import { ds, type Story } from '../stories/types'
import type { ItsaLink } from '../types'
import { resetDiffRepos } from './diffRepos'
import { ViewDiff } from './ViewDiff'

const pr: ItsaLink = { n: 1, system: 'github', external_id: '901', url: 'https://github.com/fixture/repo/pull/901' }
const branch: ItsaLink = { n: 2, system: 'branch', external_id: 'fixture/diff-entry', url: '', meta: { repo: 'fixture' } }
const other: ItsaLink = { n: 3, system: 'github', external_id: '12', url: 'https://github.com/other/thing/pull/12' }
const links = [pr, branch, other]
const served = () => resetDiffRepos([{ name: 'fixture', github: 'fixture/repo' }], true)
const row = (l: ItsaLink) => <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minHeight: 'var(--size-row-table)', padding: '0 var(--space-4)' }}><span>{l.external_id}</span><ViewDiff link={l} links={links} /></div>

export const stories: Story[] = [{
  name: 'View diff button',
  group: 'ITSA and work',
  what: 'The "View diff" action on a row of an ITSA\'s Links: it opens the PR\'s diff view (`diff:REPO#N`) in a pane. A PR link has it, and so does the ITSA\'s branch link when the ITSA has exactly one PR in the branch\'s repo (a branch has no PR number of its own).',
  when: 'In the Links section of an ITSA\'s page, for a repo that `GET /api/diff/repos` lists. A PR of any other repo, an issue and a plain link have no button at all.',
  code: ['web/src/diff/ViewDiff.tsx#ViewDiff', 'web/src/diff/diffRepos.ts#linkTargets'],
  rules: [
    'A text button with the pull-request icon in link ink (' + ds('Buttons') + '); `--size-control` tall, and `--size-hit-touch` on a phone, so it is a full touch target.',
    'It is absent, not disabled, where the repo is not served or the repos are not known yet, and the row keeps its height either way.',
  ],
  states: [
    { name: 'A PR link', setup: served, render: () => row(pr) },
    { name: 'A branch link with a known PR', setup: served, render: () => row(branch) },
    { name: 'A PR of a repo the diff API does not serve: no button', setup: served, render: () => row(other) },
    { name: 'Repos not known yet: no button', setup: () => resetDiffRepos([], true), render: () => row(pr) },
  ],
}]
