// Which PRs the diff view can open (S-1533). The daemon says which repos it serves and the GitHub repo each one's
// origin names (`GET /api/diff/repos`); a GitHub PR URL, a PR link and a branch link become a `diff:REPO#N` only when
// their repo is one of those, so a PR of any other repo has no diff action. The pure functions are tested alone; the
// store fetches once, keeps the answer for the page, and retries after a failure.
import { useSyncExternalStore } from 'react'
import type { ItsaLink } from '../types'
import { fetchDiffRepos, type DiffRepo } from './diffApi'
import type { DiffRef } from './diffKey'

export type { DiffRepo }

// `https://github.com/OWNER/REPO/pull/N` with an optional tail (`/files`, `#issuecomment-1`), as a repo and number.
const PR_URL = /^https:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9]\d{0,8})(?:[/?#].*)?$/i

export const repoNamed = (repos: DiffRepo[], github: string): DiffRepo | undefined =>
  repos.find((r) => r.github && r.github.toLowerCase() === github.toLowerCase())

// The diff a PR URL opens, or null: not a PR URL, or a repo the diff API doesn't serve.
export function prUrlTarget(repos: DiffRepo[], url: string): DiffRef | null {
  const m = PR_URL.exec(url.trim())
  if (!m) return null
  const repo = repoNamed(repos, `${m[1]}/${m[2]}`)
  return repo ? { repo: repo.name, pr: Number(m[3]) } : null
}

// The diffs an ITSA's links open, each with the link it comes from. A PR link opens its own PR. A branch link opens the
// PR of the same ITSA when exactly that one is known: the branch's repo (`meta.repo`) is a served repo and the ITSA has
// a PR link in it (a branch has no PR number of its own).
export function linkTargets(links: ItsaLink[] | undefined, repos: DiffRepo[]): { link: ItsaLink; ref: DiffRef }[] {
  const all = links ?? []
  const prs = all.flatMap((link) => { const ref = prUrlTarget(repos, link.url); return ref ? [{ link, ref }] : [] })
  const out = [...prs]
  for (const link of all) {
    if (link.system !== 'branch') continue
    const repo = link.meta?.repo
    const own = repo ? prs.filter((p) => p.ref.repo === repo) : []
    if (own.length === 1) out.push({ link, ref: own[0].ref })
  }
  return out.sort((a, b) => all.indexOf(a.link) - all.indexOf(b.link))
}

export const targetOf = (link: ItsaLink, links: ItsaLink[] | undefined, repos: DiffRepo[]): DiffRef | null =>
  linkTargets(links, repos).find((t) => t.link === link)?.ref ?? null

// --- the store ---
let repos: DiffRepo[] = []
let state: 'idle' | 'loading' | 'done' = 'idle'
let failedAt = 0
const RETRY_MS = 30_000
const listeners = new Set<() => void>()
const emit = () => { for (const fn of listeners) fn() }

// The served repos known so far (empty until the first answer).
export const currentDiffRepos = (): DiffRepo[] => repos

// Starts the fetch once; after a failure, again no sooner than RETRY_MS later.
export function loadDiffRepos(): void {
  if (state === 'loading' || state === 'done') return
  if (failedAt && Date.now() - failedAt < RETRY_MS) return
  state = 'loading'
  fetchDiffRepos().then((r) => { repos = r; state = 'done'; failedAt = 0; emit() }, () => { state = 'idle'; failedAt = Date.now() })
}

export function useDiffRepos(): DiffRepo[] {
  loadDiffRepos()
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => { listeners.delete(fn) } }, currentDiffRepos)
}

// Tests only.
export function resetDiffRepos(next: DiffRepo[] = [], done = false): void {
  repos = next; state = done ? 'done' : 'idle'; failedAt = 0; emit()
}
