// The Tailscale addresses of this machine and of the configured peers (the agents' machines), for
// trustedHuman: a request from one of them is an agent's, never the human's. `tailscale status` is
// slow and can stall (S-344), so it runs only in the background (refresh) and a request reads the last
// result (get), which is empty until the first refresh finishes: trustedHuman then refuses, never waits.
export type StatusRunner = () => Promise<string>;

export function agentIpCache(run: StatusRunner, peerNames: () => string[], maxAgeMs = 60_000) {
  let ips = new Set<string>();
  let at = 0;
  let running: Promise<void> | undefined;
  // Asks tailscale and stores the answer; a run still going is joined, never started twice. A failure
  // keeps the last result.
  function refresh(): Promise<void> {
    running ??= (async () => {
      try {
        const s = JSON.parse(await run());
        const names = new Set(peerNames());
        const next = new Set<string>();
        for (const ip of s.Self?.TailscaleIPs ?? []) next.add(ip);
        for (const n of Object.values<any>(s.Peer ?? {})) {
          const host = [String(n.HostName ?? '').toLowerCase(), String(n.DNSName ?? '').toLowerCase().split('.')[0]];
          if (host.some((h) => names.has(h)) || (n.TailscaleIPs ?? []).some((ip: string) => names.has(ip))) for (const ip of n.TailscaleIPs ?? []) next.add(ip);
        }
        ips = next;
      } catch {}
      at = Date.now();
    })().finally(() => {
      running = undefined;
    });
    return running;
  }
  // A pure read; an old result starts a background refresh and is returned as it is.
  function get(): Set<string> {
    if (Date.now() - at >= maxAgeMs) void refresh();
    return ips;
  }
  return { refresh, get };
}
