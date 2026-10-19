// Per-socket tickets (S-742): a browser can't send a header on a WebSocket, and a session token in the URL leaks
// through history and logs. The page asks an authenticated route for a ticket, then opens the socket with
// `?ticket=`. A ticket is random, kept only as a hash in memory, good once, for 30 seconds, and only for the
// socket kind and path it was issued for. It remembers whether the request that bought it was trustedHuman.
import { createHash, randomBytes } from 'node:crypto';

export const TICKET_TTL_MS = 30_000;
export const TICKET_KINDS = ['tty'] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
export type Redeemed = { trusted: boolean };

const tickets = new Map<string, { kind: TicketKind; path: string; trusted: boolean; expires: number }>();
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

export function issueTicket(kind: TicketKind, path: string, trusted: boolean, now = Date.now()): { ticket: string; expires: number } {
  for (const [h, t] of tickets) if (t.expires <= now) tickets.delete(h);
  const ticket = randomBytes(24).toString('base64url');
  const expires = now + TICKET_TTL_MS;
  tickets.set(hash(ticket), { kind, path, trusted, expires });
  return { ticket, expires };
}

// Spends the ticket whatever the outcome: a ticket tried for the wrong kind or path is gone.
export function redeemTicket(ticket: string | null | undefined, kind: TicketKind, path: string, now = Date.now()): Redeemed | undefined {
  if (!ticket) return undefined;
  const h = hash(ticket);
  const t = tickets.get(h);
  if (!t) return undefined;
  tickets.delete(h);
  return t.expires > now && t.kind === kind && t.path === path ? { trusted: t.trusted } : undefined;
}

export function clearTickets(): void {
  tickets.clear();
}
