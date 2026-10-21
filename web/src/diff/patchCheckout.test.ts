// S-2104: where a patch's file is read from. Pure ordering, so the fallback is tested without a request.
import { describe, expect, it } from 'vitest'
import { joinPath, places } from './patchCheckout'
import type { DiffRepo } from './diffApi'

const repo = (name: string, path?: string, sha: string | null = null): DiffRepo => ({ name, github: null, ...(path ? { path } : {}), sha })

describe('places', () => {
  it('has the writer\'s checkout first, then each repo checkout', () => {
    expect(places({ host: 'storage', cwd: '/w/stam2-x' }, [repo('one', '/projects/one', 'a1b2c3'), repo('two', '/projects/two')])).toEqual([
      { host: 'storage', dir: '/w/stam2-x', sha: null },
      { host: '', dir: '/projects/one', sha: 'a1b2c3' },
      { host: '', dir: '/projects/two', sha: null },
    ])
  })

  it('leaves out a repo the daemon named no path for, and a base with no cwd', () => {
    expect(places({ host: 'storage', cwd: '' }, [repo('one'), repo('two', '/projects/two')])).toEqual([{ host: '', dir: '/projects/two', sha: null }])
  })

  it('has nowhere to read with no base and no repos', () => {
    expect(places(null, [])).toEqual([])
    expect(places(null, [repo('one')])).toEqual([])
  })
})

describe('joinPath', () => {
  it('joins a directory and a path with one separator', () => {
    expect(joinPath('/w/x', 'src/a.ts')).toBe('/w/x/src/a.ts')
    expect(joinPath('/w/x/', 'src/a.ts')).toBe('/w/x/src/a.ts')
  })
})
