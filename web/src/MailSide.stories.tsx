import { MailSide } from './MailSide'
import { ds, type Story } from './stories/types'
import { ALL_THREADS, AGENTS_STOPPED, ASK_ITSA, DECISION, STATUSES, T_ARCH, T_AWAIT, T_ASK, T_LONG, T_PERM, T_PLAIN, T_RICH, T_UNREAD, WAITING, mail } from './stories/mailFixtures'
import { OnMount } from './stories/helpers'
import { MANY_ASKS } from './mail/NeedsYouList.stories'
import type { Data } from './store'
import type { Permission, Thread } from './types'

const leftRef = { current: null as HTMLElement | null }
const side = () => <div className="tree-side" style={{ width: '100%' }}><MailSide leftRef={leftRef} /></div>
const sidebar = (threads: Thread[], o: Partial<Data> = {}): Partial<Data> => ({ humanThreads: threads, humanArchived: [], itsaStatuses: STATUSES, ...o })
const press = (label: string) => (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.mail-toggle')].find((b) => b.textContent?.startsWith(label))?.click()
// A harness dialog still with the stopped agent's parent (S-594).
const DIALOG: Permission = { id: 'fx-perm-d', agent_id: 'fx-ops', agent_name: 'fixture-ops', machine: 'fixture-machine', status: 'pending', kind: 'dialog', dialog: 1, action: 'Claude Code asks to allow editing config.json', with: ['fixture-cos'], subject: 'fixture-ops: editing config.json', created_at: new Date(Date.now() - 6 * 60000).toISOString() }
// Many threads, long subjects: the list at a realistic scale.
const MANY: Thread[] = Array.from({ length: 30 }, (_, i) => ({ thread_id: 'fx-many-' + i, mails: [mail('fm-many-' + i, 'fx-many-' + i, ['fx-dev', 'fx-review', 'fx-ops', 'fx-cos'][i % 4], ['human'], i % 5 === 0 ? 'A long subject that goes past the width of the list and has to end in an ellipsis rather than wrap, number ' + i : `Fixture thread number ${i}`, 'Body.', { min: 20 + i * 90, read: i > 3 })] }))

export const stories: Story[] = [{
  name: 'Mail list',
  group: 'Mail',
  what: 'Your threads below the agent tree, one line each: an unread dot, the model-given title as a chip (the row shows only that chip, and the subject when the thread has none), the message count, and the age. The attention list tops it: one row per thing waiting on you (an ITSA in a human status, a permission request, a decision), oldest first, so the header\'s "N waiting on you" is the number of rows under it (a plain wait for your reply, with no thread, has no row there and isn\'t counted; it is under To answer). An agent\'s wait tied to an inbox thread is that thread\'s row, marked "waits for your reply" with Archive disabled. An ITSA\'s ask that is in the inbox is that thread\'s row, with its status and who it stops. To answer lists everything still waiting on your answer (asks, requests, decisions, and an agent waiting for your reply, which the inbox list leaves out), archived or deferred ones too; a row leaves when answered or withdrawn. Awaiting lists the threads whose last message is yours and unanswered (archived ones too, each with a clock); Archived lists what archive hides; Deferred lists the threads you saved for later (S-976), off the unread count, each with an Undefer button, until a new mail in one brings it back to the inbox. Needs you (S-3831), the entry that heads the rail, lists every ask waiting on you from the asks list the daemon serves, then the asks settled in the last day with their outcome; its count is the open rows. Harness dialogs still with an agent\'s parent are a collapsed read-only group that is off the count; asks you deferred sit in a collapsed Decide later group in the inbox.',
  when: 'The sidebar\'s Mail section on the desktop. (On a phone, Mail is the Inbox page, `InboxView`.) A row opens its thread world (`thread:ID`), an ITSA row opens the ITSA, and an agent-waiting row opens the agent. A separator above resizes the list and the height is remembered.',
  code: ['web/src/MailSide.tsx#MailSide', 'web/src/MailSide.tsx#DelegatedGroup', 'web/src/itsa/WaitingList.tsx#useWaiting', 'web/src/mail/swipeRow.ts#swipeRow', 'web/src/itsa/AskBlockLine.tsx#AskBlockLine'],
  rules: [
    'Rows are `--size-row-tree` tall (the tree\'s row), `--size-hit-touch` on a phone, with the unread dot, semibold subject and `--text-primary` ink for unread; read rows stay `--text-secondary` (' + ds('Density') + ').',
    'Waiting is never colour alone: a status glyph, a shield, a question mark or a clock, and the words (`waits on you`, `decision`) say it (' + ds('State vocabulary') + ').',
    'A thread that waits on your answer can\'t be archived: its archive button is disabled with the reason in its title, and a swipe doesn\'t archive it.',
    'On a phone a row swipes left to archive or unarchive (96 px of reveal); on a desktop an archive button shows on hover and focus, and the age gives way to it.',
    'A row has Defer beside Archive on hover and focus (on a phone: the thread\'s top bar and menu); in the Deferred list the same slot undefers. A thread that waits on your answer can be deferred too: it leaves the inbox and its count but stays under To answer, unanswered; a pending permission request too (nothing is answered, and the agent isn\'t told).',
    'The Swipe switch opens the inbox as a stack of cards in main (`w:swipe`, the Swipe view story); it is pressed while that view shows.',
    'Counts follow one definition (`useWaiting`; To answer adds the deferred asks via `useToAnswerCount`), so the tabs and the lists agree; the inbox header counts only the rows it lists. A wait on a thread the list doesn\'t hold opens the agent, not an empty thread. Closing a thread from the Deferred list opens the next deferred one. The Awaiting, Archived, Deferred and To answer switches sit on their own row under the title: they wrap on a desktop and scroll sideways on a phone.',
    'Until the threads first load, the loading mark (`Loading`) stands under any rows already waiting on you, never an empty-state line (' + ds('Empty, loading, and error') + ').',
    'History swaps the list for the history of what main showed (the History story). On a desktop it is a tab of the sidebar pane; on a phone it is the Inbox page\'s History button.',
    'No toast: a blocked archive says why in the button title and in the one transient notice bar the design allows (' + ds('Persona rules') + ').',
  ],
  states: [
    { name: 'Inbox', data: sidebar([T_UNREAD, T_PLAIN, T_LONG]), render: side },
    { name: 'In a sidebar pane', data: sidebar([T_UNREAD, T_PLAIN, T_LONG]), render: () => <div className="tree-side" style={{ width: '100%', height: 260, display: 'flex', flexDirection: 'column' }}><MailSide leftRef={leftRef} pane /></div> },
    { name: 'Everything waiting on you', data: sidebar(ALL_THREADS, { ...WAITING, agents: AGENTS_STOPPED, perms: [T_PERM.mails[0].permission!], humanArchived: [T_ARCH] }), render: side },
    { name: 'An ITSA\'s ask, stopping an agent', data: sidebar([T_PLAIN, T_ASK], { attention: [ASK_ITSA], itsas: [ASK_ITSA], agents: AGENTS_STOPPED }), render: side },
    { name: 'A decision waiting', data: sidebar([T_RICH, T_PLAIN], { decisions: [DECISION] }), render: side },
    { name: 'Awaiting a reply', data: sidebar([T_PLAIN], { humanArchived: [T_ARCH], humanThreads: [T_AWAIT, T_PLAIN] }), render: () => <OnMount run={press('Awaiting')}>{side()}</OnMount> },
    { name: 'To answer', data: sidebar([T_PLAIN], { ...WAITING, agents: AGENTS_STOPPED, perms: [T_PERM.mails[0].permission!], humanArchived: [T_ARCH] }), render: () => <OnMount run={press('To answer')}>{side()}</OnMount> },
    { name: 'Needs you', data: sidebar([T_PLAIN], { asks: MANY_ASKS }), render: () => <OnMount run={(el) => el.querySelector<HTMLElement>('[data-needs-you]')?.click()}>{side()}</OnMount> },
    { name: 'Needs you, nothing waiting', data: sidebar([T_PLAIN], { asks: [] }), render: () => <OnMount run={(el) => el.querySelector<HTMLElement>('[data-needs-you]')?.click()}>{side()}</OnMount> },
    { name: 'Archived', data: sidebar([T_PLAIN], { humanArchived: [T_ARCH] }), render: () => <OnMount run={press('Archived')}>{side()}</OnMount> },
    { name: 'With the parent or chief of staff', data: sidebar([T_PLAIN], { delegateDialogs: [DIALOG] }), render: () => <OnMount run={(el) => el.querySelector<HTMLDetailsElement>('.mail-delegated')?.setAttribute('open', '')}>{side()}</OnMount> },
    { name: 'History on a phone', data: sidebar([T_PLAIN]), render: () => <OnMount run={press('History')}>{side()}</OnMount> },
    { name: 'Deferred threads', data: sidebar([T_PLAIN], { humanDeferred: [T_ARCH] }), render: () => <OnMount run={press('Deferred')}>{side()}</OnMount> },
    { name: 'Deferred asks', data: sidebar([T_RICH, T_PLAIN], { decisions: [{ ...DECISION, deferred: true }] }), render: side },
    { name: 'Many threads, long subjects', data: sidebar(MANY, { unread: 4 }), render: side },
    { name: 'Loading', data: { humanThreads: [], loaded: { agents: true, mail: false, itsas: true } }, render: side },
    { name: 'Loading, with a request waiting', data: { humanThreads: [], delegateDialogs: [DIALOG], loaded: { agents: true, mail: false, itsas: true } }, render: side },
    { name: 'Empty', data: sidebar([]), render: side },
  ],
}]
