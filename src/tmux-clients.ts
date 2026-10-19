// Whether a tmux client has an agent's session open, asked at most once per `ttlMs` per agent.
// A statusline refresh asks on every call, and each ask is a synchronous tmux spawn on the event
// loop (about 50 ms under load, S-1025), so a burst of refreshes stalls every hook behind it.
// A client that attaches or detaches is seen within `ttlMs`, which the statusline's cache TTL
// already tolerates.
export function clientCache(check: (id: string) => boolean, ttlMs: number, now: () => number = Date.now): (id: string) => boolean {
  const seen = new Map<string, { at: number; value: boolean }>();
  return (id) => {
    const t = now();
    const hit = seen.get(id);
    if (hit && t - hit.at < ttlMs) return hit.value;
    const value = check(id);
    seen.set(id, { at: t, value });
    return value;
  };
}
