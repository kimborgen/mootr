// "View diff" on an ITSA's PR link and on a branch link with a known PR (S-1533): opens `diff:REPO#N` in a pane. It shows
// only for a repo the diff API serves (diffRepos.ts); any other link gets nothing, not a dead button.
import { Icon } from '../Icon'
import { openDiff } from '../files/open'
import type { ItsaLink } from '../types'
import { targetOf, useDiffRepos } from './diffRepos'

export function ViewDiff({ link, links }: { link: ItsaLink; links: ItsaLink[] }) {
  const repos = useDiffRepos()
  const ref = targetOf(link, links, repos)
  if (!ref) return null
  return <button type="button" className="btn text itsa-diff" data-diff={`${ref.repo}#${ref.pr}`} title={`Open the diff of PR #${ref.pr}`} onClick={() => openDiff(ref.repo, ref.pr)}>
    <Icon name="git-pull-request" size="xs" />View diff</button>
}
