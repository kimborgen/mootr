import { describe, expect, it } from 'vitest'
import { askQuestion } from './question'

const details = (input: unknown, tool = 'AskUserQuestion') => JSON.stringify({ tool, input, session: 's1' })
const one = { questions: [{ question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] }

describe('askQuestion', () => {
  it('reads the one question and its option labels', () => {
    expect(askQuestion(details(one))).toEqual({ question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Beta' }] })
  })

  it('keeps an option description, and drops a blank one', () => {
    const q = { questions: [{ question: 'Which folder?', options: [{ label: 'Alpha', description: 'The shared folder.' }, { label: 'Beta', description: '  ' }] }] }
    expect(askQuestion(details(q))?.options).toEqual([{ label: 'Alpha', description: 'The shared folder.' }, { label: 'Beta' }])
  })

  it('is undefined for a multi-select question or a repeated label, so the card offers only Approve and Deny', () => {
    const single = { question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Beta' }] }
    expect(askQuestion(details({ questions: [{ ...single, multiSelect: true }] }))).toBeUndefined()
    expect(askQuestion(details({ questions: [{ question: 'Which folder?', options: [{ label: 'Alpha' }, { label: 'Alpha' }] }] }))).toBeUndefined()
  })

  it('is undefined for any other shape, so the card offers only Approve and Deny', () => {
    expect(askQuestion(details(one, 'Read'))).toBeUndefined()
    expect(askQuestion(details({ questions: [one.questions[0], one.questions[0]] }))).toBeUndefined()
    expect(askQuestion(details({ questions: [{ question: 'Pick?', options: [{ label: ' ' }] }] }))).toBeUndefined()
    expect(askQuestion(details({ questions: [{ question: '', options: [{ label: 'A' }] }] }))).toBeUndefined()
    expect(askQuestion('not json')).toBeUndefined()
    expect(askQuestion(null)).toBeUndefined()
  })
})
