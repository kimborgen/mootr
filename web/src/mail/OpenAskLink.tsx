// The link from an agent or an ITSA to the open ask it waits on (S-3977): "Open ask", in the waiting tone. It goes straight to
// the ask's card, with no hop through the Needs you list: an ITSA ask to the ITSA's page (its Waiting-on-you card), any other
// ask to its home thread (the mail card). The link is shown only while the ask's row is open in the list the store holds, so
// it goes when the ask settles, is withdrawn or superseded. It is a button, so it takes focus and Enter like any control.
import { selectAgent, selectThread } from '../actions'
import { Icon } from '../Icon'
import { openItsa } from '../itsa/itsa'
import { getData } from '../store'
import type { Ask } from '../types'
import { askKindLabel } from './needsYou'

// The open row of an ask key in the list (default: the store's), or none: no row, no link.
export const openAskRow = (key: string | null | undefined, asks: Ask[] = getData().asks): Ask | undefined =>
  key ? asks.find((a) => a.key === key && a.state === 'open') : undefined

// The link to an open row's card. Its title says the kind and that the human owes it (never the request's text: the card holds that).
export function OpenAskLink({ row, className }: { row: Ask; className?: string }) {
  const go = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    if (row.kind === 'itsa' && row.itsa_id) openItsa(row.itsa_id)
    else if (row.thread_id) selectThread(row.thread_id)
    else if (row.agent_id) selectAgent(row.agent_id)
  }
  return <button type="button" className={`open-ask${className ? ` ${className}` : ''}`} data-open-ask={row.key} title={`${askKindLabel(row)} · waiting on you`} onClick={go}>
    <Icon name="user" size="xs" />Open ask</button>
}
