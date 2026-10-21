import { InboxView } from './InboxView'
import { ds, reply, type Story } from '../stories/types'
import { ALL_THREADS, AGENTS_STOPPED, STATUSES, T_ARCH, T_AWAIT, T_PERM, T_PLAIN, WAITING, mail } from '../stories/mailFixtures'
import { OnMount } from '../stories/helpers'
import type { Data } from '../store'
import type { Thread } from '../types'

// The While you were away card (S-2822) at the top of the page: a window the human was away for, with what happened and what needs them.
const ago = (h: number) => new Date(Date.now() - h * 36e5).toISOString()
const DIGEST = {
  window: { since: ago(9), until: ago(0) }, dismissedAt: null,
  happened: { merged: [{ pr: 912, title: 'Digest card', itsa: 'S-2822', at: ago(2) }], closed: [], spawned: [{ agent: 'fixture-dev', at: ago(6) }], archived: [], spend: { usd: 1.4 } },
  needs: [{ kind: 'decision', ref: 'S-2801', title: 'Token lifetime', since: ago(5), new: true }],
  next: { itsas: [{ key: 'S-2822', title: 'Away digest card', status: 'in_progress' }], working: [{ agent: 'fixture-dev', detail: 'writing the card' }] },
}
const page = (selected?: string) => <div className="story-inbox" style={{ height: 560, display: 'flex', flexDirection: 'column' }}><InboxView selected={selected} /></div>
const inbox = (threads: Thread[], o: Partial<Data> = {}): Partial<Data> => ({ humanThreads: threads, humanArchived: [], humanDeferred: [], itsaStatuses: STATUSES, ...o })
const waiting: Partial<Data> = { ...WAITING, agents: AGENTS_STOPPED, perms: [T_PERM.mails[0].permission!] }
const chip = (id: string) => (el: HTMLElement) => el.querySelector<HTMLElement>(`[data-filter="${id}"]`)!.click()
// Types into the search box the way a reader does, so the page's own debounce and fetch run.
const type = (text: string) => (el: HTMLElement) => {
  const input = el.querySelector<HTMLInputElement>('[data-inbox-search]')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
// Many threads, long subjects, some from days ago: the list at a realistic scale.
const MANY: Thread[] = Array.from({ length: 60 }, (_, i) => ({ thread_id: 'fx-inbox-' + i, mails: [mail('fm-inbox-' + i, 'fx-inbox-' + i, ['fx-dev', 'fx-review', 'fx-ops', 'fx-cos'][i % 4], ['human'], i % 4 === 0 ? 'A long subject that goes past the width of the list and has to end in an ellipsis rather than wrap, number ' + i : `Fixture thread number ${i}`, i % 3 === 0 ? 'A long first line of the body that also runs past the width of the row, so the one-line summary has to end in an ellipsis too, number ' + i : 'Short body.', { min: 20 + i * 70, read: i > 5 })] }))
const DAYS: Thread[] = [T_PLAIN, T_ARCH]

export const stories: Story[] = [{
  name: 'Inbox page',
  group: 'Mail',
  what: 'Your mail as a page (`w:inbox`, S-2054): a header with the title, how many things wait on you and how many threads are unread, a search box and the filter chips (To answer, Unread, All, Awaiting, Deferred, Archived), then the rows grouped Needs you (pinned, oldest first), Today and Earlier (newest first). A row is one thread: a mark for its kind (Decision, Blocker, Done, Mail), the mark of who wrote last, the subject, the ITSA it is about, the age and an unread dot, over one line of what the latest mail says. The page is a list only: a thread opens in its own pane to the list\'s right, and the next one you open takes that pane\'s place.',
  when: 'The Mail tab of the sidebar, when it is showing and you click its name, opens it in main (also `#view=inbox`). On a phone the bottom bar\'s Mail opens it full width (the Mail list is gone from the phone). On a phone the header has Swipe (the cards mode) and History (what you visited, in place of the list), and All lists the dialogs with the parent or the chief of staff, and what waits with no thread of its own; the filter and search are kept there. The desktop page starts on All with none of these. Typing in the search box lists the threads the mail search (`GET /api/mail/search`) finds, best first, over every chip; Escape clears it. On a phone a tap pushes the thread as its own page and back returns to the list where it was.',
  code: ['web/src/mail/InboxView.tsx#InboxView', 'web/src/mail/inbox-model.ts#grouped', 'web/src/actions.tsx#openInboxThread', 'web/src/itsa/WaitingList.tsx#useWaiting', 'web/src/mail/swipeRow.ts#swipeRow'],
  rules: [
    'Rows are two lines and at least `--size-row-inbox` (`--size-hit-touch`, 44 px) tall on every screen; the whole row is the target (' + ds('Density') + ').',
    'The open thread\'s row takes the selected-row surface; unread rows show a dot, semibold subject and `--text-primary` ink. Kind and waiting are never colour alone: the kind has its own icon and name in its title (' + ds('State vocabulary') + ').',
    'The counts are `useWaiting`\'s and the chips\' are the sidebar\'s, so the nav badge, the header and the sidebar agree. Unread is the Unread list\'s length everywhere, so a deferred ask\'s thread counts only once new mail brings it back. To answer adds what you deferred or archived; on a phone a wait with no thread of yours lists apart as Also waiting.',
    'The chips sit on their own row and scroll sideways on a phone. On a phone a row swipes left to archive (or unarchive) and right to defer (or undefer), 96 px of reveal; what waits on your answer can\'t be archived, but can be deferred.',
    'Empty, loading and error are one line of words in the muted ink, with no icon and no skeleton; an error is in the error ink (' + ds('Empty, loading, and error') + ').',
    'Enter on a focused row opens it. On a desktop the keys work while the page shows: `j`/`k` step the rows and open each in the pane to the right, `e` archives and `d` defers the open thread (the next row opens, never an empty pane), `u` marks it read or, when it has none unread, unread again, `r` focuses the reply, `/` searches, `z` undoes the last archive, defer or unread, and Escape clears the focus left on a row. A one-line key hint sits under the list on a desktop and is hidden on a phone.',
  ],
  states: [
    { name: 'Groups, with a selected row', data: inbox(ALL_THREADS, { ...waiting, humanArchived: [T_ARCH] }), render: () => page('fx-t-plain') },
    { name: 'After an archive, the next row open', data: inbox(ALL_THREADS.filter((t) => t !== T_PLAIN), { ...waiting, humanArchived: [T_PLAIN] }), render: () => page(T_AWAIT.thread_id) },
    { name: 'Only today and earlier', data: inbox([...DAYS, ...ALL_THREADS.slice(0, 2)]), render: () => page() },
    { name: 'To answer', data: inbox([T_PLAIN], { ...waiting, humanArchived: [T_ARCH] }), render: () => <OnMount run={chip('toanswer')}>{page()}</OnMount> },
    { name: 'Unread', data: inbox(ALL_THREADS, waiting), render: () => <OnMount run={chip('unread')}>{page()}</OnMount> },
    { name: 'Awaiting', data: inbox(ALL_THREADS, { ...waiting, humanArchived: [T_ARCH] }), render: () => <OnMount run={chip('awaiting')}>{page()}</OnMount> },
    { name: 'Deferred', data: inbox([T_PLAIN], { humanDeferred: [ALL_THREADS[0]] }), render: () => <OnMount run={chip('deferred')}>{page()}</OnMount> },
    { name: 'Archived', data: inbox([T_PLAIN], { humanArchived: [T_ARCH] }), render: () => <OnMount run={chip('archived')}>{page()}</OnMount> },
    {
      name: 'Search results',
      data: inbox(ALL_THREADS, waiting),
      routes: { 'GET /api/mail/search': [{ thread_id: 'fx-t-long', subject: 'Cache fix progress' }, { thread_id: 'fx-t-plain', subject: 'Which port does the preview use?' }, { thread_id: 'fx-t-older', subject: 'An older cache thread, past the newest 60', people: ['human', 'fx-dev'], last: new Date(Date.now() - 90 * 864e5).toISOString(), excerpt: 'Only the search knows this one; the page draws it from the hit.' }] },
      render: () => <OnMount run={type('cache')}>{page()}</OnMount>,
    },
    { name: 'Search finds nothing', data: inbox(ALL_THREADS), routes: { 'GET /api/mail/search': [] }, render: () => <OnMount run={type('nothing like this')}>{page()}</OnMount> },
    { name: 'Search failed', data: inbox(ALL_THREADS), routes: { 'GET /api/mail/search': reply(503, { error: 'fixture: search is down' }) }, render: () => <OnMount run={type('cache')}>{page()}</OnMount> },
    { name: 'Empty', data: inbox([]), render: () => page() },
    { name: 'Loading', data: { humanThreads: [], loaded: { agents: true, mail: false, itsas: true } }, render: () => page() },
    { name: 'Error', data: { humanThreads: [], error: 'fixture: the daemon is unreachable', loaded: { agents: true, mail: false, itsas: true } }, render: () => page() },
    { name: 'Long inbox, long subjects', data: inbox(MANY, { unread: 6 }), render: () => page('fx-inbox-3') },
    { name: 'With the away digest', data: inbox(ALL_THREADS, waiting), routes: { 'GET /api/digest': DIGEST }, render: () => page() },
  ],
}]
