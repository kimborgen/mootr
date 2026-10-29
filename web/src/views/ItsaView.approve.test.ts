// @vitest-environment jsdom
// What Approve sends from the ITSA view (S-2998): the revision of the text on screen. A batch's drafts come from their own
// fetch, so while that answer lags the ITSA (a slow reload), Approve waits instead of sending a revision nobody saw.
import { describe, expect, it } from 'vitest'
import { shownForApprove } from './ItsaView'

describe('shownForApprove', () => {
  it('sends the ITSA revision for an ITSA that is not a batch', () => {
    expect(shownForApprove({ rev: 'r1' }, false, undefined)).toEqual({ rev: 'r1' })
  })
  it('sends the batch revision while it matches what the ITSA says', () => {
    expect(shownForApprove({ rev: 'r2' }, true, 'r2')).toEqual({ rev: 'r2' })
  })
  it('waits while the drafts shown lag the ITSA (the batch answered late)', () => {
    const r = shownForApprove({ rev: 'r2' }, true, 'r1')
    expect(r.rev).toBeUndefined()
    expect(r.wait).toMatch(/reloading/)
  })
})
