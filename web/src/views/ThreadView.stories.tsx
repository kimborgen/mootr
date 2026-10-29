import { ThreadArchive, ThreadView } from './ThreadView'
import { ds, reply, type Story } from '../stories/types'
import { Row } from '../stories/helpers'
import { AGENTS_STOPPED, ASK_ITSA, ASK_ROUTE, mail, Pane, STATUSES, T_ARCH, T_ASK, T_AWAIT, T_INPUT, T_LONG, T_PERM, T_PLAIN, T_RICH, T_UNREAD, threadRoutes } from '../stories/mailFixtures'
import type { Data } from '../store'
import type { Thread } from '../types'

const T_DEFER = { ...T_ARCH, thread_id: 'fx-t-defer' } satisfies Thread
const view = (t: Thread) => <Pane><ThreadView tid={t.thread_id} viewKey={'thread:' + t.thread_id} /></Pane>
const world = (t: Thread, extra: Partial<Data> = {}): Partial<Data> => ({ humanThreads: [t], itsaStatuses: STATUSES, ...extra })
// Nobody to reply to: a thread only a script (the deploy watcher) wrote in.
const SYSTEM = { thread_id: 'fx-t-system', mails: [mail('fm-sys', 'fx-t-system', 'system:deploy-watcher', ['human'], 'Deployed: fixture build', 'Deployed build `fixture-1`. No action needed.', { min: 15 })] } satisfies Thread

