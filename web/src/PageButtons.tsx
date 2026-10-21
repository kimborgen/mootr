// The page icons in the footer (S-1428): Inbox, Work and Agents. Each opens its page through openWorld,
// as the sidebar's tab header does; the active page's icon is pressed. Inbox carries the sidebar Mail header's
// "waiting on you" count, from the same attention list (MailSide's attentionRows).
import { openWorld } from './actions'
import { Icon } from './Icon'
import { attentionRows } from './MailSide'
import * as shell from './shell/layout'
import { useWaiting } from './itsa/WaitingList'
import { useData } from './store'

const PAGES = [
  { world: 'inbox', id: 'open-inbox', label: 'Inbox', icon: 'inbox', title: 'Your mail: the list, and the thread you open beside it' },
  { world: 'work', id: 'open-work', label: 'Work', icon: 'layout-list', title: 'Every open issue, grouped by issue tree' },
  { world: 'agents', id: 'open-agents', label: 'Agents', icon: 'users', title: 'Every agent in its tree, live and stopped' },
] as const
export function PageButtons() {
  shell.useShell()
  const data = useData()
  // The Inbox badge is the sidebar Mail header's "waiting on you", from the same attention list (MailSide's attentionRows).
  const inboxWaiting = attentionRows('inbox', data, useWaiting()).att.length
  const cw = shell.currentWorld()
  return <>{PAGES.map((p) => {
    const on = cw === 'w:' + p.world
    return <button key={p.world} className={'icon-btn page-nav' + (on ? ' on' : '')} id={p.id} title={p.title} aria-label={p.label} aria-current={on ? 'page' : undefined} onClick={() => openWorld(p.world)}>
      <Icon name={p.icon} />{p.world === 'inbox' && inboxWaiting ? <span className="badge warn" title={`${inboxWaiting} waiting on you`}>{inboxWaiting}</span> : null}
    </button>
  })}</>
}
