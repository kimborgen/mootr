// Whether a mail is a system notice (S-1971): mail stam sends on its own behalf or a local script
// sends (`notice`, set from from_stam or system: watch events and ITSA comments stam posts for a
// subscription), or mail from a `system:NAME` sender such as the deploy watcher. A notice doesn't
// revive a thread someone deferred; mail from a person or an agent does. The server (src/db.ts)
// and the web (web/src) share this one predicate, so they can't drift.
export function isSystemNotice(m: { from_id?: string | null; notice?: number | boolean | null }): boolean {
  return Boolean(m.notice) || (m.from_id ?? '').startsWith('system:');
}
