// Where one of a patch's files can be read from (S-2104, PR 6 of the S-2092 redesign). A patch names no commit: its file
// is matched against a copy on disk. The writer's own checkout — their host and cwd, when the patch entry carries a base
// — comes first; the same path in each repo checkout the diff API serves follows, so a bare patch still resolves after
// the writer's worktree has gone or was never recorded.
import { api } from '../api'
import type { DiffRepo } from './diffApi'
import type { PatchBase } from './patchStore'

// One place to read a patch's file from: a machine (`''` is this one, which the Files API reads itself) and the
// directory its paths sit under. `sha` is that checkout's HEAD, when it is a commit a label can name.
export interface Place { host: string; dir: string; sha: string | null }

export function places(base: PatchBase | null, repos: DiffRepo[]): Place[] {
  const out: Place[] = []
  if (base?.cwd) out.push({ host: base.host, dir: base.cwd, sha: null })
  for (const r of repos) if (r.path) out.push({ host: r.host ?? '', dir: r.path, sha: r.sha ?? null })
  return out
}

export const joinPath = (dir: string, rel: string): string => `${dir.replace(/\/+$/, '')}/${rel}`

// The name of the machine this page is served by, which a declaration lookup in a file it reads itself needs: `?host&file`
// answers only for that daemon's own name (`src/decl.ts`). Read once per caller, and '' when the daemon cannot say.
export const fetchMachineName = (): Promise<string> =>
  api<{ machine: string }>('GET', '/api/health').then((h) => h.machine, () => '')
