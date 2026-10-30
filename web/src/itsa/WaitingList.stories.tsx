import type { Agent, DecisionMail, Permission } from '../types'
import { humanRowsOf } from '../mail/thread-index'
import { AGENTS } from '../stories/fixtures'
import { OnMount } from '../stories/helpers'
import { itsaData, TREE, WAITING_ITSAS } from '../stories/itsaFixtures'
import { ALL_THREADS, AGENTS_STOPPED, ASK_ITSA, DECISION, T_PERM, T_RICH, T_ASK } from '../stories/mailFixtures'
import { ds, type Story } from '../stories/types'
import { showWaiting } from './WaitingList'

const ago = (min: number) => new Date(Date.now() - min * 60000).toISOString()
const PERM = T_PERM.mails[0].permission as Permission
const trigger = <button className="btn" type="button">Waiting on you</button>
const open = (el: HTMLElement) => { const b = el.querySelector('button')!; showWaiting(b) }
// An agent that waits for your reply with no thread tied to it, so it keeps a row of its own.
const REPLY_WAIT: Agent[] = AGENTS.map((a) => (a.id === 'fx-dev' ? { ...a, activity: 'waiting', waits: [{ id: 'w-reply', kind: 'human', since: ago(15), source: 'wait_for', detail: 'Which of the two designs to build' }] } : a))
const everything = {
  ...itsaData([...TREE, ASK_ITSA], { attention: [ASK_ITSA, ...WAITING_ITSAS], decisions: [DECISION], perms: [PERM], agents: REPLY_WAIT }),
  humanRows: humanRowsOf(ALL_THREADS),
}
// Twelve more asks: the list scrolls inside the popover.
const MANY_DECISIONS: DecisionMail[] = Array.from({ length: 12 }, (_, i) => ({ mail_id: `fm-d${i}`, thread_id: `fx-t-d${i}`, from_id: 'fx-cos', from_name: 'fixture-cos', subject: `Pick the option for fixture question number ${i}, which has a long subject`, created_at: ago(20 + i * 40) }))

export const stories: Story[] = [{
  name: 'Waiting on you',
  group: 'ITSA and work',
  what: 'Everything that waits on you as one list, oldest first: ITSAs in a human status, permission requests, agents\' mail that holds a decision, and agents that wait for your reply. A row says what it is, who waits and why, and how long. Each thing shows once: an agent\'s wait for your answer folds into the ITSA ask or request it is about.',
  when: 'A popover from the "N waiting on you" button in the Issues header (`#issues-waiting`), which only shows while something waits. A row opens the ITSA, the thread, or the agent. The same rows, from one definition (`useWaiting`), give the count in the phone tabs, the Issues header, and the Work page\'s Needs-you group; the Mail header counts only the rows its inbox lists, which leaves out a plain wait for your reply.',
  code: ['web/src/itsa/WaitingList.tsx#showWaiting', 'web/src/itsa/WaitingList.tsx#useWaiting', 'web/src/itsa/WaitingList.tsx#waitingRows', 'web/src/itsa/WaitingList.tsx#WaitingList'],
  rules: [
    'It is a popover (`.menu.popover`): at most 360 px wide on a desktop; on a phone it is a sheet at most 75% of the screen high, and the list scrolls inside it (' + ds('Modals and menus') + ').',
    'A row is at least `--size-hit-touch` tall on every device, so it is a touch target on a desktop too. The mark is the ITSA\'s status glyph, a shield for a request, a mail icon for a decision, a user icon for a reply; the mark and the second line\'s words ("waits on you", "asks your approval", "waits for your decision", "waits for your reply") carry the meaning (' + ds('State vocabulary') + ').',
    'The mark takes `--status-warning-fg`; the second line and the age are `--type-chrome-sm` and muted; the first line is cut with an ellipsis.',
    'A request stands for the thread it started, folding that thread\'s decision and reply-wait rows into its own; one placed in another thread (S-3827) does not, so that thread\'s decision and reply wait keep their rows beside it (`ownPermThread`).',
    'Rows you deferred are off the list and off every count; they sit in the Mail list\'s Deferred group.',
    'An empty list says "Nothing waits on you." (' + ds('Empty, loading, and error') + ').',
  ],
  states: [
    { name: 'An ITSA, a request, a decision, and a reply', height: 520, data: everything, render: () => <OnMount run={open}>{trigger}</OnMount> },
    { name: 'An ITSA\'s ask that stops an agent', height: 360, data: itsaData([...TREE, ASK_ITSA], { attention: [ASK_ITSA], agents: AGENTS_STOPPED, humanRows: humanRowsOf([T_ASK]) }), render: () => <OnMount run={open}>{trigger}</OnMount> },
    { name: 'A decision only', height: 320, data: itsaData(TREE, { decisions: [DECISION], humanRows: humanRowsOf([T_RICH]) }), render: () => <OnMount run={open}>{trigger}</OnMount> },
    { name: 'Twelve decisions, long subjects', height: 560, data: itsaData(TREE, { decisions: MANY_DECISIONS }), render: () => <OnMount run={open}>{trigger}</OnMount> },
    { name: 'An ask you deferred is not listed', height: 300, data: itsaData(TREE, { attention: [{ ...ASK_ITSA, deferred: true }] }), render: () => <OnMount run={open}>{trigger}</OnMount> },
    { name: 'Loading', height: 300, data: itsaData(TREE, { loaded: { agents: true, mail: false, itsas: true } }), render: () => <OnMount run={open}>{trigger}</OnMount> },
    { name: 'Nothing waits', height: 300, data: itsaData(TREE), render: () => <OnMount run={open}>{trigger}</OnMount> },
  ],
}]
