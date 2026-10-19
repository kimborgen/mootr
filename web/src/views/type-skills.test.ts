import { describe, expect, it } from 'vitest'
import type { Skill } from './SkillsSettings'
import { blockTokens, lineTokens, sameSkills, skillsPayload, toggleSkill } from './type-skills'

const sk = (name: string, description = 'Does a thing.'): Skill => ({ name, path: `/h/skills/${name}`, description }) as Skill

describe('type skills', () => {
  it('toggles a name on once and off', () => {
    expect(toggleSkill(['a'], 'b', true)).toEqual(['a', 'b'])
    expect(toggleSkill(['a', 'b'], 'b', true)).toEqual(['a', 'b'])
    expect(toggleSkill(['a', 'b'], 'a', false)).toEqual(['b'])
  })
  it('compares lists without regard to order, and clears an empty list with null', () => {
    expect(sameSkills(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameSkills(['a'], [])).toBe(false)
    expect(skillsPayload([])).toBeNull()
    expect(skillsPayload(['a'])).toEqual(['a'])
  })
  it('counts about 40 tokens a skill, the header once, and nothing without skills', () => {
    const all = [sk('one'), sk('two', 'x'.repeat(1000))]
    expect(blockTokens(all, [])).toBe(0)
    expect(lineTokens(all[0])).toBeGreaterThan(10)
    expect(lineTokens(all[1])).toBeLessThan(100)
    expect(blockTokens(all, ['one', 'two'])).toBe(25 + lineTokens(all[0]) + lineTokens(all[1]))
    expect(blockTokens(all, ['gone'])).toBe(0)
  })
})
