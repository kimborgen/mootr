// @vitest-environment jsdom
// Whom a thread reply goes to (S-542): never a system sender (system:NAME, a script such as the
// deploy watcher), which has no mailbox; the daemon refused such a reply and it sat on "retrying".
import { describe, expect, it } from 'vitest'
import type { Mail } from '../types'
import { recipients, replyRecipients } from './ThreadView'

const mail = (from_id: string, to: string[]): Mail => ({ id: from_id + to.join(), from_id, subject: 's', body: 'b', created_at: '2026-10-14T00:00:00Z', recipients: to.map((id) => ({ id })) } as Mail)

describe('thread reply recipients', () => {
  it('names the agents who wrote, not the human nor a system sender', () => {
    expect(recipients([mail('human', ['a1']), mail('a1', ['a2']), mail('system:deploy-watch', ['human']), mail('a2', ['human'])])).toEqual(['a1', 'a2'])
  })
  it('falls back to whom it was sent, still without a system sender', () => {
    expect(recipients([mail('human', ['a1', 'system:deploy-watch'])])).toEqual(['a1'])
  })
  it('names nobody when only a script wrote to the human', () => {
    expect(recipients([mail('system:deploy-watch', ['human'])])).toEqual([])
  })
})

// A reply that answers a decision goes to whoever asked it, not to every agent who wrote in the thread (S-1366):
// an assistant's event relay posted later in the same ITSA thread was no party to the ask.
describe('a reply to a decision', () => {
  const ask = { ...mail('self-retro', ['human']), id: 'm99', kind: 'ask' } as Mail
  const relay = { ...mail('assistant', ['human']), id: 'm71' } as Mail
  const thread = [ask, relay]
  it('goes to the asker only, not to a later agent in the thread', () => {
    expect(replyRecipients(thread, ['m99'])).toEqual(['self-retro'])
  })
  it('keeps the thread recipients when it answers nothing', () => {
    expect(replyRecipients(thread, [])).toEqual(['self-retro', 'assistant'])
  })
})

// A free-text reply under an ask placed in another thread (S-3827) goes to its asker only: the thread's people never saw the ask.
describe('a reply under a placed ask', () => {
  const y1 = { ...mail('peer1', ['oth1']), id: 'm1', thread_id: 'm1' } as Mail
  const y2 = { ...mail('oth1', ['peer1']), id: 'm2', thread_id: 'm1' } as Mail
  const ask = { ...mail('dev1', ['human']), id: 'm3', thread_id: 'm1', permission_id: 'r1' } as Mail
  it('goes to the asker alone', () => {
    expect(replyRecipients([y1, y2, ask], [])).toEqual(['dev1'])
  })
  it('stays with the asker after the human answered it once', () => {
    const again = { ...mail('human', ['dev1']), id: 'm4', thread_id: 'm1', kind: 'ask-reply' } as Mail
    expect(replyRecipients([y1, y2, ask, again], [])).toEqual(['dev1'])
  })
  it("goes to the thread's people once they wrote after the ask", () => {
    const later = { ...mail('oth1', ['peer1']), id: 'm5', thread_id: 'm1' } as Mail
    expect(replyRecipients([y1, y2, ask, later], [])).toEqual(['peer1', 'oth1'])
  })
  it('an own-thread ask is not placed', () => {
    const own = { ...mail('dev1', ['human']), id: 'm6', thread_id: 'm6', permission_id: 'r2' } as Mail
    expect(replyRecipients([own], [])).toEqual(['dev1'])
  })
})
