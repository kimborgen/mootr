// The type composer's rules (S-892): the draft over the block catalog, the payload it saves, the token total.
import { describe, expect, it } from 'vitest'
import { blocksPayload, composing, draftOf, moveBlock, orderedIds, sameDraft, setOff, setReplacement, totalFor, type Catalog } from './type-compose'

const b = (id: string, template: string, tokens: number, rendered = true, applies = true) => ({ id, title: id.toUpperCase(), summary: `${id}.`, tokens, template, rendered, applies })
const cat: Catalog = {
  blocks: [b('a', 'system-prompt', 100), b('b', 'system-prompt', 200), b('c', 'system-prompt', 300), b('r', 'retro', 50)],
  replacements: [{ path: 'blocks/_replace/short.md', id: 'short', title: 'Short', summary: 's', tokens: 10 }],
}

describe('draftOf', () => {
  it('starts from the global order and drops ids the catalog does not know', () => {
    expect(draftOf(null, cat)).toEqual({ off: [], replace: {}, order: ['a', 'b', 'c', 'r'] })
    expect(draftOf({ off: ['b', 'gone'], replace: { gone: 'x' }, order: ['c'] }, cat)).toEqual({ off: ['b'], replace: {}, order: ['c', 'a', 'b', 'r'] })
  })
})

describe('edits', () => {
  it('switching off drops a replacement, and replacing turns the block back on', () => {
    const d = setReplacement(draftOf(null, cat), 'a', 'blocks/_replace/short.md')
    expect(setOff(d, 'a', true)).toMatchObject({ off: ['a'], replace: {} })
    expect(setReplacement(setOff(d, 'a', true), 'a', 'blocks/_replace/short.md')).toMatchObject({ off: [], replace: { a: 'blocks/_replace/short.md' } })
    expect(setReplacement(d, 'a', '').replace).toEqual({})
  })
  it('moves a block within its template only, and stops at the ends', () => {
    const d = draftOf(null, cat)
    expect(moveBlock(d, cat, 'a', 1).order).toEqual(['b', 'a', 'c', 'r'])
    expect(moveBlock(d, cat, 'a', -1)).toBe(d)
    expect(moveBlock(d, cat, 'r', 1)).toBe(d)
    expect(moveBlock(moveBlock(d, cat, 'c', -1), cat, 'c', -1).order).toEqual(['c', 'a', 'b', 'r'])
  })
})

describe('tokens', () => {
  it('counts the blocks that are on, with a replacement\'s own size, and shows the change on the inventory total', () => {
    const saved = draftOf(null, cat)
    expect(composing(cat, saved)).toBe(650)
    const d = setReplacement(setOff(saved, 'c', true), 'b', 'blocks/_replace/short.md')
    expect(composing(cat, d)).toBe(100 + 10 + 50)
    expect(totalFor(5000, cat, saved, d)).toBe(5000 - 650 + 160)
    expect(totalFor(5000, cat, saved, saved)).toBe(5000)
  })
  it('counts only the mail rules the agent gets, so editing the other template leaves the total alone', () => {
    const c = { ...cat, blocks: [...cat.blocks, b('m-full', 'mail-to-human', 400), b('m-short', 'mail-to-human-restricted', 80, true, false)] }
    const saved = draftOf(null, c)
    expect(composing(c, saved)).toBe(650 + 400)
    expect(totalFor(5000, c, saved, setOff(saved, 'm-short', true))).toBe(5000)
    expect(totalFor(5000, c, saved, setOff(saved, 'm-full', true))).toBe(5000 - 400)
  })
  it('ignores a template a whole file overrides', () => {
    const c = { ...cat, blocks: [...cat.blocks, b('x', 'retro', 999, false)] }
    expect(composing(c, draftOf(null, c))).toBe(650)
  })
})

describe('blocksPayload', () => {
  it('sends only what differs from the global templates', () => {
    expect(blocksPayload(cat, draftOf(null, cat))).toBeUndefined()
    const d = moveBlock(setOff(setReplacement(draftOf(null, cat), 'a', 'blocks/_replace/short.md'), 'c', true), cat, 'b', -1)
    expect(blocksPayload(cat, d)).toEqual({ off: ['c'], replace: { a: 'blocks/_replace/short.md' }, order: ['b', 'a', 'c', 'r'] })
  })
  it('round-trips through draftOf and compares drafts regardless of off order', () => {
    const d = moveBlock(setOff(draftOf(null, cat), 'a', true), cat, 'c', -1)
    expect(sameDraft(draftOf(blocksPayload(cat, d), cat), d)).toBe(true)
    expect(orderedIds(cat, ['c'])).toEqual(['c', 'a', 'b', 'r'])
  })
})