export const stories: Story[] = [{
  name: 'Thread world',
  group: 'Mail',
  what: 'A mail thread\'s own world: the thread panel above, and a reply that sends to the agents who wrote in the thread. A click on an answer in the thread (a decision option, a pick, a rank, Decide later, Approve or Deny on a permission request, an ITSA action) is staged, not sent: a preview above the box shows exactly the reply that will go out, the box takes context for it, and one Send delivers every answer. A permission answer goes through the permission API, and a reply archives the thread and opens the next mail. Defer (save it for later; Undefer when it is deferred) and Archive are not in the thread\'s header: they sit in the tab bar, on a desktop at the strip\'s end and on a phone in the top bar (`ThreadArchive`). Archive waits while a request or an ITSA ask in the thread needs your answer; Defer stays available then, and the ask stays under To answer.',
  when: 'The `thread:ID` world: a tap on a Mail row in the sidebar (MailSide), a mail link, or the next mail after an archive or a reply. On a phone it is the whole pane; its top bar holds Defer and Archive, and on a desktop the tab bar does (see the Main world story).',
  code: ['web/src/views/ThreadView.tsx#ThreadView', 'web/src/views/ThreadView.tsx#ThreadArchive', 'web/src/views/ThreadView.tsx#recipients', 'web/src/mail/ThreadPanel.tsx#ThreadPanel'],
  rules: [
    'A question dialog\'s choice (AskUserQuestion, S-3978) is staged as the answer alone: a tap on its option sends that option as the note, and a reply\'s text or a card comment is not added to it.',
    'A reply that answers a decision also answers the pick blocks left untouched (S-1516): their recommended options are ticked already, so the send adds `Picked **A**, **B** (as suggested).` under the question instead of leaving the block out (`suggestedPicks`), and the preview shows it. A plain typed reply, a permission answer and an ITSA action add none. A block already answered or deferred, a mail between agents, a superseded mail, a single-choice decision and a pick block with nothing recommended are not answered for you.',
    'The reply box takes cc (S-1464): its cc pills suggest agents, threads and ITSAs as you type, a picked agent or thread\'s participants join the thread\'s own recipients, and a picked ITSA has the reply filed on it (see the story "cc pills").',
    'A reply under an ask placed in the thread (S-3827: a permission request that joined a thread it didn\'t start) goes to its asker alone, not to the thread\'s people, who never saw the ask (`replyRecipients`); the daemon seals it like the ask. A placed ask doesn\'t make its asker one of the thread\'s people for later replies either.',
    'Mail between agents (S-1458), not addressed to you, folds to a dimmed "Between agents" row in the thread; it never counts as unread or waiting on you.',
    'Staging is not sending: nothing leaves until Send, a second click on an option takes the answer back, and the preview shows the exact reply (' + ds('Persona rules') + '). A comment typed on a permission card shows in the preview as it is typed (`note:`), and Send sends the comment as it stands then, even when it was typed after Approve (S-3927).',
    'On a desktop the reply is the bottom world\'s prompt input, which this view publishes through `bottom-slot.ts` (staged answers and notes included); on a phone the reply box sits at the foot of the pane while the thread scrolls above it; on a phone the buttons in a request or ask are `--size-hit-touch` tall (' + ds('Density') + ').',
    'A thread that waits on you can\'t be archived: the button is disabled with the reason in its title, not hidden, so the rule is visible (' + ds('State vocabulary') + ').',
    'A failed send puts the text and the staged answers back and says why in place; there is no toast.',
    'A sent reply stays sent (S-3806): the box and its kept draft empty, and only a note typed for permission answers that all turned out answered already comes back to the box.',
    'The pane\'s height is the frame\'s: the thread scrolls above the preview of staged answers.',
  ],
  states: [
    { name: 'A read thread', data: world(T_PLAIN), routes: threadRoutes(T_PLAIN), render: () => view(T_PLAIN) },
    { name: 'Unread mail', data: world(T_UNREAD), routes: threadRoutes(T_UNREAD), render: () => view(T_UNREAD) },
    { name: 'A long thread', data: world(T_LONG), routes: threadRoutes(T_LONG), render: () => view(T_LONG) },
    { name: 'A decision to answer', data: world(T_RICH), routes: threadRoutes(T_RICH), render: () => view(T_RICH) },
    { name: 'A permission request waiting', data: world(T_PERM, { perms: [T_PERM.mails[0].permission!] }), routes: threadRoutes(T_PERM), render: () => view(T_PERM) },
    { name: 'A suggested input waiting', data: world(T_INPUT), routes: threadRoutes(T_INPUT), render: () => view(T_INPUT) },
    { name: 'An ITSA waiting on you', data: world(T_ASK, { agents: AGENTS_STOPPED, attention: [ASK_ITSA], itsas: [ASK_ITSA] }), routes: { ...threadRoutes(T_ASK), ...ASK_ROUTE }, render: () => view(T_ASK) },
    { name: 'Awaiting an answer', data: world(T_AWAIT), routes: threadRoutes(T_AWAIT), render: () => view(T_AWAIT) },
    { name: 'Archived', data: { humanThreads: [], humanArchived: [T_ARCH], itsaStatuses: STATUSES }, routes: threadRoutes(T_ARCH), render: () => view(T_ARCH) },
    { name: 'No one to reply to', data: world(SYSTEM), routes: threadRoutes(SYSTEM), render: () => view(SYSTEM) },
    { name: 'Error', data: world(T_PLAIN), routes: { [`GET /api/threads/${T_PLAIN.thread_id}`]: reply(503, { error: 'fixture: the daemon is unreachable' }) }, render: () => view(T_PLAIN) },
    { name: 'Phone defer and archive buttons', data: world(T_PLAIN, { humanThreads: [T_PLAIN, T_PERM], humanArchived: [T_ARCH], humanDeferred: [T_DEFER] }), render: () => <Row items={[{ label: 'Archive', node: <ThreadArchive tid={T_PLAIN.thread_id} /> }, { label: 'Unarchive', node: <ThreadArchive tid={T_ARCH.thread_id} /> }, { label: 'Held: a request is pending', node: <ThreadArchive tid={T_PERM.thread_id} /> }, { label: 'Undefer', node: <ThreadArchive tid={T_DEFER.thread_id} /> }]} /> },
  ],
}]
