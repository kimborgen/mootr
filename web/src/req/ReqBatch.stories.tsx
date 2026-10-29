import { OnMount } from '../stories/helpers'
import { clickWhen } from '../stories/itsaFixtures'
import { BATCH_ITEMS, loadReqs, REQ_OFF, REQ_ON } from '../stories/reqFixtures'
import { ds, reply, type Story } from '../stories/types'
import { ReqBatch } from './ReqBatch'

const OPEN: { id: string; kind: string; closed_at: string | null; updated_at: string } = { id: 'fx-i-950', kind: 'requirement-approval', closed_at: null, updated_at: '2026-10-14T09:00:00.000Z' }
const ask = (it = OPEN) => <div className="itsa-view" style={{ minHeight: 40 }}><div className="itsa-inner"><ReqBatch it={it} /></div></div>
const items = { itsa: 'fx-i-950', items: BATCH_ITEMS }
const routes = { ...REQ_ON, 'GET /api/requirements/asks/fx-i-950': items }

export const stories: Story[] = [{
  name: 'Requirement batch approval',
  group: 'ITSA and work',
  what: 'The drafts inside one approval ask: when an agent proposes several requirements together, a single ITSA asks you once, and this lists each draft with its "shall" text and why. Drop takes a draft out of the batch and offers two choices: keep it a draft, or mark it obsolete. Approve, in the ITSA\'s "Waiting on you" box, then puts the drafts left in force.',
  when: 'In the ITSA view of an open ITSA of kind `requirement-approval`, between the "Waiting on you" box and the body, while requirements are on. When it lists drafts, the ITSA hides its own body, which holds the same list. A single-draft ask has no batch and shows nothing here.',
  code: ['web/src/req/ReqBatch.tsx#ReqBatch'],
  rules: [
    'A heading counts "N to approve" and, once any are dropped, ", N dropped". A dropped row is muted with its outcome ("Dropped, still a draft" or "Dropped, now obsolete"); its buttons are gone.',
    'Dropping is two steps so it is never an accident: Drop shows "Keep as draft", "Mark obsolete", and Cancel in the row.',
    'Each drop carries the revision shown; if the draft changed or was approved since, the daemon refuses and the reason shows under the list in the error tone, in place and not as a toast (' + ds('Persona rules') + ').',
    'The list reports the ITSA revision its drafts were read with: Approve sends that one, and waits, disabled, while a reload of the list lags the ITSA (S-2998), so it never approves drafts that aren\'t on screen.',
    'A closed ask shows its drafts with no buttons. A dropped row\'s text takes `--text-muted`, and each draft\'s heading is at least `--size-hit-touch` tall (' + ds('Density') + ').',
  ],
  states: [
    { name: 'Two to approve, one dropped', data: {}, routes, setup: loadReqs, render: () => ask() },
    { name: 'Choosing how to drop', data: {}, routes, setup: loadReqs, render: () => <OnMount run={clickWhen('[data-drop="R-8"]')}>{ask()}</OnMount> },
    { name: 'A refused drop', data: {}, routes: { ...routes, 'POST /api/requirements/asks/fx-i-950/drop': reply(409, { error: 'fixture: R-8 changed since you looked' }) }, setup: loadReqs, render: () => <OnMount run={clickWhen('[data-drop="R-8"]', '[data-drop-keep="R-8"]')}>{ask()}</OnMount> },
    { name: 'A closed ask', data: {}, routes, setup: loadReqs, render: () => ask({ ...OPEN, closed_at: '2026-10-14T10:00:00.000Z' }) },
    { name: 'Not a batch, so nothing shows', data: {}, routes: REQ_ON, setup: loadReqs, render: () => <p className="muted">Nothing between the lines:{ask({ ...OPEN, kind: 'issue' })}</p> },
    { name: 'Requirements off, so nothing shows', data: {}, routes: REQ_OFF, setup: loadReqs, render: () => <p className="muted">Nothing between the lines:{ask()}</p> },
  ],
}]
