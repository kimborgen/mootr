import { itsaData, TREE, clickWhen } from '../stories/itsaFixtures'
import { OnMount } from '../stories/helpers'
import { loadReqs, REQ_OFF, REQ_ON, REQS, VIEW_R2 } from '../stories/reqFixtures'
import { ds, reply, type Story } from '../stories/types'
import type { RequirementView } from './model'
import { ReqView, SubjectName } from './ReqView'

const data = itsaData(TREE)
const pane = (key: string) => <div style={{ height: 760, overflow: 'auto' }}><ReqView keyName={key} viewKey={'req:' + key} /></div>
const at = (key: string, v: RequirementView) => ({ ...REQ_ON, [`GET /api/requirements/${key}`]: v })
const DRAFT: RequirementView = { ...VIEW_R2, ...REQS[2], version: 1, parent_chain: [{ id: 'fx-r-1', key: 'R-1', title: 'Mail is never lost', status: 'in_force' }], children: [], links: [], verification: null, scope: null, text: null, rationale: null, source: null, verdicts: [], precision: { window: 20, violates: 0, false_positives: 0, accepted_deviations: 0, rate: null, max_rate: 0.3 } }
const ROOT: RequirementView = { ...VIEW_R2, ...REQS[0], parent_chain: [], children: [REQS[1], REQS[2]], links: [], precision: { window: 20, violates: 0, false_positives: 0, accepted_deviations: 0, rate: null, max_rate: 0.3 }, verdicts: [VIEW_R2.verdicts[3]] }
const PREVIEW = { key: 'R-2', n: 3, note: 'Ran on the last three branches in its scope', rows: [
  { subject: 'branch:fixture/repo/a', summary: 'fixture/settings-cleanup', verdict: 'violates', p_violates: 0.91, would_act: true },
  { subject: 'branch:fixture/repo/b', summary: 'fixture/tokenizer', verdict: 'conforms', p_violates: 0.06, would_act: false },
  { subject: 'branch:fixture/repo/c', summary: 'fixture/index-builder', error: 'fixture: the model did not answer' },
] }

export const stories: Story[] = [{
  name: 'Requirement view',
  group: 'ITSA and work',
  what: 'A requirement\'s own page: the chain of parents; the header (key, title, how it stands, status, severity, mode, owner, level, version, and the probability it acts at); the "shall" text with its rationale and source; its verification methods and scope; the Trace (the parent and children, and the links: ITSAs, requirements, and URLs are chips that open them; files, tests, and mail are plain chips that only name their target); precision; and the recent verdicts, each with a probability bar. Waive and Preview open a popover on a desktop and a bottom sheet on a phone. Every verdict is worded as an indication, never as fact.',
  when: 'The `w:req:KEY` world (view key `req:KEY`), from a row in the Requirements list, a cell or heading in the compliance matrix (a cell opens it scrolled to that verdict, marked once), or a requirement chip anywhere. It exists only while requirements are on.',
  code: ['web/src/req/ReqView.tsx#ReqView', 'web/src/req/ReqView.tsx#SubjectName', 'web/src/req/ReqView.tsx#reqTitles'],
  rules: [
    'How it stands is a glyph and words in the `--rq-*` tone ("likely violates"); severity and status are chips (critical and major in the warning tokens); the mode chip explains itself in its title: observe records only, inform tells the actor, enforce can hold a merge or deny a tool call (' + ds('State vocabulary') + ').',
    'The shall text is a quotation at `--type-chrome-lg` in a column of at most 64 characters; the rationale is secondary text with the source muted after it.',
    'Precision says how many of its last likely violations were waived as false positives. Over the limit, the rate turns `--rq-violates` and the requirement switches to observe-only, as the text says.',
    'A verdict row is a subject (a branch name, an ITSA, or a mail subject; the last two open it), the verdict word in its tone, a probability bar, its age, and Waive on a likely violation or unsure verdict. A waived one is muted with its kind (false positive, accepted deviation) and the reason in its title; one from an older version of the requirement is muted and prefixed with its version.',
    'A matrix cell opens the view with that verdict flashed once over `--duration-focus`; the motion token is `--duration-focus` (' + ds('Motion') + ').',
    'Waive needs a reason before it enables; a refusal shows in the form, not as a toast (' + ds('Persona rules') + '). Preview asks the model, so it runs only when pressed, records nothing, and tells nobody.',
    'Off, an unreachable requirement, and a draft with no checks each say so in place (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'A requirement with verdicts of every kind', data, routes: at('R-2', VIEW_R2), setup: loadReqs, render: () => pane('R-2') },
    { name: 'Waive, opened', data, routes: at('R-2', VIEW_R2), setup: loadReqs, render: () => <OnMount run={clickWhen('[data-waive="12"]')}>{pane('R-2')}</OnMount> },
    { name: 'Preview, opened', data, routes: { ...at('R-2', VIEW_R2), 'POST /api/requirements/R-2/preview': PREVIEW }, setup: loadReqs, render: () => <OnMount run={clickWhen('[data-preview-open]')}>{pane('R-2')}</OnMount> },
    { name: 'A root with children', data, routes: at('R-1', ROOT), setup: loadReqs, render: () => pane('R-1') },
    { name: 'A draft with no text and no checks', data, routes: at('R-3', DRAFT), setup: loadReqs, render: () => pane('R-3') },
    { name: 'Subject names', render: () => (
      <div className="story-pad"><SubjectName v={{ subject: 'branch:fixture/repo/x', label: 'fixture/settings-cleanup' }} /><br /><SubjectName v={{ subject: 'itsa:S-911', label: 'S-911 Build the new index', open: { kind: 'itsa', id: 'fx-i-911' } }} /><br /><SubjectName v={{ subject: 'mail:fm-30', label: 'Pick the cache lifetime', open: { kind: 'thread', id: 'fx-t-rich' } }} /><br /><SubjectName v={{ subject: 'text:3f9a' }} /></div>) },
    { name: 'Requirements off', data, routes: REQ_OFF, setup: loadReqs, render: () => pane('R-2') },
    { name: 'Error', data, routes: { ...REQ_ON, 'GET /api/requirements/R-2': reply(404, { error: 'fixture: no such requirement' }) }, setup: loadReqs, render: () => pane('R-2') },
  ],
}]
