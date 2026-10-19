// @vitest-environment node
// The warning notes in Settings keep the warning tone: the stale-settings banner (`scope-stale`,
// emitted by ConfigView) and the bypass note (`warn`, S-2071) share one rule in style.css. The web
// project has no Node types, and vitest empties a CSS import, so the files are read with fs.
// @ts-ignore: 'node:fs' has no types here
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8')
const config = readFileSync(new URL('./views/ConfigView.tsx', import.meta.url), 'utf8')

describe('Settings warning notes', () => {
  it('styles both the stale banner and the warn note with the warning tokens', () => {
    for (const cls of ['scope-stale', 'warn']) {
      const rule = css.split('\n').find((l: string) => l.startsWith('.set-note') && l.includes(`.set-note.${cls}`))
      expect(rule, cls).toBeDefined()
      expect(rule).toContain('--status-warning-bg')
      expect(rule).toContain('--status-warning-fg')
    }
  })
  it('keeps ConfigView emitting the class the stale banner is styled by', () => {
    expect(config).toContain('set-note scope-stale')
  })
})
