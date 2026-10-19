// Invented requirements for the requirement stories: a small tree with every status and every
// conformity state, verdicts on a merge-queue branch and on ITSAs, and one requirement's own view.
// Nobody here is real; keys R-1 and up are made up, and the times are relative to now.
import { refreshReq } from '../req/store'
import type { BatchItem } from '../req/ReqBatch'
import type { LatestVerdict, ReqVerdict, Requirement, RequirementView } from '../req/model'

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()

// The branch in the merge queue (itsaFixtures.QUEUE), at its head, and the ITSAs checked.
export const BRANCH_SUBJECT = 'branch:fixture/repo/fixture/settings-cleanup@abc1234'
export const BRANCH_OLD_HEAD = 'branch:fixture/repo/fixture/settings-cleanup@0ldhead'

export function lv(id: number, subject: string, verdict: LatestVerdict['verdict'], p: number | null, o: Partial<LatestVerdict> = {}): LatestVerdict {
  return { id, subject, verdict, p_violates: p, waived: null, ts: ago(30 + id), ...o }
}

export function req(n: number, parent: number | null, title: string, o: Partial<Requirement> = {}): Requirement {
  return {
    id: `fx-r-${n}`, key: `R-${n}`, parent_id: parent === null ? null : `fx-r-${parent}`, level: null, title,
    text: null, rationale: null, source: null, verification: null, scope: null, severity: 'major', mode: 'inform', threshold: 0.8,
    status: 'in_force', owner: 'fx-cos', version: 1, links: [], latest: [], ...o,
  }
}

export const REQS: Requirement[] = [
  req(1, null, 'Mail is never lost', { severity: 'critical', mode: 'enforce', level: 'system', text: 'The system shall keep every mail until its recipient has read it or it is archived.', rationale: 'A lost ask stalls an agent without anyone knowing.', latest: [lv(1, BRANCH_SUBJECT, 'conforms', 0.04)] }),
  req(2, 1, 'A reply archives its thread', { latest: [lv(2, BRANCH_SUBJECT, 'violates', 0.91), lv(3, 'itsa:S-911', 'unsure', 0.55), lv(4, 'itsa:S-912', 'conforms', 0.08)], links: [{ id: 1, target_kind: 'itsa', target: 'S-911', role: 'allocated_to' }] }),
  req(3, 1, 'Every send is acknowledged', { status: 'draft', latest: [lv(9, BRANCH_OLD_HEAD, 'conforms', 0.1)], links: [{ id: 2, target_kind: 'itsa', target: 'S-912', role: 'allocated_to' }] }),
  req(4, null, 'Agents state what they changed', { severity: 'minor', mode: 'observe', links: [{ id: 3, target_kind: 'itsa', target: 'S-911', role: 'informs' }], latest: [lv(5, BRANCH_SUBJECT, 'unsure', 0.52), lv(6, 'itsa:S-911', 'na', null)] }),
  req(5, null, 'Tokens never reach logs', { severity: 'critical', mode: 'enforce', links: [{ id: 4, target_kind: 'itsa', target: 'S-911', role: 'constrains' }], latest: [lv(7, BRANCH_SUBJECT, 'violates', 0.88, { waived: 'false_positive' }), lv(8, 'itsa:S-911', 'conforms', 0.02)] }),
  req(6, null, 'Keep a nightly backup', { status: 'suspended', latest: [] }),
  req(7, null, 'Use the old naming scheme', { status: 'obsolete', latest: [] }),
]

// A requirement's own view (GET /api/requirements/:key): R-2, with verdicts of every kind.
const verdict = (id: number, subject: string, v: ReqVerdict['verdict'], p: number | null, o: Partial<ReqVerdict> = {}): ReqVerdict => ({
  id, req_version: 1, subject, verdict: v, p_conforms: p === null ? null : 1 - p, p_violates: p, p_na: null, ts: ago(20 + id * 15), ...o,
})
export const VIEW_R2: RequirementView = {
  ...REQS[1],
  version: 2,
  text: 'When a reply is sent in a thread, the system shall archive that thread for the sender.',
  rationale: 'An answered thread left open keeps counting as waiting.',
  source: 'Kim, 2026-10-12',
  verification: [{ method: 'review', detail: 'A reviewer reads the diff for the archive call' }, { method: 'test', detail: 'test/mail-archive.test.ts' }],
  scope: { paths: ['src/mail/**'], roles: ['developer', 'reviewer'] },
  links: [
    { id: 1, target_kind: 'itsa', target: 'S-911', role: 'allocated_to' },
    { id: 2, target_kind: 'file', target: 'src/mail/send.ts', role: 'implemented_by' },
    { id: 3, target_kind: 'test', target: 'test/mail-archive.test.ts', role: 'verified_by' },
    { id: 4, target_kind: 'url', target: 'https://docs.example.com/fixture/mail-rules', role: 'documented_in' },
  ],
  parent_chain: [{ id: 'fx-r-1', key: 'R-1', title: 'Mail is never lost', status: 'in_force' }],
  children: [],
  precision: { window: 20, violates: 5, false_positives: 2, accepted_deviations: 1, rate: 0.4, max_rate: 0.3 },
  verdicts: [
    verdict(12, BRANCH_SUBJECT, 'violates', 0.91, { label: 'fixture/settings-cleanup' }),
    verdict(11, 'itsa:S-911', 'unsure', 0.55, { label: 'S-911 Build the new index', open: { kind: 'itsa', id: 'fx-i-911' } }),
    verdict(10, 'mail:fm-30', 'violates', 0.84, { label: 'Pick the cache lifetime', open: { kind: 'thread', id: 'fx-t-rich' }, waiver: { kind: 'false_positive', reason: 'The thread was archived by the sender one second later.', by: 'human', ts: ago(200) } }),
    verdict(9, 'itsa:S-912', 'conforms', 0.08, { label: 'S-912 Tokenizer for mixed scripts', open: { kind: 'itsa', id: 'fx-i-912' } }),
    verdict(8, 'text:3f9a', 'na', null, { req_version: 1 }),
  ],
}

// The drafts of a batch approval (GET /api/requirements/asks/:itsa): two to approve, one dropped.
export const BATCH_ITEMS: BatchItem[] = [
  { key: 'R-8', title: 'Retries back off', text: 'When a request fails with a transient error, the client shall wait at least twice as long before each retry.', rationale: 'Tight retry loops hammered the daemon after a restart.', rev: 1, status: 'draft', dropped: false },
  { key: 'R-9', title: 'Retries stop', text: 'The client shall stop retrying a request after five attempts and report the last error.', rationale: 'A request that never succeeds must not loop forever.', rev: 1, status: 'draft', dropped: false },
  { key: 'R-10', title: 'Retries are logged', text: null, rationale: null, rev: 2, status: 'obsolete', dropped: true },
]

// The daemon with requirements on, and a state's setup that reads them into the requirement store.
export const REQ_ON = { 'GET /api/req-enabled': { enabled: true }, 'GET /api/requirements?verdicts=latest': REQS }
export const REQ_OFF = { 'GET /api/req-enabled': { enabled: false } }
export const loadReqs = () => { void refreshReq() }

// For OnMount: puts a JSON file in the Import button's file input, as a pick would. The input's
// `files` and the file's `text()` are set directly, so it works in a browser and in jsdom alike.
export const pickFile = (text: string) => (el: HTMLElement) => {
  const input = el.querySelector<HTMLInputElement>('[data-req-import-file]')
  if (!input) throw new Error('pickFile: no import input in the state')
  const file = Object.assign(new File([text], 'requirements.json', { type: 'application/json' }), { text: async () => text })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
