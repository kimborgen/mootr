// A GitHub PR link in mail (S-1533): `https://github.com/OWNER/REPO/pull/N` for a repo the diff API serves opens the diff
// view in the app, the way a file path opens the file view. "GitHub" stays beside it for the PR page, and a modifier-click
// on the link itself still goes there. Other links, PRs of other repos, and anything in a code span or block are left alone.
import { openDiff } from '../files/open'
import { prUrlTarget, type DiffRepo } from '../diff/diffRepos'

const SKIP = 'code, pre, .mb-embed, .mb-chart, .mb-diagram'

// Marks each such link in `root` and adds the GitHub link after it. Idempotent: a marked link is skipped.
export function linkPrUrls(root: HTMLElement, repos: DiffRepo[]): void {
  if (!repos.length) return
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]:not(.pr-link):not(.pr-gh)')) {
    if (a.closest(SKIP) || a.querySelector('code')) continue
    const ref = prUrlTarget(repos, a.getAttribute('href') ?? '')
    if (!ref) continue
    a.classList.add('pr-link')
    a.dataset.prRepo = ref.repo
    a.dataset.prNumber = String(ref.pr)
    a.title = `Open the diff of PR #${ref.pr} in mootr (Ctrl-click: GitHub)`
    const gh = document.createElement('a')
    gh.className = 'pr-gh'
    gh.href = a.href
    gh.target = '_blank'
    gh.rel = 'noreferrer noopener'
    gh.title = 'Open this pull request on GitHub'
    gh.textContent = 'GitHub'
    a.after(' ', gh)
  }
}

// A plain click on a marked link opens the diff. True when it handled the click.
export function prLinkClick(e: { target: EventTarget | null; preventDefault(): void; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; button?: number }): boolean {
  const a = (e.target as Element | null)?.closest?.<HTMLElement>('a.pr-link')
  if (!a?.dataset.prRepo || !a.dataset.prNumber) return false
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button ?? 0) !== 0) return false
  e.preventDefault()
  openDiff(a.dataset.prRepo, Number(a.dataset.prNumber))
  return true
}
