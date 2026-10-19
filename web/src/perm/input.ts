// A suggested harness input (S-422): what the human sees and approves. The hash is computed
// here from the text the page renders, never taken from the server, so the daemon can refuse
// an approval whose text changed.
import { api } from '../api'
import type { Permission } from '../types'

export const isInput = (p: Pick<Permission, 'kind'>) => p.kind === 'input'

// SHA-256 of the UTF-8 text, as lowercase hex.
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// Time left until a suggestion expires: "expires in 4 min", "expires in 40 s", or "expired".
export function timeLeft(expiresAt: string | null | undefined, now = Date.now()): string {
  if (!expiresAt) return ''
  const ms = Date.parse(expiresAt) - now
  if (!(ms > 0)) return 'expired'
  const s = Math.ceil(ms / 1000)
  return s >= 90 ? `expires in ${Math.round(s / 60)} min` : `expires in ${s} s`
}

// The status line for a suggestion after an answer or by its own lapse. `outcome` is the
// daemon's answer ('typed', 'held', 'failed' or 'cancelled'); a pending or denied request has no outcome line.
export function inputStatus(p: Pick<Permission, 'status' | 'agent_name'>, outcome?: string | null): string {
  const who = p.agent_name ? `@${p.agent_name}` : 'the agent'
  switch (outcome ?? p.status) {
    case 'typed': return `Typed into ${who}`
    case 'held': return `Held: types when ${who} is idle`
    case 'failed': return `Failed: ${who}'s box didn't show it`
    case 'cancelled': return 'Cancelled: nothing was sent'
    case 'expired': return 'Expired'
    case 'denied': return 'Denied'
    case 'approved': return 'Approved'
    case 'withdrawn': return 'Withdrawn'
    default: return ''
  }
}

// Approves or denies a suggestion. An approval sends the hash of the text the human saw. A
// client_id makes a retry after a lost response get the first answer back, not a 409.
export async function answerInput(p: Permission, text: string, approve: boolean, client_id?: string): Promise<string> {
  return (await answerInputFull(p, text, approve, client_id)).outcome
}

// The text in the agent's input box while it holds the approval, or undefined: the daemon keeps it
// as the held request's note (S-534).
export const heldBox = (p: Pick<Permission, 'status' | 'note'>): string | undefined => (p.status === 'held' && p.note?.startsWith('box:') ? p.note.slice(4) : undefined)

export async function answerInputFull(p: Permission, text: string, approve: boolean, client_id?: string): Promise<{ outcome: string; why?: string }> {
  const body = { ...(approve ? { approve: true, text_sha256: await sha256Hex(text) } : { approve: false }), ...(client_id ? { client_id } : {}) }
  const r = await api<{ outcome?: string; why?: string }>('POST', `/api/permissions/${p.id}/answer`, body)
  return { outcome: r.outcome ?? '', why: r.why }
}
