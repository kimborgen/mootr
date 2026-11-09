// Whether a tmux client has an agent's session open, never waiting on tmux (S-4851). The statusline route used to run
// a synchronous `tmux list-clients` per agent every `ttlMs` (about 50 ms under load, S-1025), and its label led the live
// stall lines after S-4794. This answers from the last whole-server list and, once that is `ttlMs` old, starts one
// refresh in the background. Before the first answer, and after a failed one, every session reads as open, as
// hasClients reads a timeout.
export function clientWatch(list: () => Promise<Set<string> | null>, ttlMs: number, now: () => number = Date.now): (id: string) => boolean {
  let open: Set<string> | null = null;
  let at = -Infinity;
  let busy = false;
  return (id) => {
    if (!busy && now() - at >= ttlMs) {
      busy = true;
      at = now();
      list()
        .then((s) => (open = s), () => (open = null))
        .finally(() => (busy = false));
    }
    return open ? open.has(id) : true;
  };
}
