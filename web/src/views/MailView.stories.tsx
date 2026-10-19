import { MailView } from './MailView'
import { ds, pending, reply, type Story } from '../stories/types'
import { Pane, T_ASK, T_LONG, T_PERM_DONE, T_PLAIN, T_UNREAD, T_WITHDRAWN } from '../stories/mailFixtures'
import { useEffect, useRef } from 'react'
import type { Thread } from '../types'

const view = (owner: string) => <Pane height={480}><MailView owner={owner} viewKey={'mail:' + owner} /></Pane>
const THREADS: Thread[] = [T_UNREAD, T_ASK, T_PLAIN, T_LONG, T_PERM_DONE, T_WITHDRAWN]
const route = (owner: string, ts: Thread[]) => ({ [`GET /api/agents/${owner}/threads`]: ts })
// Taps the first thread as soon as the list has drawn (the rows come after the fetch), as a reader would.
function Opened({ owner }: { owner: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current!
    const tap = () => { const row = el.querySelector<HTMLElement>('.thread-item'); if (row) { row.click(); return true } return false }
    if (tap()) return
    const mo = new MutationObserver(() => { if (tap()) mo.disconnect() })
    mo.observe(el, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])
  return <div ref={ref}>{view(owner)}</div>
}

export const stories: Story[] = [{
  name: 'Agent inbox',
  group: 'Mail',
  what: 'An agent\'s mailbox as a tab of its world: its threads on the left (who is in them, the subject, a snippet of the last message, the count and the age) and one thread on the right in the thread panel. It is read only: reading a thread here leaves it unread for the agent, and "Open to reply" opens the full thread world, where the reply box is. The human\'s own inbox (`mail:human`) is the same view, with its own header line.',
  when: 'The Mail tab of an agent\'s world (view key `mail:ID`), and `mail:human` for everything agents sent you. It loads `GET /api/agents/ID/threads` and reloads when mail changes. On a phone it shows the list first and the thread after a tap, with Inbox to go back (a container query at 640 px).',
  code: ['web/src/views/MailView.tsx#MailView', 'web/src/mail/ThreadPanel.tsx#ThreadPanel'],
  rules: [
    'A thread row is a header line, a subject and a two-line snippet; unread is a dot plus semibold, never colour alone (' + ds('State vocabulary') + ').',
    'The list and the thread share the pane by container width (`@container`, 640 px), not by viewport, so a narrow split pane on a desktop behaves like a phone: list first, thread after a tap, Inbox to go back.',
    'Viewing never marks mail read (an agent\'s mail is the agent\'s), and the reply box is absent: it only links to the thread world.',
    'Empty and error text is plain muted prose in the pane, no illustration (' + ds('Empty, loading, and error') + '). Until the first list lands it shows the loading mark (`Loading`), never "No mail yet." about mail not yet fetched.',
  ],
  states: [
    { name: 'An agent\'s inbox', routes: route('fx-dev', THREADS), render: () => view('fx-dev') },
    { name: 'A thread open', routes: route('fx-dev', THREADS), render: () => <Opened owner="fx-dev" /> },
    { name: 'The human\'s inbox', routes: route('human', THREADS), render: () => view('human') },
    { name: 'A Codex agent\'s inbox', routes: route('fx-review', [T_PLAIN, T_UNREAD]), render: () => view('fx-review') },
    { name: 'Loading', routes: { 'GET /api/agents/fx-dev/threads': pending() }, render: () => view('fx-dev') },
    { name: 'No mail yet', routes: route('fx-dev', []), render: () => view('fx-dev') },
    { name: 'Error', routes: { 'GET /api/agents/fx-dev/threads': reply(503, { error: 'fixture: the daemon is unreachable' }) }, render: () => view('fx-dev') },
  ],
}]
