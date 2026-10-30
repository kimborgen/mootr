import { SwipeView } from './SwipeView'
import { ds, type Story } from '../stories/types'
import { ALL_THREADS, ASK_ITSA, DECISION, mail, Pane, STATUSES, T_ASK, T_K_BLOCKER, T_K_DECISION, T_K_DONE, T_K_GENERAL, T_PLAIN, T_UNREAD, threadRoutes } from '../stories/mailFixtures'
import type { Data } from '../store'
import { humanRowsOf } from './thread-index'
import type { Thread } from '../types'

const view = () => <Pane height={560}><SwipeView /></Pane>
const lists = (threads: Thread[], o: Partial<Data> = {}): Partial<Data> => ({ humanRows: humanRowsOf(threads), itsaStatuses: STATUSES, ...o })
// The inbox, and the thread reads its top cards make (S-4616).
const inbox = (threads: Thread[], o: Partial<Data> = {}) => ({ data: lists(threads, o), routes: threadRoutes(...threads) })
// Many threads, a long body on top: the stack at a realistic scale.
const BODY = 'The nightly build ran every suite on both machines and all of them passed. '.repeat(30)
const MANY: Thread[] = Array.from({ length: 40 }, (_, i) => ({ thread_id: 'fx-sw-' + i, mails: [mail('fm-sw-' + i, 'fx-sw-' + i, ['fx-dev', 'fx-review', 'fx-ops', 'fx-cos'][i % 4], ['human'], i === 0 ? '' : `Fixture thread number ${i}`, i === 0 ? BODY : 'Body.', { min: 3 + i * 40, read: i > 5 })] }))

const BLOCKER: Thread = { thread_id: 'fx-sw-blocker', mails: [{ ...mail('fm-sw-blocker', 'fx-sw-blocker', 'fx-dev', ['human'], 'Deploy is stuck', 'The deploy waits on a secret only you have; nothing else can run until it is set.', { min: 1 }), verdict: { follows: true, score: 1, concise: null, fluff: null, value: null, kind: 'blocker', at: '2026-10-15T09:00:00Z' } }] }

export const stories: Story[] = [{
  name: 'Swipe view',
  group: 'Mail',
  what: 'Your inbox as a stack of mail cards, newest on top: the threads the Mail list holds (to you, not archived, not deferred). Pull the top card left to archive its thread, right to leave it (it goes to the back; nothing changes on the server), up to defer it; tap it to open the thread. The card follows the finger, the action it would fire shows where the card leaves, and a pull short of the threshold springs back. The buttons and keys do the same: ← archive, → leave, ↑ defer, Enter opens, z undoes the last one, which the bar names with an Undo button. A thread that waits on your answer refuses archive as the inbox does, and the card stays; it can still be deferred, and its ask stays under To answer. Archiving a Decision or Blocker card asks first: the card springs back and a bar ("Archive this blocker?" with Cancel and Archive) takes the buttons\' place; Archive, Enter or ← confirms, Cancel or Escape keeps the card. Defer, leave, open and other card kinds never ask. The stack is the inbox\'s rows; a card\'s whole thread is read as it reaches the top two, and again when its row says a new mail came, so a card shows loading until then and no key acts on it.',
  when: 'The `w:swipe` world: the Swipe entry in the Mail list\'s switches, or `#view=swipe`. Archiving or deferring a thread opened from it comes back to it, on the next card.',
  code: ['web/src/mail/SwipeView.tsx#SwipeView', 'web/src/mail/swipeCard.ts#dragCard', 'web/src/mail/swipeCard.ts#releaseAction', 'web/src/mail/swipeCard.ts#stackOrder', 'web/src/actions.tsx#openFromSwipe'],
  rules: [
    'The card tracks the pointer 1:1; only the release moves on its own: a fly-off on `--duration-base` with `--ease-in` (an exit), a spring back on `--duration-slow` with `--ease-out`. Reduced motion zeroes both (' + ds('Motion') + ').',
    'The hints appear only while the card is pulled (calm at rest): muted while pointed at, `--accent-text` once lifting fires, `--status-warning-fg` with "Answer first" on the archive hint when the thread waits on you (' + ds('First principle: Calm at rest; instruments on approach') + ').',
    'A dragged or flying card takes `--shadow-float`, as a drag ghost does; at rest it lies flat (' + ds('Shadow assignment') + ').',
    'Key hints sit in the buttons as muted text, never boxed keycaps; on a phone the buttons are `--size-hit-touch` tall and a line says how to swipe (' + ds('Tooltips') + ').',
    'The card on top stays there until you act on it: new mail goes under it, so a key or tap never acts on a thread you haven\'t seen. The keys act only when nothing else on the page has focus for them (the agent tree keeps its arrows); the view takes focus each time it comes on screen, unless you are typing, so the keys work at once.',
    'The confirm bar replaces the action buttons in place so the card never moves; its question is `--status-warning-fg`, its buttons are `--size-hit-touch` tall on a phone and Archive is the one primary action (' + ds('Persona rules') + '). Only decision and blocker cards ask; the kind comes from `cardKind`. Each kind has its own band, icon and left edge on the card (S-1312, see the mail card story).',
    'No toast for what has a place: the last action and its Undo sit in the bar; a refusal uses the one transient notice bar (' + ds('Persona rules') + ').',
  ],
  states: [
    { name: 'A stack of cards', ...inbox([T_UNREAD, T_PLAIN, ...ALL_THREADS.filter((t) => t !== T_UNREAD && t !== T_PLAIN && t !== T_ASK)], { decisions: [DECISION] }), render: view },
    { name: 'A blocker card (archive asks first)', ...inbox([BLOCKER, T_PLAIN]), render: view },
    { name: 'A decision card', ...inbox([T_K_DECISION, T_PLAIN]), render: view },
    { name: 'A blocker card, labelled sections', ...inbox([T_K_BLOCKER, T_PLAIN]), render: view },
    { name: 'A done card', ...inbox([T_K_DONE, T_PLAIN]), render: view },
    { name: 'A general card', ...inbox([T_K_GENERAL, T_PLAIN]), render: view },
    { name: 'A thread waiting on you', ...inbox([T_ASK, T_PLAIN], { attention: [ASK_ITSA], itsas: [ASK_ITSA as never] }), render: view },
    { name: 'Many threads, long body', ...inbox(MANY), render: view },
    { name: 'Loading', data: { humanRows: humanRowsOf(), loaded: { agents: true, mail: false, itsas: true } }, render: view },
    { name: 'The top card\'s thread still loading', data: lists([T_PLAIN, T_UNREAD]), render: view },
    { name: 'Empty', ...inbox([]), render: view },
  ],
}]
