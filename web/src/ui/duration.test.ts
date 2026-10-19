import { describe, expect, it } from 'vitest'
import { durationMs } from './duration'

describe('durationMs', () => {
  it('reads ms and s, as the source and the minified build write them', () => {
    expect(durationMs('400ms')).toBe(400)
    expect(durationMs('.4s')).toBe(400)
    expect(durationMs('0.4s')).toBe(400)
    expect(durationMs(' 0.4s ')).toBe(400)
    expect(durationMs('0s')).toBe(0)
  })
  it('is 0 for what isn\'t a time', () => {
    expect(durationMs('')).toBe(0)
    expect(durationMs('fast')).toBe(0)
  })
})
