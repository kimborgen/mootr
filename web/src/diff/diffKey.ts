// The diff view's key (S-1531): `diff:REPO#N`, one PR's diff. REPO is a name in `settings.itsa.repos`, N the PR number.
// Pure, so it is tested alone.

export interface DiffRef { repo: string; pr: number }

export const diffKey = (repo: string, pr: number): string => `diff:${repo}#${pr}`

// The deep link for a diff (`#diff=REPO:N`).
export const diffHref = (repo: string, pr: number): string => `#diff=${encodeURIComponent(repo)}:${pr}`

// A key `diff:REPO#N`, or null. A repo name has no `#`, `:`, `/` or space; a PR number is a positive integer.
export function parseDiffKey(key: string): DiffRef | null {
  const m = /^diff:([^#:/\s]+)#([1-9]\d{0,8})$/.exec(key)
  return m ? { repo: m[1], pr: Number(m[2]) } : null
}

// A deep link's value (`#diff=REPO:N`).
export function parseDiffLink(v: string): DiffRef | null {
  const m = /^([^#:/\s]+):([1-9]\d{0,8})$/.exec(v)
  if (!m) return null
  try {
    const repo = decodeURIComponent(m[1])
    // The decoded name must still be a repo name: `a%2Fb` is not.
    return /^[^#:/\s]+$/.test(repo) ? { repo, pr: Number(m[2]) } : null
  } catch { return null }
}

export const diffTitle = (pr: number): string => `PR #${pr}`

// The patch view's key (S-2103): `patch:HASH`, a patch pasted in mail and kept in this browser's LRU (patchStore.ts).
// HASH is the patch text's own 64-bit hash, so the same content is always the same tab.
export const patchKey = (hash: string): string => `patch:${hash}`

export function parsePatchKey(key: string): string | null {
  const m = /^patch:([0-9a-f]{16})$/.exec(key)
  return m ? m[1] : null
}
