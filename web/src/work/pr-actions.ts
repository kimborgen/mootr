// The cell menu's entries for a PR the diff view can open (S-1533): "View diff" and "Open on GitHub" for each PR link of the
// row ("View diff" only where the diff API serves its repo). A plain click on the chip opens the diff; this menu (a right-click on the table cell, a
// long-press on a phone card's chip) and a modifier-click are the ways to the GitHub page. Pure, so the tests run in node.
import { prUrlTarget, type DiffRepo } from '../diff/diffRepos'
import type { DiffRef } from '../diff/diffKey'
import type { ItsaLink } from '../types'
import { isPull, linkKind, linkLabel } from './links'

export interface PrEntry { label: string; hint: string; url: string; diff?: DiffRef }

export function prEntries(links: ItsaLink[] | undefined, repos: DiffRepo[]): PrEntry[] {
  const out: PrEntry[] = []
  for (const l of links ?? []) {
    if (linkKind(l) !== 'github' || !isPull(l.url)) continue
    const diff = prUrlTarget(repos, l.url)
    // A PR of a repo the diff API doesn't serve (or before the repos are known) still offers its GitHub page: the phone card's link is an icon, and this menu is where it is named and opened.
    if (diff) out.push({ label: 'View diff', hint: linkLabel(l), url: l.url, diff })
    out.push({ label: 'Open on GitHub', hint: linkLabel(l), url: l.url })
  }
  return out
}
