import { describe, expect, it } from 'vitest'
import { inputStatus, sha256Hex, timeLeft } from './input'

describe('suggested input (S-422)', () => {
  it('hashes the UTF-8 text as lowercase hex', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await sha256Hex('é')).toBe(await sha256Hex('é'))
  })

  it('says how long until it expires', () => {
    const now = Date.parse('2026-10-13T12:00:00Z')
    expect(timeLeft('2026-10-13T12:04:00Z', now)).toBe('expires in 4 min')
    expect(timeLeft('2026-10-13T12:00:40Z', now)).toBe('expires in 40 s')
    expect(timeLeft('2026-10-13T11:59:00Z', now)).toBe('expired')
    expect(timeLeft(null, now)).toBe('')
  })

  it('names the status after an answer, and the agent it went to', () => {
    const p = { status: 'pending', agent_name: 'tess' }
    expect(inputStatus(p, 'typed')).toBe('Typed into @tess')
    expect(inputStatus(p, 'held')).toBe('Held: types when @tess is idle')
    expect(inputStatus({ ...p, status: 'failed' })).toBe("Failed: @tess's box didn't show it")
    expect(inputStatus({ ...p, status: 'expired' })).toBe('Expired')
    expect(inputStatus({ ...p, status: 'denied' })).toBe('Denied')
    expect(inputStatus(p, 'cancelled')).toBe('Cancelled: nothing was sent')
    expect(inputStatus(p)).toBe('')
  })
})
