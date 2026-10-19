// The backfill control's progress text (S-252): the counts while it runs, then why it stopped.
import { describe, expect, it } from 'vitest'
import { progressText, type BackfillProgress } from './ClassifySince'

const base: BackfillProgress = { running: true, labelled: 40, failed: 0, remaining: 960, stopped: null, capped: false, concurrency: 4, lastError: null }

describe('progressText', () => {
  it('shows the counts while running', () => {
    expect(progressText(base)).toBe('40 labelled · 960 left')
  })
  it('says why it stopped once done', () => {
    expect(progressText({ ...base, running: false, stopped: 'done', remaining: 0, labelled: 1000 })).toBe('1000 labelled · 0 left · stopped: done')
  })
  it('says capped at the daily cap', () => {
    expect(progressText({ ...base, running: false, stopped: 'capped' })).toBe('40 labelled · 960 left · stopped: capped')
  })
  it('says rate limited when the failures were 429s', () => {
    expect(progressText({ ...base, running: false, stopped: 'stalled', lastError: 'HTTP 429' })).toBe('40 labelled · 960 left · stopped: rate limited')
  })
  it('names the last error for other failures', () => {
    expect(progressText({ ...base, running: false, stopped: 'stalled', lastError: 'HTTP 500' })).toBe('40 labelled · 960 left · stopped: failing (HTTP 500)')
  })
})
