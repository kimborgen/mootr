import { describe, expect, it } from 'vitest'
import { cleanCardLayout, defaultCardLayout, type CardLayout } from './card-layout'
import { agentCardHeight, nestedRows } from './system/layout'
import { agentModel, isAgentLocked, moveTo, placeItem, refusal, resetAgentLayout, setHairline, setIssueOn, hideItem, issueOn } from './agent-layout'

const base = (): CardLayout => defaultCardLayout('agent')

describe('the agent card height (S-1438 PR 8)', () => {
  it('is 96 px with the default layout, and 80 px with ISSUE off, from the same nested-row count the model gives', () => {
    expect(agentCardHeight(96, 16, nestedRows(defaultCardLayout('issue'), base()))).toBe(96)
    const off = setIssueOn(base(), false)
    expect(issueOn(off)).toBe(false)
    expect(agentCardHeight(96, 16, nestedRows(defaultCardLayout('issue'), off))).toBe(80)
  })
})

describe('the agent layout rules', () => {
  it('moves a badge within BADGES, and across into FOOT', () => {
    const moved = placeItem(base(), 'context', 'BADGES', 0)
    expect(moved.slots.BADGES.slice(0, 2)).toEqual(['context', 'health'])
    expect(placeItem(base(), 'tests', 'FOOT').slots.FOOT).toEqual(['activity', 'tests'])
  })

  it('refuses a locked item: the mark and the name stay in HEAD, and the refusal says why', () => {
    const l = base()
    expect(isAgentLocked('mark')).toBe(true)
    expect(isAgentLocked('name')).toBe(true)
    expect(refusal(l, 'name', 'HEAD')).toBe('locked')
    expect(placeItem(l, 'name', 'BADGES')).toBe(l)
    expect(placeItem(l, 'mark', 'FOOT')).toBe(l)
  })

  it('takes the issue only in ISSUE, and nothing but the issue in ISSUE', () => {
    const l = setIssueOn(base(), false)
    expect(placeItem(l, 'issue', 'HEAD')).toBe(l)
    expect(placeItem(l, 'issue', 'BADGES')).toBe(l)
    const d = base()
    expect(placeItem(d, 'context', 'ISSUE')).toBe(d)
    expect(issueOn(placeItem(l, 'issue', 'ISSUE'))).toBe(true)
  })

  it('switches the issue card off by hiding its item, and on again', () => {
    expect(setIssueOn(base(), false).slots.ISSUE).toEqual([])
    expect(setIssueOn(setIssueOn(base(), false), true).slots.ISSUE).toEqual(['issue'])
    expect(hideItem(base(), 'issue').slots.ISSUE).toEqual([])
  })

  it('steps an item over the ISSUE slot, which takes only the issue: ↓ from Cost lands at the start of BADGES', () => {
    const l = base()
    expect(refusal(l, 'cost', 'ISSUE')).toBe('slot')
    expect(agentModel.destination(l, 'cost', 'down')).toEqual({ slot: 'BADGES', index: 0 })
  })

  it('steps an item up over ISSUE: ↑ from the first BADGES row lands at the end of HEAD', () => {
    const l = base()
    expect(agentModel.destination(l, 'health', 'up')).toEqual({ slot: 'HEAD', index: 2 })
    expect(agentModel.moveTo(l, 'health', agentModel.destination(l, 'health', 'up') as { slot: string; index: number })).toEqual(
      { ...l, slots: { ...l.slots, HEAD: ['model', 'cost', 'health'], BADGES: ['review', 'tests'] }, chosen: true })
  })

  it('keeps a move that changes nothing as the same layout', () => {
    const l = base()
    expect(moveTo(l, 'health', { slot: 'BADGES', index: 0 })).toEqual({ ...l, chosen: true })
  })

  it('draws the hairline as a flag that is off after a toggle', () => {
    expect(setHairline(base(), false).hairline).toBe(false)
    expect(setHairline(base(), true).hairline).toBe(true)
  })

  it('resets to today\'s card with every field seen, so none lands in BADGES', () => {
    const reset = resetAgentLayout([{ id: 'a' }, { id: 'b' }])
    expect(reset.slots).toEqual(defaultCardLayout('agent').slots)
    expect(reset.seen).toEqual(['field:a', 'field:b'])
    expect(reset.chosen).toBe(true)
  })
})

describe('the agent layout saved and reloaded', () => {
  it('reads back as what was shown, for a layout the human changed', () => {
    const shown = setHairline(setIssueOn(placeItem(base(), 'context', 'FOOT'), false), false)
    const saved = JSON.parse(JSON.stringify(shown))
    expect(cleanCardLayout(saved, 'agent')).toEqual(shown)
  })
})
