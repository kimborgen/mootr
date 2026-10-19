// Splits threads into the ones a mailbox deferred and the rest, given the message ids each deferral
// recorded (src/db.ts splitDeferred reads them). Pure, so the web (web/src) tests it too.
import { isSystemNotice } from './mail-notice.ts';

export interface DeferMail {
  id: string;
  from_id?: string | null;
  notice?: number | boolean | null;
  recipients?: { id: string }[];
}

// A thread is deferred while every message sent to the mailbox is one its deferral recorded; a
// system notice doesn't count as new mail (S-1971), so it doesn't bring the thread back. A thread
// in `keep` stays out. `recorded` maps each deferred thread to the message ids its deferral kept.
export function splitDeferredThreads<T extends { thread_id: string; mails: DeferMail[] }>(
  mailbox: string,
  threads: T[],
  recorded: Map<string, Set<string>>,
  keep: Set<string> = new Set(),
): { rest: T[]; deferred: T[] } {
  const isDeferred = (t: T) => {
    const known = recorded.get(t.thread_id);
    if (!known || keep.has(t.thread_id)) return false;
    return t.mails.every((m) => known.has(m.id) || isSystemNotice(m) || !(m.recipients?.some((r) => r.id === mailbox) ?? true));
  };
  return { rest: threads.filter((t) => !isDeferred(t)), deferred: threads.filter(isDeferred) };
}
