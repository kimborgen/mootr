// What a mail thread's tab reads of a thread (S-4579), for the thread index's rows: built from the thread's mails,
// oldest first, as web/src/mail/thread-chips.ts builds it from whole threads.

export type TabLink = { id: string; key: string; title: string; status: string };
type TabMail = { from_id: string; recipients: { id: string }[]; agents?: string[]; itsas?: TabLink[] };

// The thread's agents as web threadAgents orders them, the human left out: those attached to its mail, then its
// senders and then its recipients, each newest mail first, once each.
export function threadAgents(ms: TabMail[]): string[] {
  const out = new Set<string>();
  const add = (id: string) => { if (id !== 'human') out.add(id); };
  const latest = [...ms].reverse();
  ms.flatMap((m) => m.agents ?? []).forEach(add);
  latest.forEach((m) => add(m.from_id));
  latest.forEach((m) => m.recipients.forEach((r) => add(r.id)));
  return [...out];
}

// The ITSAs the thread's mail links to, once each, in the order they first appear (web threadItsas).
export function itsaLinks(ms: TabMail[]): TabLink[] {
  const links = new Map<string, TabLink>();
  for (const m of ms) for (const l of m.itsas ?? []) if (!links.has(l.id)) links.set(l.id, { id: l.id, key: l.key, title: l.title, status: l.status });
  return [...links.values()];
}
