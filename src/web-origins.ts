// The web UI on a peer writes shared settings, agent types and the global instructions straight to
// the settings home (S-414): the browser sends them to the home's own web URL, so the home's
// trustedHuman check (tailscale serve) proves the human made them. No daemon relays them, because
// agents hold every peer token. This file says which browser origins the home answers that way.
//
// A peer's UI is served at its daemon's URL (the peer's `url` in the home's settings) or through
// `tailscale serve` on its tailnet name. Those origins come from the home's own settings and from
// tailscale, never from a request or a peer's answer, so an agent can't add one. A page any of them
// serves runs as the human anyway on its own machine.
import { execFileSync } from 'node:child_process';
import { testOnlyEnv } from './test-env.ts';

// The cross-origin writes a peer's UI may make on the home, and nothing else.
export const PEER_UI_ROUTES: [string, RegExp][] = [
  ['PATCH', /^\/api\/config\/settings$/],
  ['POST', /^\/api\/config\/instructions$/],
  ['POST', /^\/api\/types\/[\w-]+$/],
  ['DELETE', /^\/api\/types\/[\w-]+$/],
];
// The human's writes on a machine other than the one the page came from (S-544, C3b): the browser sends them
// straight to the machine that holds the agent, permission request or ITSA, at its serve origin, and that
// machine's trustedHuman check proves the human made them. Any daemon answers them, not just the settings home.
export const PEER_UI_HUMAN_ROUTES: [string, RegExp][] = [
  ['POST', /^\/api\/permissions\/[\w-]+\/answer$/],
  ['POST', /^\/api\/itsas\/[\w-]+\/(act|post)$/],
  ['PATCH', /^\/api\/itsas\/[\w-]+$/],
  ['POST', /^\/api\/agents\/[\w-]+\/(pause|unpause|shutdown|archive|resume|restart|reconnect-mcp|compact|adopt|set-visibility|set-child-notices|set-parent|rename|chief-of-staff|kill|forget|prompt|permission-mode)$/],
];
export const peerUiHumanRoute = (method: string, path: string): boolean => PEER_UI_HUMAN_ROUTES.some(([m, re]) => m === method && re.test(path));
export const peerUiRoute = (method: string, path: string): boolean => PEER_UI_ROUTES.some(([m, re]) => m === method && re.test(path));

// An origin as a browser sends it: scheme, host and port only, lower case, no default port.
export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

interface Node {
  DNSName?: string;
  HostName?: string;
  TailscaleIPs?: string[];
}
let nodes: { at: number; list: Node[] } | null = null;
function tailnetNodes(): Node[] {
  if (nodes && Date.now() - nodes.at < 60_000) return nodes.list;
  let list: Node[] = [];
  try {
    const s = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 3000 }));
    // Only this tailnet's own nodes: a node shared in from another tailnet could share a short name.
    const suffix = String(s.Self?.DNSName ?? '').toLowerCase().replace(/\.$/, '').split('.').slice(1).join('.');
    list = Object.values((s.Peer ?? {}) as Record<string, Node>).filter((n) => suffix && (n.DNSName ?? '').toLowerCase().replace(/\.$/, '').endsWith('.' + suffix));
  } catch {}
  nodes = { at: Date.now(), list };
  return list;
}

// The names a peer's machine has on the tailnet: its full MagicDNS name, its short name, and its
// addresses, found by the host in its stam `url`. None when tailscale doesn't know it.
export function tailnetNames(host: string, list: Node[] = tailnetNodes()): string[] {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  for (const n of list) {
    const fqdn = (n.DNSName ?? '').toLowerCase().replace(/\.$/, '');
    const short = fqdn.split('.')[0] ?? '';
    const ips = (n.TailscaleIPs ?? []).map((x) => x.toLowerCase());
    if (h && (h === fqdn || h === short || ips.includes(h))) return [fqdn, short, ...ips].filter(Boolean);
  }
  return [];
}

// The origins a peer's UI can have: its daemon URL's own origin, that port on each of its tailnet
// names, and HTTPS on its full tailnet name (`stam web serve`).
export function peerUiOrigins(peerUrls: string[], list?: Node[]): Set<string> {
  const out = new Set<string>();
  for (const raw of peerUrls) {
    const own = originOf(raw);
    if (!own) continue;
    out.add(own);
    const u = new URL(own);
    const names = tailnetNames(u.hostname, list);
    for (const n of names) {
      const host = n.includes(':') ? `[${n}]` : n;
      out.add(`${u.protocol}//${host}${u.port ? ':' + u.port : ''}`);
    }
    if (names[0]) out.add(`https://${names[0]}`);
  }
  return out;
}

// The origin Kim's browser reaches a peer's UI at (`stam web serve`): HTTPS on its full tailnet name, and none
// when tailscale doesn't know the peer, since an http://host:port address is no proof of the human (the web then
// says to open stam on that machine). Only a test daemon, with the test key set, names the peer's own daemon URL.
// A human write for that peer's agent goes there (S-544).
export function peerServeOrigin(peerUrl: string): string | undefined {
  const own = originOf(peerUrl);
  if (!own) return undefined;
  const name = tailnetNames(new URL(own).hostname)[0];
  if (name) return `https://${name}`;
  return testOnlyEnv('STAM_TEST_HUMAN_KEY') ? own : undefined;
}
