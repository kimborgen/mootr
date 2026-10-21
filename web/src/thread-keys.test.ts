// The keys of a mail thread's world (S-2286): `e` archives and `d` defers, in a `t:` world only.
import { describe, expect, it } from 'vitest'
import { threadKey } from './thread-keys'

describe('the thread keys', () => {
  it('archives on e and defers on d, in a thread world', () => {
    expect(threadKey('e', 't:t1')).toBe('archive')
    expect(threadKey('d', 't:t1')).toBe('defer')
  })

  it('does nothing else, and nothing outside a thread world', () => {
    expect(threadKey('x', 't:t1')).toBeNull()
    expect(threadKey('e', 'w:inbox')).toBeNull()
    expect(threadKey('d', null)).toBeNull()
  })
})
