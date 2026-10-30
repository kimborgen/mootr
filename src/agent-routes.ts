// The auth decision for every per-agent route, `/api/agents/:id/...` (S-1900). Each route in src/daemon.ts
// has one entry here, and test/agent-routes.test.mjs fails when a route has none, or an entry has no route.
// The gate that runs `mayActAs` before a request is relayed (the `acting` match) and the OpenCode server's
// path-names-its-agent exemption (resolveActors) are both built from this table, so they can't drift (S-1833, S-1842).
//
// `auth` is who may reach the route besides the human, the shared token, the owner and peers:
//   acting  the agent itself, its ancestors, the chief of staff and the assistant: `mayActAs` at the gate
//   self    only the agent itself, checked in the handler
//   by      an agent naming itself (`by`), its parents, or the assistant; the handler's rule
//   tree    an agent in the caller's own tree or an ancestor's tree (usage-scope.ts), checked in the handler
//   human   nobody else: the human as `trustedHuman` or the web UI's `human` proves it, checked in the handler
//   peer    nobody else: a peer's daemon, acting for itself
//   open    every agent token, for the reason given
export type AgentAuth = 'acting' | 'self' | 'by' | 'tree' | 'human' | 'peer' | 'open';

export interface AgentRoute {
  method: 'GET' | 'POST' | 'PUT';
  // The regex source after the agent id, as the route's literal writes it (`\/files`, `` for the agent itself).
  path: string;
  auth: AgentAuth;
  // The OpenCode server's request names its agent in the path, so it needs no `by`, `from` or `self` in the body
  // (resolveActors). Defaults to true for `acting` routes. The route's guard must then check the agent.
  opencodeNamed?: boolean;
  why: string;
}

export const AGENT_ROUTES: AgentRoute[] = [
  { method: 'GET', path: '', auth: 'open', why: 'the same row, waits included, that GET /api/agents lists for every token; find_agents and stam show, wait and attach read it' },
  { method: 'GET', path: String.raw`\/files`, auth: 'acting', why: "the agent's generated files: its system prompt and harness settings" },
  { method: 'GET', path: String.raw`\/instructions`, auth: 'acting', why: 'everything the agent receives' },
  { method: 'GET', path: String.raw`\/inventory`, auth: 'acting', why: "the agent's prompt, split into blocks" },
  { method: 'GET', path: String.raw`\/inbox`, auth: 'acting', why: "the agent's mail" },
  { method: 'GET', path: String.raw`\/threads`, auth: 'acting', why: "the agent's mail threads" },
  { method: 'GET', path: String.raw`\/thread-index`, auth: 'acting', why: "the agent's mail threads as index rows, a page at a time (S-4520)" },
  { method: 'POST', path: String.raw`\/threads\/([\w-]+)\/(archive|unarchive|defer|undefer)`, auth: 'acting', why: "changes the agent's mail threads" },
  { method: 'POST', path: String.raw`\/threads\/([\w-]+)\/unread`, auth: 'human', why: "the human marks its mail in a thread unread again (checked in the handler)" },
  { method: 'POST', path: String.raw`\/read`, auth: 'acting', why: "marks the agent's mail read" },
  { method: 'GET', path: String.raw`\/view`, auth: 'acting', why: "the agent's conversation, live" },
  { method: 'GET', path: String.raw`\/view\/history`, auth: 'acting', why: "the agent's conversation history" },
  { method: 'GET', path: String.raw`\/view\/tools`, auth: 'acting', why: 'the tool calls before a mail the agent sent' },
  { method: 'POST', path: String.raw`\/view\/prompt`, auth: 'human', why: "sends to the agent's view as the human (humanOnly)" },
  { method: 'POST', path: String.raw`\/view\/interrupt`, auth: 'human', why: "interrupts the agent from its view (humanOnly)" },
  { method: 'POST', path: String.raw`\/view\/permission`, auth: 'human', why: 'answers permissions from the view (humanOnly)' },
  { method: 'GET', path: String.raw`\/stream`, auth: 'acting', why: "the agent's live event stream" },
  { method: 'POST', path: String.raw`\/permission-mode`, auth: 'human', why: "sets the agent's permission mode" },
  { method: 'POST', path: String.raw`\/prompt`, auth: 'human', why: "types into the agent's terminal as the human" },
  { method: 'POST', path: String.raw`\/(pause|unpause|shutdown|archive|resume|restart|reconnect-mcp|compact|adopt|set-visibility|set-child-notices|set-parent|rename|chief-of-staff|kill|forget)`, auth: 'by', why: 'an agent controls itself and its children; set-parent, rename, chief-of-staff, kill and forget are the human and the assistant only' },
  { method: 'PUT', path: String.raw`\/default-view`, auth: 'human', why: "the human's view preference" },
  { method: 'GET', path: String.raw`\/events`, auth: 'acting', why: "the agent's event log" },
  { method: 'GET', path: String.raw`\/usage`, auth: 'tree', why: "usage-scope.ts: the caller's own tree and its ancestors' trees" },
  { method: 'GET', path: String.raw`\/waits`, auth: 'open', why: "coordination data between one user's agents; the open agent rows and find_agents list the same waits (policy: cos, md905671; revisit for multi-user, S-1887)" },
  // mayManageWaits reads a missing `by` as the human, so the OpenCode server must name its agent in the body.
  { method: 'POST', path: String.raw`\/waits`, auth: 'acting', opencodeNamed: false, why: "adds a wait; mayManageWaits also checks `by`" },
  { method: 'POST', path: String.raw`\/notice`, auth: 'peer', why: "a peer's daemon queues a notice for its own agent" },
  { method: 'POST', path: String.raw`\/retro-final`, auth: 'self', why: 'the handler requires by to be the agent' },
  { method: 'POST', path: String.raw`\/waits\/clear`, auth: 'acting', why: "clears the agent's waits; mayManageWaits also checks `by`" },
  { method: 'POST', path: String.raw`\/waits\/declared`, auth: 'acting', why: "declares a wait for a reply or an event (wait_for); mayManageWaits also checks `by`" },
  { method: 'POST', path: String.raw`\/waits\/wake`, auth: 'acting', why: "schedules a timer for the agent (wake_me); mayManageWaits also checks `by`" },
  { method: 'POST', path: String.raw`\/waits\/done`, auth: 'acting', why: "clears one of the agent's declared or timer waits (wait_done); mayManageWaits also checks `by`" },
  { method: 'POST', path: String.raw`\/workspace-share`, auth: 'self', opencodeNamed: true, why: 'the handler runs mayActAs self-only: no one shares a workspace for another agent' },
];

// The match of a request whose agent in the path `mayActAs` checks before the request is relayed (group 1 is the agent),
// or null.
const GATED = AGENT_ROUTES.filter((r) => r.auth === 'acting').map((r) => ({ method: r.method, re: new RegExp(String.raw`^\/api\/agents\/([\w-]+)${r.path}$`) }));
export function matchActing(method: string, pathname: string): RegExpExecArray | null {
  for (const g of GATED) {
    const hit = g.method === method ? g.re.exec(pathname) : null;
    if (hit) return hit;
  }
  return null;
}

// Whether the request is to a route that names its agent in the path, where the OpenCode server's request needs no
// `by` in its body (resolveActors).
const NAMED = AGENT_ROUTES.filter((r) => r.opencodeNamed ?? r.auth === 'acting').map((r) => ({ method: r.method, re: new RegExp(String.raw`^\/api\/agents\/[\w-]+${r.path}$`) }));
export const opencodeNamesAgent = (method: string, pathname: string): boolean => NAMED.some((n) => n.method === method && n.re.test(pathname));
