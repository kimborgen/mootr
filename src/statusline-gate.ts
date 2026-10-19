// Every Claude Code status-line refresh POSTs to the daemon, from every agent, several times a
// second, and the handler re-reads the transcript and writes the usage tables (S-2126). Most
// refreshes change nothing the daemon records. This gate decides per agent whether a report is
// worth processing: a report whose relevant fields (transcript, context size, cost, rate limits)
// equal the last processed one's, inside SAME_MS, is skipped; any other is processed at once.
// Nothing is held or reordered, so a change is never delayed or lost.
export const SAME_MS = 10_000;

interface Slot {
  key: string;
  at: number;
}

// The fields onStatusLine and the usage tables read from a Claude Code payload.
export function relevantKey(body: any): string {
  return JSON.stringify([body?.transcript_path, body?.context_window?.context_window_size, body?.context_window?.current_usage, body?.cost?.total_cost_usd, body?.rate_limits]);
}

export function createStatuslineGate(process: (slot: string, body: unknown) => void) {
  const slots = new Map<string, Slot>();
  let sweptAt = 0;
  return {
    // Returns true when `process` ran; false when the report was skipped as unchanged.
    submit(slot: string, body: unknown, now = Date.now()): boolean {
      // Slots older than SAME_MS can't skip anything: drop them, so archived agents don't leak.
      if (now - sweptAt >= SAME_MS) {
        sweptAt = now;
        for (const [k, v] of slots) if (now - v.at >= SAME_MS) slots.delete(k);
      }
      const key = relevantKey(body);
      const last = slots.get(slot);
      if (last && last.key === key && now - last.at < SAME_MS) return false;
      slots.set(slot, { key, at: now });
      try {
        process(slot, body);
      } catch (e) {
        slots.delete(slot);
        throw e;
      }
      return true;
    },
    // Processes a report at once, for a harness whose payload the gate's key doesn't describe.
    run: process,
    size: () => slots.size,
  };
}
