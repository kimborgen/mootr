// The app's reference resolvers (S-1484), registered once at start (main.tsx): `#494` as a pull request or
// issue on GitHub, or as the ITSA that carries that PR; and "Settings › Spending" as that Settings section.
import { currentDiffRepos } from '../diff/diffRepos'
import { getData } from '../store'
import { SECTIONS } from '../views/configSections'
import { registerRefResolver, type RefTarget } from './refs'

// The GitHub repo of the first repo the daemon serves, for a number when no ITSA link names another repo.
// None until the repos are known: then a number whose ITSA link names no repo offers no GitHub target, only the ITSA.
const ownRepo = (): string | undefined => currentDiffRepos().find((r) => r.github)?.github ?? undefined

// The GitHub repos the ITSAs' links name, the stam repo first.
export function githubRepos(): string[] {
  const own = ownRepo()
  const seen = new Set<string>(own ? [own] : [])
  for (const i of getData().itsas) for (const l of i.links ?? []) {
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//.exec(l.url ?? '')
    if (m) seen.add(m[1])
  }
  return [...seen]
}

// The ITSAs with a GitHub link to PR or issue N.
export function itsasForNumber(n: string): { id: string; key: string; title: string; links?: { url?: string | null }[] }[] {
  return getData().itsas.filter((i) => (i.links ?? []).some((l) => l.system === 'github' && (l.external_id === n || new RegExp(`/(pull|issues)/${n}$`).test(l.url ?? ''))))
}

// A bare number links only when an ITSA carries that PR or issue, and then only the repos those links
// name: "#1 priority" or a colour such as #000000 stays plain text.
export function numberTargets(n: string): RefTarget[] {
  const found = itsasForNumber(n)
  if (!found.length) return []
  const repos = new Set<string>()
  for (const i of found) for (const l of i.links ?? []) {
    const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)$/.exec(l.url ?? '')
    if (m && m[2] === n) repos.add(m[1])
  }
  const own = ownRepo()
  if (!repos.size && own) repos.add(own)
  return [
    ...[...repos].map((repo) => ({ label: `${repo}#${n}`, hint: 'Pull request or issue on GitHub', url: `https://github.com/${repo}/pull/${n}` })),
    ...found.map((i) => ({ label: `${i.key} ${i.title}`, hint: 'The ITSA this pull request delivers', action: 'itsa:' + i.id })),
  ]
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function registerAppRefResolvers(): void {
  registerRefResolver({
    id: 'number',
    pattern: /(?<![\w&/#.-])#(?!\d{6}(?!\d))(\d{1,6})(?![\w-])/g,
    resolve: (m) => numberTargets(m[1]),
  })
  // Longest label first, so "Context and compaction" wins over a shorter prefix.
  const labels = SECTIONS.map((s) => s.label).sort((a, b) => b.length - a.length).map(escRe).join('|')
  registerRefResolver({
    id: 'settings',
    pattern: new RegExp(`\\bSettings\\s*[›>]\\s*(?:${labels})(?![\\w])`, 'gi'),
    resolve: (m) => {
      const name = m[0].replace(/^Settings\s*[›>]\s*/i, '').toLowerCase()
      const s = SECTIONS.find((x) => x.label.toLowerCase() === name)
      return s ? [{ label: `Settings › ${s.label}`, hint: 'Open this page in mootr', action: 'settings:' + s.key }] : []
    },
  })
}
