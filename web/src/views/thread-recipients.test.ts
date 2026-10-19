// @vitest-environment jsdom
// Whom a thread reply goes to (S-542): never a system sender (system:NAME, a script such as the
// deploy watcher), which has no mailbox; the daemon refused such a reply and it sat on "retrying".
import { describe, expect, it } from 'vitest'
import type { Mail } from '../types'
import { recipients } from './ThreadView'

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
