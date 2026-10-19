import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { STAM_HOME, MACHINE } from './config.ts';
import * as events from './events.ts';
import { namedKeys } from './itsa-keys.ts';
import { timed } from './stall.ts';
import { isSystemNotice } from './mail-notice.ts';
import { splitDeferredThreads } from './defer-split.ts';

export type Lifecycle = 'active' | 'paused' | 'shut_down' | 'archived';
export type Activity = 'starting' | 'working' | 'waiting' | 'blocked' | 'errored' | 'idle' | 'unknown';
// The activity detail of an agent whose harness ended its session (S-384): it is 'unknown' until a
// new session starts or the daemon shuts it down.
export const SESSION_ENDED = 'session ended';
// The activities that count as stam work for the STAM_HOME/busy file (daemon.ts): an agent
// waiting for a reply or a timer is busy too, so an idle-shutdown machine stays up for it.
// usage_samples and window_readings older than this are pruned (usage.ts), so nothing older
// than now minus it can be counted on to be there.
export const SAMPLE_RETENTION_MS = 35 * 86_400_000;

export const BUSY_ACTIVITIES: readonly Activity[] = ['starting', 'working', 'waiting', 'blocked'];

export interface Agent {
  id: string;
  name: string;
  role: string;
  machine: string;
  harness: string;
  model: string | null;
  effort: string | null;
  cwd: string;
  parent_id: string | null;
  session_id: string | null;
  transcript_path: string | null;
  lifecycle: Lifecycle;
  activity: Activity;
  activity_detail: string | null;
  context_tokens: number | null;
  context_window: number | null;
  // JSON: how the workspace was made, so archive can clean it up. See workspace.ts.
  workspace: string | null;
  // The agent's personal workspace folder (S-894): an absolute path under STAM_HOME/workspaces,
  // or null. Separate from `workspace` above, never a git worktree, and kept by archive.
  personal_workspace: string | null;
  // 1 when the agent is a long-lived specialist (S-894), 0 otherwise. Stored and returned;
  // a later release acts on it (pausing a standing agent when it has no work).
  standing: number;
  // JSON: an action waiting for the agent to go idle, such as a restart. See lifecycle.ts.
  pending_action: string | null;
  idle_since: string | null;
  // The idle_since value a tree-idle notice was last announced for, so a daemon restart
  // neither loses nor repeats one. See org.ts.
  idle_notified: string | null;
  // Highest context threshold already announced: 0 none, 1 warning, 2 instruction, 3 enforcement.
  context_level: number;
  tokens_after_compaction: number | null;
  // JSON from registry.capabilitiesFor at spawn.
  capabilities: string | null;
  // 'auto' (default) or 'bypass'; only the human sets it, from the web UI.
  permission_mode: string;
  // JSON: who a child may reach, set by its parent. See org.ts.
  visibility: string | null;
  // How much this agent hears about its children's finished turns: 'turn', 'tree-idle',
  // or 'none'. Null follows settings.childNotices. See org.ts.
  child_notices: string | null;
  // The agent's last message at the end of its latest turn, when the harness reports it.
  last_message: string | null;
  // The prompt the agent was spawned with, kept for the Instructions view.
  first_prompt: string | null;
  // JSON: the harness's last cumulative cost and token report, the baseline for usage.ts.
  usage_last: string | null;
  // 'assistant' for the human's executive assistant; null for other agents.
  kind: string | null;
  // The agent type it was spawned as (see agent-types.ts), or null.
  type: string | null;
  // JSON array: who holds a pause on the agent, 'human' or the ids of agents that paused
  // it (itself, a parent, the assistant). Null or empty while only stam's cost blockers
  // hold it, which stam lifts when they clear; stam never lifts a pause someone owns.
  // See lifecycle.ts and blockers.ts.
  paused_by: string | null;
  // The successor's id once cost_switch moved this agent's work to it: mail to this agent
  // goes there instead. See cost-switch.ts.
  forwarded_to: string | null;
  // sha256 of the agent's launch token (agent-token.ts); the token itself is never stored.
  token_hash: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT '',
  machine TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  cwd TEXT NOT NULL,
  parent_id TEXT,
  session_id TEXT,
  transcript_path TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'active',
  activity TEXT NOT NULL DEFAULT 'starting',
  activity_detail TEXT,
  context_tokens INTEGER,
  context_window INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, id);
CREATE INDEX IF NOT EXISTS events_agent_type ON events(agent_id, type);
CREATE TABLE IF NOT EXISTS mail (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  from_name TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mail_recipients (
  mail_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  read_at TEXT,
  pushed_at TEXT,
  PRIMARY KEY (mail_id, agent_id)
);
-- The unread rows of one agent: the hook path counts them on every tool call (inTurnNotice, unreadCount),
-- and the primary key leads with mail_id, so without this every count scanned the whole table (S-1025).
CREATE INDEX IF NOT EXISTS mail_recipients_unread ON mail_recipients (agent_id) WHERE read_at IS NULL;
-- The rows an agent read, by time: the tool-call slice finds the mail read inside a page's range (mailReadIn, S-1844).
CREATE INDEX IF NOT EXISTS mail_recipients_read ON mail_recipients (agent_id, read_at) WHERE read_at IS NOT NULL;
-- The ITSAs a mail is linked to (S-986): what the sender named (itsa), keys written in its subject or
-- body (named), and the ITSA whose thread it is in (thread). Links are not mail: no recipient, no
-- notice, no unread state. One row per mail and ITSA, the first source in that order winning.
CREATE TABLE IF NOT EXISTS mail_itsas (
  mail_id TEXT NOT NULL,
  itsa_id TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (mail_id, itsa_id)
);
-- Threads a spawner opened whole to the agent it spawned by citing them in its brief (S-1107).
CREATE TABLE IF NOT EXISTS thread_readers (
  thread_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, agent_id)
);
CREATE INDEX IF NOT EXISTS mail_itsas_itsa ON mail_itsas(itsa_id);
-- The agents attached to a mail (S-1305), as ITSAs are: a link, not mail. No recipient, notice or unread state.
CREATE TABLE IF NOT EXISTS mail_agents (
  mail_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  PRIMARY KEY (mail_id, agent_id)
);
-- An agent's mail to the human that holds a decision block, until the human replies in its thread
-- (src/decision-mail.ts). The attention list reads it, so it never scans mail.
CREATE TABLE IF NOT EXISTS decision_mails (
  mail_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_mails_thread ON decision_mails (thread_id);
-- A thread the human deferred: their latest mail in it answers only with deferrals (src/decision-mail.ts).
-- Its ask or decision mail stays open but leaves the waiting list. A mail from anyone else clears it (S-353).
CREATE TABLE IF NOT EXISTS thread_deferred (
  thread_id TEXT PRIMARY KEY,
  mail_id TEXT NOT NULL
);
-- A thread the human unarchived (S-637): the auto-archive pass leaves it alone while it holds no mail
-- to them from others beyond these ids (JSON), the ones it had then. A new such mail lets the pass in again.
CREATE TABLE IF NOT EXISTS thread_kept_open (
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mail_ids TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id)
);
-- The threads auto-archive (S-637) archived for a mailbox, so its repair can tell them from the ones the human archived.
CREATE TABLE IF NOT EXISTS thread_auto_archived (
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id)
);
-- Mail a read_mail batch handed to an agent, owed until a batch that holds it is acknowledged
-- (readMail, ackDelivered, defaultRead): a read whose reply never reached the client loses nothing.
CREATE TABLE IF NOT EXISTS mail_deliveries (
  agent_id TEXT NOT NULL,
  mail_id TEXT NOT NULL,
  batch TEXT NOT NULL,
  PRIMARY KEY (agent_id, mail_id, batch)
);
CREATE INDEX IF NOT EXISTS mail_deliveries_agent ON mail_deliveries (agent_id, mail_id);
CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_by TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
-- The pending requests of one agent: the startup's decision-mail read checks each decision mail against them
-- (decisionMails), a scan of every request per mail without this, so startup grew with each request (S-1025).
CREATE INDEX IF NOT EXISTS permission_requests_pending ON permission_requests (agent_id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS agent_parents (
  child_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  PRIMARY KEY (child_id, parent_id)
);
CREATE INDEX IF NOT EXISTS agent_parents_parent ON agent_parents (parent_id);
CREATE INDEX IF NOT EXISTS agents_parent ON agents (parent_id);
CREATE TABLE IF NOT EXISTS rings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  topic TEXT NOT NULL,
  members TEXT NOT NULL,
  moderator_id TEXT,
  moderator_decides INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 1,
  turn INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  note TEXT,
  result TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ring_submissions (
  ring_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  text TEXT NOT NULL,
  agree INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ring_id, round, agent_id)
);
CREATE TABLE IF NOT EXISTS usage (
  agent_id TEXT NOT NULL,
  day TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  -- The cost account the agent billed to; '' when it is unmanaged. Part of the key, so a
  -- mid-day account change splits the day instead of moving it. See accounts.ts.
  account TEXT NOT NULL DEFAULT '',
  cost_usd REAL NOT NULL DEFAULT 0,
  -- tokens_in is uncached input only; tokens_out includes reasoning tokens.
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  -- Paid estimate for a Claude account with paid: true: the growth in statusline cost while
  -- a reported window reads 100% (docs/cost-policy.md, build step 3). Never billed by stam.
  paid_estimate_usd REAL NOT NULL DEFAULT 0,
  -- OpenRouter accounts: cost reported since the last reconciliation against /credits
  -- (src/reconcile.ts), which scales cost_usd to billed dollars and zeroes this.
  unreconciled_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day, account)
);
-- One row: the OpenRouter ledger's reconciliation state (src/reconcile.ts).
CREATE TABLE IF NOT EXISTS ledger_recon (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  billed_used REAL,
  carry REAL NOT NULL DEFAULT 0,
  exact_pending REAL NOT NULL DEFAULT 0
);
-- Per-agent usage per 5-minute bucket, beside the daily table, so a later step can split a
-- window's percentage change among the agents that ran in that interval (docs/cost-policy.md,
-- build step 6). model is part of the key, so a mid-bucket model change splits the bucket.
CREATE TABLE IF NOT EXISTS usage_samples (
  agent_id TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  harness TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  -- The UTC start of the 5-minute bucket, an ISO string.
  bucket TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, bucket, account, model)
);
CREATE TABLE IF NOT EXISTS subscriptions (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- A window reading kept over time: one row per change in a window's percentage or reset
-- time, so the interval between two rows is a percentage change to attribute (build step 6).
CREATE TABLE IF NOT EXISTS window_readings (
  name TEXT NOT NULL,
  window TEXT NOT NULL,
  at TEXT NOT NULL,
  used_percentage REAL,
  resets_at INTEGER
);
CREATE INDEX IF NOT EXISTS window_readings_lookup ON window_readings(name, window, at);
CREATE TABLE IF NOT EXISTS attachments (
  mail_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (mail_id, name)
);
-- Why stam keeps an agent paused for cost: one row per blocker, each with its own clear
-- condition. See blockers.ts and docs/cost-policy.md.
CREATE TABLE IF NOT EXISTS blockers (
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- The account, or budget scope, it applies to; '' when none (taken-over).
  account TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  since TEXT NOT NULL,
  -- JSON: what clears it, such as {"resets_at": "..."}.
  clear TEXT,
  PRIMARY KEY (agent_id, kind, account)
);
-- A limit error held its account until the time the message named; the hold outlives the
-- agent that hit it, so a spawn after the agent died still sees it. See rules.ts.
CREATE TABLE IF NOT EXISTS account_holds (
  account TEXT PRIMARY KEY,
  resets_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  since TEXT NOT NULL
);
-- A browser's Web Push subscription: one row per device that turned notifications on.
-- kinds is a JSON list of what pushes to it ('mail', 'permission').
CREATE TABLE IF NOT EXISTS push_devices (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT NOT NULL,
  origin TEXT,
  kinds TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS thread_archive (
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id)
);
CREATE TABLE IF NOT EXISTS thread_archive_mail (
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mail_id TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id, mail_id)
);
-- A thread set aside for later (S-976): like thread_archive, it stays deferred only while it holds no
-- mail to the mailbox beyond the recorded ones. A thread is archived or deferred, never both.
-- Not thread_deferred, which marks a decision answered "Decide later" (S-353).
CREATE TABLE IF NOT EXISTS thread_defer (
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id)
);
CREATE TABLE IF NOT EXISTS thread_defer_mail (
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mail_id TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id, mail_id)
);
CREATE TABLE IF NOT EXISTS itsas (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  parent_id TEXT,
  kind TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  body TEXT,
  status TEXT NOT NULL,
  owner TEXT,
  thread_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS itsas_parent ON itsas(parent_id);
CREATE TABLE IF NOT EXISTS itsa_participants (
  itsa_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  PRIMARY KEY (itsa_id, agent_id)
);
CREATE TABLE IF NOT EXISTS itsa_links (
  itsa_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  system TEXT NOT NULL,
  external_id TEXT,
  url TEXT NOT NULL,
  PRIMARY KEY (itsa_id, n)
);
CREATE TABLE IF NOT EXISTS itsa_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  itsa_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT,
  type TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS itsa_events_itsa ON itsa_events(itsa_id, id);
-- ITSA fields (S-364): shared column definitions and the value each ITSA holds per field.
-- options is the choice list as JSON; value is JSON, validated against the type in itsa.ts.
CREATE TABLE IF NOT EXISTS itsa_fields (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  options TEXT,
  description TEXT,
  hint TEXT,
  width TEXT NOT NULL,
  align TEXT NOT NULL,
  card TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS itsa_field_values (
  itsa_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (itsa_id, field_id)
);
-- One counter for readable ITSA keys, independent of the display prefix (S-, TEAM-S-),
-- so a prefix that contains a hyphen can't make allocations collide.
CREATE TABLE IF NOT EXISTS itsa_pending_unown (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  how TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS itsa_counter (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
-- What an agent whose turn ended still waits for; any open wait makes it 'waiting'.
-- See syncWaits.
CREATE TABLE IF NOT EXISTS waits (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  -- children, human, agent, timer, job, ...: open-ended, so new sources need no migration.
  kind TEXT NOT NULL,
  -- The agent, request, or job waited on; null when none.
  target TEXT,
  detail TEXT,
  since TEXT NOT NULL,
  until TEXT,
  -- 'stam' (stam saw it), 'hook' (a harness reported it), or 'declared' (the agent said so).
  source TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS waits_agent ON waits (agent_id);
-- Events from external services (GitHub, Linear, Slack), handed to watch.ingest by the
-- sources: normalized, deduped by dedupe_key, and matched against event_subscriptions.
-- Separate from the events table, which is stam's per-agent activity log. See src/watch.ts.
CREATE TABLE IF NOT EXISTS ext_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  subjects TEXT NOT NULL DEFAULT '[]',
  actor TEXT,
  url TEXT,
  summary TEXT NOT NULL,
  payload TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ext_events_created ON ext_events(created_at);
-- Who wants to hear about external events: an agent, an ITSA, or the human, with a JSON
-- filter of source, subject globs, type globs, and actors. Named event_subscriptions, not
-- subscriptions, which already holds cost-account window readings (usage.ts). See src/watch.ts.
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id TEXT PRIMARY KEY,
  subscriber_kind TEXT NOT NULL,
  subscriber_id TEXT NOT NULL,
  filter TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  note TEXT,
  expires_at INTEGER,
  -- The latest mail of a human subscriber's thread, so later deliveries reply into it.
  last_mail_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_subscriptions_subscriber ON event_subscriptions(subscriber_kind, subscriber_id);
-- What a poller last saw for one watched subject (src/sources/github.ts): a JSON snapshot to
-- diff the next poll against, and the ETags of its requests, so unchanged ones 304. The
-- subject is the key, such as github:OWNER/REPO#12.
-- Which view the human's web UI opens an agent in (S-82): 'terminal' or 'conversation'.
-- Kept by the daemon the browser reaches, for its own agents and its peers' alike.
CREATE TABLE IF NOT EXISTS agent_views (
  agent_id TEXT PRIMARY KEY,
  view TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Workspace shares (S-896): the owner's personal workspace folder, the agent it is shared with,
-- 'read' or 'write', who granted it and when. One row per (folder, grantee).
CREATE TABLE IF NOT EXISTS workspace_grants (
  workspace TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  access TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (workspace, grantee_id)
);
CREATE TABLE IF NOT EXISTS watch_state (
  subject TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT '{}',
  etags TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
-- One embedding per source item (S-141): source is what was embedded (mail first), ref its id,
-- hash the embedded text, and model the embedder that made vec. A row from another model is stale.
CREATE TABLE IF NOT EXISTS embeddings (
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, ref)
);
-- The start of each indexed agent turn's text (S-1460), shown as a suggestion's snippet; the
-- vector itself is in embeddings under source 'turn', ref AGENT_ID:TURN_ID.
CREATE TABLE IF NOT EXISTS turn_snippets (
  ref TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  snippet TEXT NOT NULL
);
-- expireTurns finds the old turns by time on every turn end.
CREATE INDEX IF NOT EXISTS turn_snippets_at ON turn_snippets(at);
-- Each agent's timeline (S-210, src/activity.ts): one row per tool call (use to result),
-- assistant text block, stretch of model time, or gap between turns, read from its transcript.
-- start and "end" are ISO times; name is the tool, or the gap's trigger; summary is at most 300
-- characters of the tool input or text, never tool output; wait_kind is a key of the wait tree;
-- raw_cost_usd is the item's share of its message at API prices; est_cost_usd is raw scaled so
-- the agent's day sums to its usage rows.
-- category, category_source, and confidence stay null until classification fills them.
CREATE TABLE IF NOT EXISTS activity_items (
  agent_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  start TEXT NOT NULL,
  "end" TEXT NOT NULL,
  summary TEXT,
  wait_kind TEXT,
  raw_cost_usd REAL NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  category_source TEXT,
  confidence REAL,
  PRIMARY KEY (agent_id, seq)
);
CREATE INDEX IF NOT EXISTS activity_items_start ON activity_items(agent_id, start);
-- The window read (src/activity-stats.ts): items overlapping [since, now] by start and end.
CREATE INDEX IF NOT EXISTS activity_items_time ON activity_items(start, "end");
-- How far each agent's transcript has been read into activity_items: the file, a byte offset
-- at a turn boundary, and the reader's state there (JSON).
CREATE TABLE IF NOT EXISTS activity_cursors (
  agent_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  offset INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
-- Agents on other machines this daemon has seen, so mail to one still reaches its peer's
-- outbox when that peer doesn't answer (S-235).
CREATE TABLE IF NOT EXISTS peer_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  machine TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  lifecycle TEXT
);
-- Mail for a peer that didn't answer: the exact body its POST /api/mail takes, redelivered by
-- the daemon (src/mail.ts deliverOutbox). mail_id is the same id the peer stores it under.
CREATE TABLE IF NOT EXISTS peer_outbox (
  mail_id TEXT NOT NULL,
  peer TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (mail_id, peer)
);
CREATE INDEX IF NOT EXISTS peer_outbox_peer ON peer_outbox (peer, created_at);
-- A short automatic summary of an instruction text block, cached by the sha256 of its text
-- (src/block-summaries.ts, S-878): one row per distinct text, with the model that made it.
CREATE TABLE IF NOT EXISTS block_summaries (
  hash TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- A tool call's two-field summary (src/tool-summaries.ts, S-1481), keyed by the agent, the call's
-- own id and the sha256 of its name and input. A row is replaced only when its config_hash (the model
-- and prompt it was asked with, S-1843) differs; a request with another input doesn't read (or fix) this row.
CREATE TABLE IF NOT EXISTS tool_summaries (
  agent_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  tool TEXT NOT NULL,
  doing TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, call_id, input_hash)
);
-- A tool's human-readable label (src/tool-names.ts, S-1933), one per (harness, tool name), made once by
-- the summaries tiny model and kept; the built-in tools are seeded in code and have no row.
CREATE TABLE IF NOT EXISTS tool_names (
  harness TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (harness, name)
);
-- One row per one-off data migration that has run (runOnce below).
CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY,
  done_at TEXT NOT NULL
);
-- Small durable state the daemon keeps across restarts, one JSON value per key (S-253).
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db: DatabaseSync | undefined;

// Fills mail_itsas for mail stored before it existed (S-986), once. Bounded: the sender-named and
// thread links come from two set-based statements; keys named in text are read from the newest
// BACKFILL_NAMED_MAILS mails only, so a large database starts fast.
const BACKFILL_NAMED_MAILS = 5000;
export function backfillMailItsas(d: DatabaseSync): void {
  if (d.prepare("SELECT 1 FROM migrations WHERE name = 'mail-itsas-backfill'").get()) return;
  d.exec('BEGIN');
  try {
    d.exec("INSERT OR IGNORE INTO mail_itsas (mail_id, itsa_id, source) SELECT m.id, i.id, 'itsa' FROM mail m JOIN itsas i ON i.id = m.about_itsa OR i.id = m.itsa_id");
    const ids = new Map((d.prepare('SELECT key, id FROM itsas').all() as { key: string; id: string }[]).map((r) => [r.key, r.id]));
    const ins = d.prepare("INSERT OR IGNORE INTO mail_itsas (mail_id, itsa_id, source) VALUES (?, ?, 'named')");
    if (ids.size)
      for (const r of d.prepare('SELECT id, subject, body FROM mail ORDER BY rowid DESC LIMIT ?').all(BACKFILL_NAMED_MAILS) as { id: string; subject: string; body: string }[])
        for (const k of namedKeys(`${r.subject}\n${r.body}`).slice(0, MAX_NAMED_KEYS)) if (ids.has(k)) ins.run(r.id, ids.get(k)!);
    d.exec("INSERT OR IGNORE INTO mail_itsas (mail_id, itsa_id, source) SELECT m.id, i.id, 'thread' FROM itsas i JOIN mail m ON m.thread_id = i.thread_id WHERE i.thread_id IS NOT NULL");
    d.prepare('INSERT INTO migrations (name, done_at) VALUES (?, ?)').run('mail-itsas-backfill', new Date().toISOString());
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// Keys named in one mail beyond this many are not linked: a pasted list isn't a set of topics.
export const MAX_NAMED_KEYS = 10;

// Runs a one-off data migration once: its name is recorded in `migrations` after it runs.
function runOnce(name: string, sql: string) {
  if (!db) throw new Error('db not open');
  if (db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) return;
  db.exec(sql);
  db.prepare('INSERT INTO migrations (name, done_at) VALUES (?, ?)').run(name, new Date().toISOString());
}

// Keeps a copy of the open database at STAM_HOME/NAME before a migration, unless one is already
// there. VACUUM INTO reads through this connection: copying stam.db with another file descriptor
// and closing it would drop this process's POSIX locks on the file (S-453), letting another
// connection checkpoint or delete the WAL under us. A copy that fails is removed and throws.
function keepCopy(conn: DatabaseSync, name: string, before: string): void {
  const file = join(STAM_HOME, name);
  if (existsSync(file)) return;
  try {
    conn.prepare('VACUUM INTO ?').run(file);
  } catch (e) {
    // A copy cut short (a full disk, say) would pass for a good one on the next start.
    rmSync(file, { force: true });
    throw new Error(`can't keep a copy of stam.db before ${before}: ${e instanceof Error ? e.message : e}`);
  }
}

export function open(): DatabaseSync {
  if (db) return db;
  mkdirSync(STAM_HOME, { recursive: true });
  db = new DatabaseSync(join(STAM_HOME, 'stam.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  // Every hook and statusline write is its own commit. With the default FULL, each commit fsyncs
  // the WAL, about 1 ms on an idle disk and far more under load (S-1025), which stalls the event
  // loop. NORMAL fsyncs only at checkpoints: a power loss can drop the last few commits, but the
  // database stays consistent.
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  // Columns added after the first release; ALTER fails harmlessly when they exist.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN from_name TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE peer_agents ADD COLUMN lifecycle TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE peer_agents ADD COLUMN parents TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE peer_agents ADD COLUMN busy INTEGER');
  } catch {}
  try {
    db.exec('ALTER TABLE peer_agents ADD COLUMN busy_at TEXT');
  } catch {}
  for (const col of ['workspace TEXT', 'personal_workspace TEXT', 'standing INTEGER NOT NULL DEFAULT 0', 'pending_action TEXT', 'idle_since TEXT', 'context_level INTEGER NOT NULL DEFAULT 0', 'tokens_after_compaction INTEGER', 'capabilities TEXT', "permission_mode TEXT NOT NULL DEFAULT 'auto'", 'visibility TEXT', 'child_notices TEXT', 'last_message TEXT', 'usage_last TEXT', 'kind TEXT', 'first_prompt TEXT', 'type TEXT', 'forwarded_to TEXT', 'token_hash TEXT']) {
    try {
      db.exec(`ALTER TABLE agents ADD COLUMN ${col}`);
    } catch {}
  }
  for (const col of ['tokens_cache_read INTEGER NOT NULL DEFAULT 0', 'tokens_cache_write INTEGER NOT NULL DEFAULT 0', 'account TEXT']) {
    try {
      db.exec(`ALTER TABLE usage ADD COLUMN ${col}`);
    } catch {}
  }
  migrateUsageKey(db);
  // The paid-estimate column arrived after account joined the usage key, so add it after the
  // rebuild above (which would otherwise drop it). Fresh databases get it from SCHEMA.
  try {
    db.exec('ALTER TABLE usage ADD COLUMN paid_estimate_usd REAL NOT NULL DEFAULT 0');
  } catch {}
  try {
    db.exec('ALTER TABLE usage ADD COLUMN unreconciled_usd REAL NOT NULL DEFAULT 0');
  } catch {}
  // Tree-idle notices became durable. Agents already idle when this column appears were
  // announced under the old per-turn behaviour, so mark their current idle period done
  // rather than re-announcing every one of them on the first start after the update.
  try {
    db.exec('ALTER TABLE agents ADD COLUMN idle_notified TEXT');
    db.exec('UPDATE agents SET idle_notified = idle_since WHERE idle_since IS NOT NULL');
  } catch {}
  // Pauses gained an owner. Every pause before this was the human's or an agent's, never
  // stam's, so existing paused agents keep a pause stam won't lift.
  try {
    db.exec('ALTER TABLE agents ADD COLUMN paused_by TEXT');
    db.exec(`UPDATE agents SET paused_by = '["human"]' WHERE lifecycle = 'paused'`);
  } catch {}
  // Threads: a reply names the mail it answers and shares its thread.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN thread_id TEXT');
    db.exec('ALTER TABLE mail ADD COLUMN reply_to TEXT');
    backfillThreads(db);
  } catch {}
  db.exec('CREATE INDEX IF NOT EXISTS mail_thread ON mail (thread_id)');
  // A permission request is a mail that carries the request.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN permission_id TEXT');
    db.exec("UPDATE mail SET permission_id = substr(subject, 20, instr(substr(subject, 20), ':') - 1) WHERE subject LIKE 'Permission request p%:%'");
  } catch {}
  // The daemon joined the mail to a thread by guessing; the UI shows it, and the
  // sending agent can tell the guess apart from a reply_to it named.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN auto_threaded INTEGER NOT NULL DEFAULT 0');
  } catch {}
  // Mail stam sent on its own behalf, or a local script sent (S-717): an automatic notice, not a
  // colleague's mail. The auto-read sweep may settle these. Backfilled from the shapes we know.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN notice INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE mail SET notice = 1 WHERE from_id LIKE 'system:%' OR subject LIKE '[stam]%'");
  } catch {}
  // ITSA comments and updates are mail in the ITSA's thread: they carry the ITSA, a kind
  // (comment or update), and for updates a health. A recipient's copy is quiet when the
  // mail shouldn't interrupt a working agent (it arrives with the idle batch instead).
  for (const col of ['itsa_id TEXT', 'kind TEXT', 'health TEXT']) {
    try {
      db.exec(`ALTER TABLE mail ADD COLUMN ${col}`);
    } catch {}
  }
  // A branch link's review, tests, and screenshots, and its repo (S-40): JSON, null for others.
  try { db.exec('ALTER TABLE itsa_links ADD COLUMN meta TEXT'); } catch {}
  // One-off data migrations, each run once and recorded in `migrations`.
  migrateSystemCalls(db);
  // Monitor waits on a job or a condition, so its rule-labelled time is wait.poll, not self.schedule-wait (S-244).
  runOnce('activity-monitor-wait-poll', "UPDATE activity_items SET category = 'wait.poll' WHERE category_source = 'rule' AND name = 'Monitor' AND category = 'self.schedule-wait'");
  // The ITSA a mail is about (S-91): named by the sender (`send_mail` `itsa`), or the ITSA of
  // the thread it is in. Separate from itsa_id, which makes a reply a comment on the ITSA.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN about_itsa TEXT');
    db.exec('UPDATE mail SET about_itsa = itsa_id WHERE itsa_id IS NOT NULL');
  } catch {}
  db.exec('CREATE INDEX IF NOT EXISTS mail_about_itsa ON mail(about_itsa) WHERE about_itsa IS NOT NULL');
  backfillMailItsas(db);
  // A ring member's PR verdict (S-1824): approve or request_changes, null outside a PR review.
  try {
    db.exec('ALTER TABLE ring_submissions ADD COLUMN verdict TEXT');
  } catch {}
  // The decision model's verdict on a mail to the human (src/mail-check.ts): JSON, null
  // until a check has run. Added after the first release, so older mails stay null.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN verdict TEXT');
  } catch {}
  // Why the sender overrode the mail gate (S-983): the reason an agent gave to send a mail the
  // decision model had failed. Null on every other mail.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN override TEXT');
  } catch {}
  // A 1-3 word title a cheap model gave the mail (src/mail-title.ts), null when titles are off
  // or the call failed.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN title TEXT');
  } catch {}
  // The hash of the model and prompt a block summary was asked with (src/block-summaries.ts, S-1684);
  // null for a row from before the column, which is asked again once.
  try {
    db.exec('ALTER TABLE block_summaries ADD COLUMN config_hash TEXT');
  } catch {}
  // The same for a tool call's summary (src/tool-summaries.ts, S-1843): null for a row from before
  // the column, which counts as stale and is asked again when shown.
  try {
    db.exec('ALTER TABLE tool_summaries ADD COLUMN config_hash TEXT');
  } catch {}
  // The hash of the model and prompt a mail's title was asked with (src/mail-title.ts, S-1843).
  try {
    db.exec('ALTER TABLE mail ADD COLUMN title_config TEXT');
  } catch {}
  // A one-line summary the same model gave a mail to the human, for the swipe cards (S-1001).
  try {
    db.exec('ALTER TABLE mail ADD COLUMN summary TEXT');
  } catch {}
  try {
    db.exec('ALTER TABLE mail_recipients ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0');
  } catch {}
  // The mail that superseded this one (S-1304): set by its sender; the mail stays in its thread.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN superseded_by TEXT');
  } catch {}
  // A system note for the recipient (S-1462): read_mail shows it after the body; the sender's own copy shows only that it exists.
  try {
    db.exec('ALTER TABLE mail ADD COLUMN note TEXT');
  } catch {}
  // Mail withdrawn from the human once someone else settled it (src/withdraw.ts): when, by whom,
  // and the line the thread shows. Each missing column is added on its own, so a partial earlier run
  // finishes; the first time any is added, a copy of the database is kept, and a copy that fails
  // stops the migration (an earlier copy already there is kept as it is).
  {
    const have = new Set((db.prepare('PRAGMA table_info(mail_recipients)').all() as { name: string }[]).map((c) => c.name));
    const need = ['withdrawn_at', 'withdrawn_by', 'withdrawn_note'].filter((c) => !have.has(c));
    if (need.length) {
      keepCopy(db, 'stam.db.pre-withdraw', 'adding the withdrawn columns');
      for (const col of need) db.exec(`ALTER TABLE mail_recipients ADD COLUMN ${col} TEXT`);
    }
  }
  // An ITSA's place in its board column, set by dragging; unranked ones sort by creation.
  try {
    db.exec('ALTER TABLE itsas ADD COLUMN rank REAL');
  } catch {}
  // A request stam made for a harness dialog on the agent's screen (permissions.ts,
  // dialogShown): its answer is typed into the dialog.
  try {
    db.exec('ALTER TABLE permission_requests ADD COLUMN dialog INTEGER NOT NULL DEFAULT 0');
  } catch {}
  // What an approved request does (S-362): a JSON payload only stam reads, never shown to agents.
  try {
    db.exec('ALTER TABLE permission_requests ADD COLUMN payload TEXT');
  } catch {}
  // Suggested harness input (S-422): kind 'input' carries the exact text, its sha256, when it expires,
// and the agent's harness session when the human approved it (it is typed into that session only).
  for (const col of ["kind TEXT NOT NULL DEFAULT 'request'", 'text TEXT', 'sha256 TEXT', 'expires_at TEXT', 'session_id TEXT'])
    try {
      db.exec(`ALTER TABLE permission_requests ADD COLUMN ${col}`);
    } catch {}
  db.exec("UPDATE permission_requests SET kind = CASE WHEN dialog = 1 THEN 'dialog' ELSE 'settings' END WHERE kind = 'request' AND (dialog = 1 OR payload IS NOT NULL)");
  // Who may decide the request (S-432): 'human' (only the human approves) or 'delegate' (the parent
  // or the chief of staff decides, and may escalate it to the human). Older rows were the human's.
  // The column is added only if missing, and the first time a copy of the database is kept; a copy
  // that fails stops the migration (an earlier copy already there is kept as it is).
  if (!(db.prepare('PRAGMA table_info(permission_requests)').all() as { name: string }[]).some((c) => c.name === 'audience')) {
    keepCopy(db, 'stam.db.pre-audience', 'adding the audience column');
    db.exec("ALTER TABLE permission_requests ADD COLUMN audience TEXT NOT NULL DEFAULT 'human'");
  }
  // Requests from agents forgotten before forgetAgent withdrew them.
  db.exec("UPDATE permission_requests SET status = 'withdrawn' WHERE status = 'pending' AND agent_id NOT IN (SELECT id FROM agents)");
  // Mail text search (search.ts) uses FTS5 when the SQLite build has it, which node:sqlite
  // does; a build without it falls back to LIKE. The index follows `mail` through triggers,
  // and is built once from the rows already there when the table first appears.
  try {
    const had = !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'mail_fts'").get();
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(subject, body, content='mail', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS mail_ai AFTER INSERT ON mail BEGIN INSERT INTO mail_fts(rowid, subject, body) VALUES (new.rowid, new.subject, new.body); END;
      CREATE TRIGGER IF NOT EXISTS mail_ad AFTER DELETE ON mail BEGIN INSERT INTO mail_fts(mail_fts, rowid, subject, body) VALUES ('delete', old.rowid, old.subject, old.body); END;
      CREATE TRIGGER IF NOT EXISTS mail_au AFTER UPDATE ON mail BEGIN
        INSERT INTO mail_fts(mail_fts, rowid, subject, body) VALUES ('delete', old.rowid, old.subject, old.body);
        INSERT INTO mail_fts(rowid, subject, body) VALUES (new.rowid, new.subject, new.body); END;
    `);
    if (!had) db.exec("INSERT INTO mail_fts(mail_fts) VALUES ('rebuild')");
    fts5Mail = true;
  } catch {
    fts5Mail = false;
  }
  return db;
}

// Whether mail search can use FTS5 (set in open()).
let fts5Mail = false;

// An FTS5 MATCH expression from free text: each word as a quoted prefix, so punctuation and
// FTS operators in a search box can't be read as query syntax. Empty when there is no word.
function ftsQuery(q: string): string {
  return (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map((t) => `"${t}"*`).join(' ');
}

const now = () => new Date().toISOString();

// Stam's own model calls moved from the agents' `openrouter` account to `openrouter-system` (S-1077).
// A day that already has both rows (a version that wrote the new account, then a restore or rollback)
// would break the key (agent_id, day, account), so each such openrouter row is folded into the
// system row first. One transaction: it either all happens and is recorded, or nothing does.
export function migrateSystemCalls(d: DatabaseSync): void {
  const name = 'stam-calls-to-system-account';
  if (d.prepare('SELECT 1 FROM migrations WHERE name = ?').get(name)) return;
  d.exec('BEGIN');
  try {
    d.exec(`UPDATE usage SET
        cost_usd = usage.cost_usd + o.cost_usd, tokens_in = usage.tokens_in + o.tokens_in, tokens_out = usage.tokens_out + o.tokens_out,
        tokens_cache_read = usage.tokens_cache_read + o.tokens_cache_read, tokens_cache_write = usage.tokens_cache_write + o.tokens_cache_write,
        paid_estimate_usd = usage.paid_estimate_usd + o.paid_estimate_usd, unreconciled_usd = usage.unreconciled_usd + o.unreconciled_usd
      FROM (SELECT * FROM usage WHERE agent_id = 'stam' AND account = 'openrouter') AS o
      WHERE usage.agent_id = 'stam' AND usage.account = 'openrouter-system' AND usage.day = o.day`);
    d.exec(`DELETE FROM usage WHERE agent_id = 'stam' AND account = 'openrouter'
      AND day IN (SELECT day FROM usage WHERE agent_id = 'stam' AND account = 'openrouter-system')`);
    d.exec("UPDATE usage SET account = 'openrouter-system' WHERE agent_id = 'stam' AND account = 'openrouter'");
    d.prepare('INSERT INTO migrations (name, done_at) VALUES (?, ?)').run(name, new Date().toISOString());
    d.exec('COMMIT');
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// usage gained account in its key: an agent's day now splits by account instead of the whole
// day moving when its account changes. Rebuild the table once, mapping old rows to the
// unmanaged account '' so their totals stay the same.
function migrateUsageKey(d: DatabaseSync): void {
  const cols = d.prepare('PRAGMA table_info(usage)').all() as { name: string; pk: number }[];
  if (!cols.length || cols.some((c) => c.name === 'account' && c.pk > 0)) return;
  d.exec(`
    CREATE TABLE usage_new (
      agent_id TEXT NOT NULL,
      day TEXT NOT NULL,
      harness TEXT NOT NULL,
      model TEXT,
      account TEXT NOT NULL DEFAULT '',
      cost_usd REAL NOT NULL DEFAULT 0,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, day, account)
    );
    INSERT INTO usage_new (agent_id, day, harness, model, account, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write)
      SELECT agent_id, day, harness, model, COALESCE(account, ''), cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write FROM usage;
    DROP TABLE usage;
    ALTER TABLE usage_new RENAME TO usage;
  `);
}

// Mail from before threads: a "Re: X" reply joins the latest earlier mail about X that
// its sender received; everything else starts its own thread.
function backfillThreads(d: DatabaseSync): void {
  const rows = d.prepare('SELECT id, from_id, subject, created_at FROM mail ORDER BY created_at').all() as { id: string; from_id: string; subject: string; created_at: string }[];
  const set = d.prepare('UPDATE mail SET thread_id = ?, reply_to = ? WHERE id = ?');
  const thread = new Map<string, string>();
  for (const m of rows) {
    const base = m.subject.replace(/^(re:\s*)+/i, '');
    const parent = base !== m.subject
      ? (d
          .prepare(
            `SELECT m.id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
             WHERE r.agent_id = ? AND m.created_at < ? AND (m.subject = ? OR m.subject = ?) ORDER BY m.created_at DESC LIMIT 1`,
          )
          .get(m.from_id, m.created_at, base, 'Re: ' + base) as { id: string } | undefined)
      : undefined;
    const t = parent ? (thread.get(parent.id) ?? parent.id) : m.id;
    thread.set(m.id, t);
    set.run(t, parent?.id ?? null, m.id);
  }
}

// Short global ids such as "a7k3f"; names are the human-readable aliases. An id is unique across
// machines too (S-577): a fresh one an agent here, or one remembered from a peer, already has is
// redrawn, so two machines' agents never share an id. `draw` is the byte source, for tests.
export function newAgentId(draw: () => Buffer = () => randomBytes(4)): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  for (;;) {
    const id = 'a' + [...draw()].map((b) => alphabet[b % alphabet.length]).join('');
    if (!agentIdTaken(id)) return id;
  }
}

// Whether an agent here, or one remembered from a peer, already has this id (S-577).
function agentIdTaken(id: string): boolean {
  const d = open();
  if (d.prepare('SELECT 1 FROM agents WHERE id = ?').get(id)) return true;
  return Boolean(d.prepare('SELECT 1 FROM peer_agents WHERE id = ?').get(id));
}

export function createAgent(a: Pick<Agent, 'id' | 'name' | 'role' | 'machine' | 'harness' | 'model' | 'effort' | 'cwd' | 'parent_id' | 'session_id'>): Agent {
  const t = now();
  open()
    .prepare(
      `INSERT INTO agents (id, name, role, machine, harness, model, effort, cwd, parent_id, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(a.id, a.name, a.role, a.machine, a.harness, a.model, a.effort, a.cwd, a.parent_id, a.session_id, t, t);
  events.emitEvent('agent.spawned', { id: a.id, name: a.name, parent_id: a.parent_id });
  agentTextChanged(a.id);
  return getAgent(a.id)!;
}

// Looks an agent up by id or by name.
export function getAgent(ref: string): Agent | undefined {
  return open().prepare('SELECT * FROM agents WHERE id = ? OR name = ?').get(ref, ref) as Agent | undefined;
}

// The agent whose launch token hashes to this (agent-token.ts, S-237).
export function agentByTokenHash(hash: string): Agent | undefined {
  return open().prepare('SELECT * FROM agents WHERE token_hash = ?').get(hash) as Agent | undefined;
}

export function setTokenHash(id: string, hash: string): void {
  open().prepare('UPDATE agents SET token_hash = ? WHERE id = ?').run(hash, id);
}

// Where mail to this agent goes: itself, or the last successor in its cost_switch chain.
export function forwardTarget(id: string): string {
  const seen = new Set<string>();
  let cur = getAgent(id);
  while (cur?.forwarded_to && !seen.has(cur.id)) {
    seen.add(cur.id);
    const next = getAgent(cur.forwarded_to);
    // An archived successor gave the work back: mail stops here.
    if (!next || next.lifecycle === 'archived') break;
    cur = next;
  }
  return cur?.id ?? id;
}

// Runs fn in one transaction: everything it writes commits together, or nothing does. fn
// must not await.
export function transaction<T>(fn: () => T): T {
  const d = open();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

export function listAgents(): Agent[] {
  return open().prepare('SELECT * FROM agents ORDER BY created_at').all() as unknown as Agent[];
}

// Every agent's id, spawning parent and activity, without the rest of its row: what org.syncChildrenWaits reads on
// each activity change (S-1739), where listAgents' full rows were most of its cost.
export function agentLinks(): Pick<Agent, 'id' | 'parent_id' | 'activity'>[] {
  return open().prepare('SELECT id, parent_id, activity FROM agents').all() as unknown as Pick<Agent, 'id' | 'parent_id' | 'activity'>[];
}

// An agent cost blockers and their notices belong to: a live one. An archived or shut-down
// agent gets no blocker and its manager hears nothing; a finished agent needs no replacement.
export function isLive(a: { lifecycle: string }): boolean {
  return a.lifecycle === 'active' || a.lifecycle === 'paused';
}

// Observers of activity changes, such as org.ts telling parents about blockers.
// `requested` holds the fields as the caller passed them, before open waits turned an
// 'idle' into 'waiting'.
type ActivityObserver = (before: Agent, after: Agent, requested: Partial<Agent>) => void;
const observers: ActivityObserver[] = [];
export function onActivityChange(fn: ActivityObserver): void {
  observers.push(fn);
}

// Told when an agent's lifecycle changes (active to shut_down, and so on), which an activity
// observer misses when activity stays the same (unknown to unknown on shutdown).
type LifecycleObserver = (before: Agent, after: Agent) => void;
const lifecycleObservers: LifecycleObserver[] = [];
export function onLifecycleChange(fn: LifecycleObserver): void {
  lifecycleObservers.push(fn);
}

// Called with an agent's id when it is created, or its name, role, task brief or lifecycle changes:
// the embedding index re-reads its text (agent-vectors.ts).
const agentTextObservers: ((id: string) => void)[] = [];
export function onAgentText(fn: (id: string) => void): void {
  agentTextObservers.push(fn);
}
function agentTextChanged(id: string): void {
  for (const fn of agentTextObservers) {
    try {
      fn(id);
    } catch {}
  }
}

export function updateAgent(id: string, fields: Partial<Agent>): void {
  const before = fields.activity ? getAgent(id) : undefined;
  const beforeLife = fields.lifecycle ? getAgent(id) : undefined;
  // A turn that ends with open waits ends in 'waiting'; observers still see what was asked.
  const requested = fields;
  if (fields.activity === 'idle') {
    const w = listWaits(id);
    if (w.length) fields = { ...fields, activity: 'waiting', activity_detail: waitSummary(w) };
  }
  // idle_since marks when an agent stopped working, for cache-aware compaction.
  if (fields.activity && fields.idle_since === undefined) {
    const idle = fields.activity === 'idle' || fields.activity === 'waiting';
    const cur = getAgent(id);
    if (idle && !(cur?.idle_since)) fields = { ...fields, idle_since: now() };
    if (!idle) fields = { ...fields, idle_since: null };
  }
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  const values = keys.map((k) => (fields as Record<string, unknown>)[k] ?? null) as (string | number | null)[];
  open().prepare(`UPDATE agents SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
  if (keys.some((k) => k === 'name' || k === 'role' || k === 'first_prompt' || k === 'lifecycle')) agentTextChanged(id);
  if (beforeLife && beforeLife.lifecycle !== fields.lifecycle) {
    const after = getAgent(id)!;
    for (const fn of lifecycleObservers) {
      try {
        fn(beforeLife, after);
      } catch {}
    }
    if (after.lifecycle === 'archived') events.emitEvent('agent.archived', { id });
    events.agentChanged(id);
  }
  if (before && before.activity !== fields.activity) {
    for (const fn of observers) {
      try {
        timed('activity observer', () => fn(before, getAgent(id)!, requested));
      } catch {}
    }
    events.agentChanged(id);
  }
}

export function addParent(childId: string, parentId: string): void {
  open().prepare('INSERT OR IGNORE INTO agent_parents (child_id, parent_id) VALUES (?, ?)').run(childId, parentId);
}

// Replaces every parent; none makes the agent top-level.
export function setParents(childId: string, parentIds: string[]): void {
  open().prepare('DELETE FROM agent_parents WHERE child_id = ?').run(childId);
  updateAgent(childId, { parent_id: parentIds[0] ?? null });
  for (const p of parentIds.slice(1)) addParent(childId, p);
}

// Every parent: the one that spawned the agent plus any that adopted it.
export function parentsOf(a: Agent): string[] {
  const rows = open().prepare('SELECT parent_id FROM agent_parents WHERE child_id = ?').all(a.id) as { parent_id: string }[];
  return [...new Set([...(a.parent_id ? [a.parent_id] : []), ...rows.map((r) => r.parent_id)])];
}

// Every adopting-parent link (agent_parents). Only src/tree.ts reads this; callers use tree.edges.
export function adoptedParentLinks(): { child_id: string; parent_id: string }[] {
  return open().prepare('SELECT child_id, parent_id FROM agent_parents ORDER BY child_id, parent_id').all() as { child_id: string; parent_id: string }[];
}

export function childrenOf(id: string): string[] {
  const rows = open()
    .prepare('SELECT id FROM agents WHERE parent_id = ? UNION SELECT child_id AS id FROM agent_parents WHERE parent_id = ?')
    .all(id, id) as { id: string }[];
  return rows.map((r) => r.id);
}

export function addEvent(agentId: string, type: string, data?: unknown): void {
  open()
    .prepare('INSERT INTO events (agent_id, ts, type, data) VALUES (?, ?, ?, ?)')
    .run(agentId, now(), type, data === undefined ? null : JSON.stringify(data));
}

// When the agent's harness last reported through a hook, or null.
export function lastHookAt(agentId: string): string | null {
  const r = open().prepare("SELECT ts FROM events WHERE agent_id = ? AND type LIKE 'hook:%' ORDER BY id DESC LIMIT 1").get(agentId) as { ts: string } | undefined;
  return r?.ts ?? null;
}

// Whether the agent has an event of this type: a cheap existence check for a one-off marker
// (for example the first-prompt markers, S-759).
export function hasEvent(agentId: string, type: string): boolean {
  return Boolean(open().prepare('SELECT 1 FROM events WHERE agent_id = ? AND type = ? LIMIT 1').get(agentId, type));
}

// Whether the event was recorded since the harness last started (a `spawn` or `resume` event).
export function hasEventSinceStart(agentId: string, type: string): boolean {
  return Boolean(open().prepare(
    "SELECT 1 FROM events WHERE agent_id = ? AND type = ? AND id > COALESCE((SELECT MAX(id) FROM events WHERE agent_id = ? AND type IN ('spawn', 'resume')), 0) LIMIT 1",
  ).get(agentId, type, agentId));
}

// When the agent's latest event of any of these types was recorded, or null.
export function lastEventAt(agentId: string, types: string[]): string | null {
  const r = open().prepare(`SELECT ts FROM events WHERE agent_id = ? AND type IN (${types.map(() => '?').join(', ')}) ORDER BY id DESC LIMIT 1`).get(agentId, ...types) as { ts: string } | undefined;
  return r?.ts ?? null;
}

// The times of an agent's events of one type since `since` (an ISO time), oldest first.
export function eventTimes(agentId: string, type: string, since: string): string[] {
  const rows = open().prepare('SELECT ts FROM events WHERE agent_id = ? AND type = ? AND ts >= ? ORDER BY id').all(agentId, type, since) as { ts: string }[];
  return rows.map((r) => r.ts);
}

export function listEvents(agentId: string, limit = 50): { id: number; ts: string; type: string; data: string | null }[] {
  return open()
    .prepare('SELECT id, ts, type, data FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?')
    .all(agentId, limit)
    .reverse() as unknown as { id: number; ts: string; type: string; data: string | null }[];
}

export interface Mail {
  id: string;
  // The ITSAs this mail is linked to (S-986), on mail read through a thread or the inbox; absent when none.
  itsas?: LinkedItsa[];
  from_id: string;
  subject: string;
  body: string;
  created_at: string;
  read_at?: string | null;
  from_name?: string | null;
  attachments?: { name: string; path: string; size: number }[];
  thread_id?: string | null;
  reply_to?: string | null;
  permission_id?: string | null;
  // The daemon guessed the thread this belongs to (no reply_to named), not the agent.
  auto_threaded?: number;
  // 1 when stam sent the mail on its own behalf, or a local script sent it (S-717): an automatic
  // notice, not a colleague's mail. The auto-read sweep (src/notices.ts) may settle these.
  notice?: number;
  // Set on an ITSA comment or update: the ITSA, `comment` or `update`, and an update's health.
  itsa_id?: string | null;
  kind?: string | null;
  health?: string | null;
  // The ITSA this mail is about: what the sender named, else the ITSA of its thread.
  about_itsa?: string | null;
  // The id of the mail its sender named as replacing this one (S-1304); null when none did.
  superseded_by?: string | null;
  // The system note the recipient reads after the body (S-1462): "routing uncertain" on mail the human sent without picking a recipient.
  note?: string | null;
  // The decision model's verdict on a mail to the human (src/mail-check.ts), or null until
  // a check has run or when the mail isn't checked.
  verdict?: MailVerdict | null;
  // Set when the sender overrode the mail gate (src/mail-check.ts, S-983): the reason it gave.
  override?: string | null;
  // A 1-3 word title for scanning (src/mail-title.ts), or null.
  title?: string | null;
  // A one-line summary of a mail to the human, for the swipe cards (S-1001), or null.
  summary?: string | null;
}

// What the decision model said about a mail to the human: `follows` is the yes/no overall
// (score >= 0.5), `score` its probability, and the rest the detail questions' probabilities.
export interface MailVerdict {
  follows: boolean;
  score: number;
  concise: number | null;
  fluff: number | null;
  value: number | null;
  // Under humanMail.when 'necessary' (S-985): the kind the model placed the mail in, and its confidence.
  kind?: string;
  kind_confidence?: number;
  at: string;
}

// Parses a stored verdict; anything malformed reads as no verdict.
export function parseVerdict(raw: unknown): MailVerdict | null {
  if (!raw) return null;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v && typeof v === 'object' && typeof (v as MailVerdict).follows === 'boolean' ? (v as MailVerdict) : null;
  } catch {
    return null;
  }
}

export function setMailVerdict(id: string, verdict: MailVerdict): void {
  open().prepare('UPDATE mail SET verdict = ? WHERE id = ?').run(JSON.stringify(verdict), id);
}

// The config a peer's title carries: this daemon never asks for it, so a peer copy is never regenerated
// here (S-1843).
export const PEER_TITLE_CONFIG = 'peer';
// The title with the hash of the model and prompt it was asked with (S-1843); null for a title from before
// the column, which counts as stale when shown.
export function setMailTitle(id: string, title: string, configHash: string | null = null): void {
  open().prepare('UPDATE mail SET title = ?, title_config = ? WHERE id = ?').run(title, configHash, id);
}
// Records the hash a title call was asked with, for a call that gave only a summary (S-1843).
export function setMailTitleConfig(id: string, configHash: string): void {
  open().prepare('UPDATE mail SET title_config = ? WHERE id = ?').run(configHash, id);
}
// A mail's stored title, summary and the hash the title was asked with (src/mail-title.ts, S-1843).
export function mailTitleRow(id: string): { title: string | null; summary: string | null; configHash: string | null } | undefined {
  const row = open().prepare('SELECT title, summary, title_config FROM mail WHERE id = ?').get(id) as { title: string | null; summary: string | null; title_config: string | null } | undefined;
  return row && { title: row.title, summary: row.summary, configHash: row.title_config };
}
export function setMailSummary(id: string, summary: string): void {
  open().prepare('UPDATE mail SET summary = ? WHERE id = ?').run(summary, id);
}

// A short automatic summary of an instruction text block (src/block-summaries.ts, S-878),
// cached by the sha256 of the text, with the hash of the model and prompt it was asked with;
// undefined when none is stored yet.
export function getBlockSummary(hash: string): { summary: string; configHash: string | null } | undefined {
  const row = open().prepare('SELECT summary, config_hash FROM block_summaries WHERE hash = ?').get(hash) as { summary: string; config_hash: string | null } | undefined;
  return row && { summary: row.summary, configHash: row.config_hash };
}

export function setBlockSummary(hash: string, summary: string, model: string, configHash: string): void {
  open()
    .prepare('INSERT OR REPLACE INTO block_summaries (hash, summary, model, created_at, config_hash) VALUES (?, ?, ?, ?, ?)')
    .run(hash, summary, model, new Date().toISOString(), configHash);
}

// A tool call's stored summary for this name and input (`hash`, src/tool-summaries.ts, S-1481), with
// the config hash it was asked with (null for a row from before the column); undefined when none is stored.
export function getToolSummary(agentId: string, callId: string, hash: string): { tool: string; doing: string; configHash: string | null } | undefined {
  const row = open().prepare('SELECT tool, doing, config_hash FROM tool_summaries WHERE agent_id = ? AND call_id = ? AND input_hash = ?').get(agentId, callId, hash) as { tool: string; doing: string; config_hash: string | null } | undefined;
  return row && { tool: row.tool, doing: row.doing, configHash: row.config_hash };
}

// Stores a call's summary. A row asked with the same config hash stays as it is; a stale one (another
// hash, or none) is replaced (S-1843).
export function setToolSummary(agentId: string, callId: string, hash: string, tool: string, doing: string, model: string, configHash: string): void {
  open()
    .prepare(
      'INSERT INTO tool_summaries (agent_id, call_id, input_hash, tool, doing, model, created_at, config_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT (agent_id, call_id, input_hash) DO UPDATE SET tool = excluded.tool, doing = excluded.doing, model = excluded.model, created_at = excluded.created_at, config_hash = excluded.config_hash ' +
        'WHERE tool_summaries.config_hash IS NOT excluded.config_hash',
    )
    .run(agentId, callId, hash, tool, doing, model, new Date().toISOString(), configHash);
}

// A tool's stored label (src/tool-names.ts, S-1933), or undefined.
export function getToolName(harness: string, name: string): string | undefined {
  return (open().prepare('SELECT label FROM tool_names WHERE harness = ? AND name = ?').get(harness, name) as { label: string } | undefined)?.label;
}

// Stores a tool's label once: a label already stored stays as it is.
export function setToolName(harness: string, name: string, label: string, model: string): void {
  open().prepare('INSERT OR IGNORE INTO tool_names (harness, name, label, model, created_at) VALUES (?, ?, ?, ?, ?)').run(harness, name, label, model, new Date().toISOString());
}

// A decision mail to the human (src/decision-mail.ts), and the human's reply that answers the
// decisions in its thread.
export function addDecisionMail(mailId: string, threadId: string): void {
  open().prepare('INSERT OR IGNORE INTO decision_mails (mail_id, thread_id) VALUES (?, ?)').run(mailId, threadId);
}

export function clearDecisionMails(threadId: string): void {
  open().prepare('DELETE FROM decision_mails WHERE thread_id = ?').run(threadId);
}

// A decision mail that no longer waits on the human, by its sender's withdrawal (withdraw.ts).
export function removeDecisionMail(mailId: string): void {
  open().prepare('DELETE FROM decision_mails WHERE mail_id = ?').run(mailId);
}

export function decisionMailOpen(mailId: string): boolean {
  return !!open().prepare('SELECT 1 AS n FROM decision_mails WHERE mail_id = ?').get(mailId);
}

// Whether the human chose Decide later on this thread (S-353): its decision stays theirs.
export function isThreadDeferred(threadId: string): boolean {
  return !!open().prepare('SELECT 1 AS n FROM thread_deferred WHERE thread_id = ?').get(threadId);
}

// A thread the human deferred (S-353), and the threads that are not.
export function setThreadDeferred(threadId: string, mailId: string): void {
  open().prepare('INSERT OR REPLACE INTO thread_deferred (thread_id, mail_id) VALUES (?, ?)').run(threadId, mailId);
}

export function clearThreadDeferred(threadId: string): void {
  open().prepare('DELETE FROM thread_deferred WHERE thread_id = ?').run(threadId);
}

export function deferredThreadIds(): Set<string> {
  return new Set((open().prepare('SELECT thread_id FROM thread_deferred').all() as { thread_id: string }[]).map((r) => r.thread_id));
}

export interface DecisionRow {
  mail_id: string;
  thread_id: string;
  from_id: string;
  from_name: string | null;
  subject: string;
  created_at: string;
  about_itsa: string | null;
  deferred: boolean;
}

// A decision mail that names its sender's request still pending with the human is that request's
// row (S-609), so it is left out until the request settles, which clears it (clearRequestWaits).
export function decisionMails(): DecisionRow[] {
  const rows = open().prepare(`SELECT m.id AS mail_id, d.thread_id, m.from_id, m.from_name, m.subject, m.created_at, m.about_itsa,
    EXISTS (SELECT 1 FROM thread_deferred f WHERE f.thread_id = d.thread_id) AS deferred
    FROM decision_mails d JOIN mail m ON m.id = d.mail_id
    WHERE NOT EXISTS (SELECT 1 FROM permission_requests p WHERE p.agent_id = m.from_id AND p.status = 'pending' AND p.audience = 'human' AND (instr(m.subject, p.id) > 0 OR instr(m.body, p.id) > 0))
    ORDER BY m.created_at, m.rowid`).all() as unknown as (Omit<DecisionRow, 'deferred'> & { deferred: number })[];
  return rows.map((r) => ({ ...r, deferred: r.deferred === 1 }));
}

export type MailItsaSource = 'itsa' | 'named' | 'thread' | 'attached';
export interface LinkedItsa {
  id: string;
  key: string;
  title: string;
  status: string;
  source: MailItsaSource;
}

// Links a mail to ITSAs (S-986), the earlier of the given links winning per ITSA. Creates no mail, no
// recipient and no unread state.
export function linkMailItsas(mailId: string, links: { itsa_id: string; source: MailItsaSource }[]): void {
  const ins = open().prepare('INSERT OR IGNORE INTO mail_itsas (mail_id, itsa_id, source) VALUES (?, ?, ?)');
  for (const l of links) ins.run(mailId, l.itsa_id, l.source);
}

// Attaches agents to a mail (S-1305); returns the ids newly attached. Makes no mail, recipient or unread state.
export function attachMailAgents(mailId: string, agentIds: string[], by: string): string[] {
  const ins = open().prepare('INSERT OR IGNORE INTO mail_agents (mail_id, agent_id, added_by) VALUES (?, ?, ?)');
  return agentIds.filter((id) => Number(ins.run(mailId, id, by).changes) > 0);
}

export function mailAgentIds(mailId: string): string[] {
  return (open().prepare('SELECT agent_id FROM mail_agents WHERE mail_id = ? ORDER BY rowid').all(mailId) as { agent_id: string }[]).map((r) => r.agent_id);
}

export function mailRecipientIds(mailId: string): string[] {
  return (open().prepare('SELECT agent_id FROM mail_recipients WHERE mail_id = ?').all(mailId) as { agent_id: string }[]).map((r) => r.agent_id);
}

export function itsaIdOfKey(key: string): string | undefined {
  return (open().prepare('SELECT id FROM itsas WHERE key = ?').get(key) as { id: string } | undefined)?.id;
}

// The ITSAs each of the mails is linked to, for mail that has any, in the order the links source them.
export function mailItsaLinks(mailIds: string[]): Map<string, LinkedItsa[]> {
  const out = new Map<string, LinkedItsa[]>();
  const q = open().prepare(`SELECT i.id, i.key, i.title, i.status, l.source FROM mail_itsas l JOIN itsas i ON i.id = l.itsa_id WHERE l.mail_id = ?
    ORDER BY CASE l.source WHEN 'itsa' THEN 0 WHEN 'named' THEN 1 WHEN 'attached' THEN 2 ELSE 3 END, i.created_at`);
  for (const id of mailIds) {
    const rows = q.all(id) as unknown as LinkedItsa[];
    if (rows.length) out.set(id, rows);
  }
  return out;
}

// One thread's linked mail (S-986): its newest linked mail names the sender and date, `mails` counts the linked ones.
export interface LinkedThread {
  thread_id: string;
  mail_id: string;
  subject: string;
  from_id: string;
  from_name: string | null;
  last_at: string;
  mails: number;
  source: MailItsaSource;
}

// The threads with mail linked to an ITSA, newest first, one row per thread and at most `limit`, so the limit counts
// threads. The ITSA's own thread (where every mail links as `thread`) is left out, as the ITSA view's Mail section
// does: by `ownThread` where it is known, and, for a peer that doesn't hold the ITSA, as any thread with a link of source `thread` or a
// comment on the ITSA (only comments carry `itsa_id`; a forwarded one links as `itsa`). The caller checks who may read each row's `mail_id`, its newest linked mail.
export function linkedThreads(itsaId: string, ownThread: string | null, limit: number): LinkedThread[] {
  return open()
    .prepare(
      `WITH l AS (
         SELECT m.id AS mail_id, COALESCE(m.thread_id, m.id) AS thread_id, m.subject, m.from_id, m.from_name, m.created_at AS last_at, k.source,
           ROW_NUMBER() OVER (PARTITION BY COALESCE(m.thread_id, m.id) ORDER BY m.created_at DESC, m.rowid DESC) AS rn,
           COUNT(*) OVER (PARTITION BY COALESCE(m.thread_id, m.id)) AS mails
         FROM mail_itsas k JOIN mail m ON m.id = k.mail_id
         WHERE k.itsa_id = ? AND k.source <> 'thread' AND COALESCE(m.thread_id, m.id) IS NOT ?
           AND NOT EXISTS (SELECT 1 FROM mail o WHERE o.thread_id = COALESCE(m.thread_id, m.id) AND o.itsa_id = k.itsa_id))
       SELECT l.mail_id, l.thread_id, COALESCE((SELECT t.subject FROM mail t WHERE t.id = l.thread_id), l.subject) AS subject, l.from_id, l.from_name, l.last_at, l.mails, l.source
       FROM l WHERE rn = 1 ORDER BY last_at DESC LIMIT ?`,
    )
    .all(itsaId, ownThread, limit) as unknown as LinkedThread[];
}

// The mail of one thread that is linked to an ITSA, newest first, at most `limit`.
export function linkedThreadMails(itsaId: string, threadId: string, limit: number): Mail[] {
  const ids = open()
    .prepare(`SELECT m.id FROM mail_itsas k JOIN mail m ON m.id = k.mail_id WHERE k.itsa_id = ? AND COALESCE(m.thread_id, m.id) = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`)
    .all(itsaId, threadId, limit) as { id: string }[];
  return ids.map((r) => getMail(r.id)).filter((m): m is Mail => !!m);
}

export function newMailId(): string {
  return 'm' + randomBytes(5).toString('hex').slice(0, 7);
}

export function createMail(
  m: { id: string; from_id: string; from_name: string; subject: string; body: string; thread_id: string; reply_to: string | null; permission_id?: string | null; auto_threaded?: boolean; notice?: boolean; itsa_id?: string | null; kind?: string | null; health?: string | null; about_itsa?: string | null; verdict?: MailVerdict | null; override?: string | null; note?: string | null },
  to: string[],
  // Recipients whose copy doesn't interrupt a working agent.
  quiet: string[] = [],
): void {
  const d = open();
  d.prepare('INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id, reply_to, permission_id, auto_threaded, notice, itsa_id, kind, health, about_itsa, verdict, override, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    m.id, m.from_id, m.from_name, m.subject, m.body, now(), m.thread_id, m.reply_to, m.permission_id ?? null, m.auto_threaded ? 1 : 0, m.notice ? 1 : 0, m.itsa_id ?? null, m.kind ?? null, m.health ?? null, m.about_itsa ?? m.itsa_id ?? null, m.verdict ? JSON.stringify(m.verdict) : null, m.override ?? null, m.note ?? null,
  );
  const ins = d.prepare('INSERT OR IGNORE INTO mail_recipients (mail_id, agent_id, quiet) VALUES (?, ?, ?)');
  for (const a of to) ins.run(m.id, a, quiet.includes(a) ? 1 : 0);
  // New mail in a thread an agent deferred brings the whole thread back, its older unread mail too
  // (S-1880). The human's box is left to splitDeferred. A system notice doesn't bring it back: it joins
  // the deferred thread, out of the agent's list, as the sender's own mail does (S-1971).
  const notice = isSystemNotice({ from_id: m.from_id, notice: m.notice });
  for (const a of to) if (a !== 'human' && a !== m.from_id) {
    if (notice) keepDeferred(a, m.thread_id, m.id);
    else undeferThread(a, m.thread_id);
  }
  // The sender's own view shows the mail it sent.
  mailChanged([...new Set([...to, m.from_id])]);
}

// Observers of an agent's mail: called with the agents that got, sent, or read a mail, or
// whose mail was read, so stam's own view (src/agent-view.ts) can show it.
const mailObservers: ((agents: string[]) => void)[] = [];
export function onAgentMail(fn: (agents: string[]) => void): void {
  mailObservers.push(fn);
}
function mailChanged(agents: string[]): void {
  if (agents.length) for (const fn of mailObservers) fn(agents);
}

// The latest read_at of any mail to the agent, when it is after `since` ('' when none).
export function lastReadSince(agentId: string, since: string): string {
  const r = open().prepare('SELECT MAX(read_at) AS at FROM mail_recipients WHERE agent_id = ? AND read_at > ?').get(agentId, since) as { at: string | null };
  return r.at ?? '';
}

// Mail to an agent from others, created in [since, before), oldest first, with its read state.
export function mailTo(agentId: string, since: string, before: string, limit = 200): Mail[] {
  return open()
    .prepare(
      `SELECT m.id, m.from_id, m.from_name, m.subject, m.body, m.created_at, m.thread_id, r.read_at FROM mail m
       JOIN mail_recipients r ON r.mail_id = m.id
       WHERE r.agent_id = ? AND m.from_id != ? AND m.created_at >= ? AND m.created_at < ?
       ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(agentId, agentId, since, before, limit)
    .reverse() as unknown as Mail[];
}

// Mail to an agent from others, read in [since, before), whenever it was created, oldest first.
export function mailReadIn(agentId: string, since: string, before: string, limit = 200): Mail[] {
  return open()
    .prepare(
      `SELECT m.id, m.from_id, m.from_name, m.subject, m.body, m.created_at, m.thread_id, r.read_at FROM mail m
       JOIN mail_recipients r ON r.mail_id = m.id
       WHERE r.agent_id = ? AND r.read_at IS NOT NULL AND m.from_id != ? AND r.read_at >= ? AND r.read_at < ?
       ORDER BY r.read_at DESC LIMIT ?`,
    )
    .all(agentId, agentId, since, before, limit)
    .reverse() as unknown as Mail[];
}

// Mail the agent sent, created in [since, before), oldest first, with each recipient's read state.
export function mailBy(agentId: string, since: string, before: string, limit = 200): (Mail & { to: { id: string; read_at: string | null }[] })[] {
  const d = open();
  const mails = d
    .prepare('SELECT id, from_id, from_name, subject, body, created_at, thread_id FROM mail WHERE from_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at DESC LIMIT ?')
    .all(agentId, since, before, limit)
    .reverse() as unknown as Mail[];
  const to = d.prepare('SELECT agent_id AS id, read_at FROM mail_recipients WHERE mail_id = ? ORDER BY rowid');
  return mails.map((m) => ({ ...m, to: to.all(m.id) as unknown as { id: string; read_at: string | null }[] }));
}

// Adds recipients to a mail already stored here (a forwarded mail arriving again), and
// returns the ones that were new.
export function addRecipients(mailId: string, to: string[], quiet: string[] = []): string[] {
  const ins = open().prepare('INSERT OR IGNORE INTO mail_recipients (mail_id, agent_id, quiet) VALUES (?, ?, ?)');
  const added = to.filter((a) => Number(ins.run(mailId, a, quiet.includes(a) ? 1 : 0).changes) > 0);
  mailChanged(added);
  return added;
}

// Folds copies of one mail (the same id, stored on several daemons, each with its own
// recipients) into one: recipients are joined, a recipient's read state is kept (read on
// any copy counts), and the first copy's attachments (else any copy's) and permission stay.
export function foldMails(mails: ThreadMail[]): ThreadMail[] {
  const byId = new Map<string, ThreadMail>();
  for (const m of mails) {
    const have = byId.get(m.id);
    if (!have) {
      byId.set(m.id, { ...m, recipients: m.recipients.map((r) => ({ ...r })) });
      continue;
    }
    for (const r of m.recipients) {
      const mine = have.recipients.find((x) => x.id === r.id);
      if (!mine) have.recipients.push({ ...r });
      else mine.read_at ??= r.read_at;
    }
    if (!have.attachments?.length && m.attachments?.length) have.attachments = m.attachments;
    if (!have.permission && m.permission) have.permission = m.permission;
    // A verdict is set on the daemon that checked the mail; keep it through a peer merge.
    if (have.verdict == null && m.verdict != null) have.verdict = m.verdict;
    if (have.override == null && m.override != null) have.override = m.override;
    // Likewise a title, set on the daemon that stored the mail first.
    if (have.title == null && m.title != null) have.title = m.title;
    if (have.summary == null && m.summary != null) have.summary = m.summary;
  }
  return [...byId.values()];
}

export function addAttachment(mailId: string, name: string, path: string, size: number): void {
  open().prepare('INSERT INTO attachments (mail_id, name, path, size) VALUES (?, ?, ?, ?)').run(mailId, name, path, size);
}

// Newest first. Summaries leave out the body.
// `loudOnly` leaves out quiet ITSA mail, which waits for the agent to be idle.
export function inbox(agentId: string, unreadOnly: boolean, limit: number, loudOnly = false): Mail[] {
  return open()
    .prepare(
      `SELECT m.id, m.from_id, m.from_name, m.subject, m.title, m.summary, m.created_at, m.thread_id, m.reply_to, m.itsa_id, m.about_itsa, m.kind, m.health, r.read_at FROM mail m
       JOIN mail_recipients r ON r.mail_id = m.id
       WHERE r.agent_id = ? ${unreadOnly ? `AND r.read_at IS NULL AND ${notDeferredOf('r')}` : ''} ${loudOnly ? 'AND r.quiet = 0' : ''}
       ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(agentId, limit)
    .map((m) => ({ ...(m as unknown as Mail), ...withItsas((m as { id: string }).id) })) as Mail[];
}

export function attachment(mailId: string, name: string): { name: string; path: string } | undefined {
  return open().prepare('SELECT name, path FROM attachments WHERE mail_id = ? AND name = ?').get(mailId, name) as { name: string; path: string } | undefined;
}

// Mail an agent received from any of `from` since `since`, newest read first, with whether
// the agent has written in that thread since, and the thread's first subject.
export function mailFrom(agentId: string, from: string[], since: string): (Mail & { answered: number; root_subject: string })[] {
  if (!from.length) return [];
  return open()
    .prepare(
      `SELECT m.*, r.read_at,
         EXISTS (SELECT 1 FROM mail x WHERE x.thread_id = m.thread_id AND x.from_id = ? AND x.created_at > m.created_at) AS answered,
         (SELECT y.subject FROM mail y WHERE y.thread_id = m.thread_id ORDER BY y.created_at LIMIT 1) AS root_subject
       FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
       WHERE r.agent_id = ? AND m.created_at > ? AND m.from_id IN (${from.map(() => '?').join(', ')})
       ORDER BY COALESCE(r.read_at, m.created_at) DESC`,
    )
    .all(agentId, agentId, since, ...from) as any;
}

// The thread a mail is in, from its row alone; undefined for no such mail or no thread.
export function mailThreadId(id: string): string | undefined {
  return (open().prepare('SELECT thread_id FROM mail WHERE id = ?').get(id) as { thread_id: string | null } | undefined)?.thread_id ?? undefined;
}

// The thread of each mail id given, in as few queries as the ids need (GET /api/agents).
export function mailThreadIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = open().prepare(`SELECT id, thread_id FROM mail WHERE id IN (${chunk.map(() => '?').join(', ')})`).all(...chunk) as { id: string; thread_id: string | null }[];
    for (const r of rows) if (r.thread_id) out.set(r.id, r.thread_id);
  }
  return out;
}

// Every agent's parents, as parentsOf gives them, in one pass over the parent links (GET /api/agents).
export function parentsByChild(agents: Agent[]): Map<string, string[]> {
  const out = new Map<string, Set<string>>();
  const add = (child: string, parent: string) => (out.get(child) ?? out.set(child, new Set()).get(child)!).add(parent);
  for (const a of agents) if (a.parent_id) add(a.id, a.parent_id);
  for (const r of open().prepare('SELECT child_id, parent_id FROM agent_parents ORDER BY child_id, parent_id').all() as { child_id: string; parent_id: string }[]) add(r.child_id, r.parent_id);
  return new Map([...out].map(([id, ps]) => [id, [...ps]]));
}

// Pending permission requests per agent, as listPermissionRequests('pending') counts them.
export function pendingRequestCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of listPermissionRequests('pending')) if (r.audience === 'human') out.set(r.agent_id, (out.get(r.agent_id) ?? 0) + 1);
  return out;
}

export function getMail(id: string): Mail | undefined {
  return open().prepare('SELECT * FROM mail WHERE id = ?').get(id) as Mail | undefined;
}

export interface ThreadMail extends Mail {
  recipients: { id: string; read_at: string | null; withdrawn_at?: string | null; withdrawn_by?: string | null; withdrawn_note?: string | null }[];
  permission?: PublicRequest;
}

function withItsas(id: string): { itsas?: LinkedItsa[]; agents?: string[] } {
  const l = mailItsaLinks([id]).get(id);
  const a = mailAgentIds(id);
  return { ...(l ? { itsas: l } : {}), ...(a.length ? { agents: a } : {}) };
}

function withRecipients(d: DatabaseSync, m: Mail): ThreadMail {
  return {
    ...m,
    verdict: parseVerdict(m.verdict),
    from_name: m.from_name ?? (m.from_id === 'human' ? 'human' : (getAgent(m.from_id)?.name ?? m.from_id)),
    recipients: d.prepare('SELECT agent_id AS id, read_at, withdrawn_at, withdrawn_by, withdrawn_note FROM mail_recipients WHERE mail_id = ?').all(m.id) as ThreadMail['recipients'],
    attachments: d.prepare('SELECT name, path, size FROM attachments WHERE mail_id = ?').all(m.id) as unknown as Mail['attachments'],
    ...withItsas(m.id),
    ...(m.permission_id ? { permission: (() => { const p = getPermissionRequest(m.permission_id!); return p && publicRequest(p); })() } : {}),
  };
}

// Every message of a thread stored here, oldest first. With box, only messages that box
// sent or received. Reading doesn't mark anything read.
export function threadMail(threadId: string, box?: string): ThreadMail[] {
  const d = open();
  const rows = d
    .prepare(
      `SELECT * FROM mail m WHERE thread_id = ?
       ${box ? 'AND (m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?))' : ''}
       ORDER BY created_at`,
    )
    .all(...(box ? [threadId, box, box] : [threadId])) as unknown as Mail[];
  return rows.map((m) => withRecipients(d, m));
}

// The threads a mailbox takes part in, sending or receiving, newest activity first. Each
// carries every message stored here, so peers' lists merge by thread.
// `withId` keeps only the threads where that agent sent or received a message (S-1121).
export function threads(box: string, limit: number, withId?: string): { thread_id: string; mails: ThreadMail[] }[] {
  const d = open();
  const ids = d
    .prepare(
      `SELECT m.thread_id AS t, MAX(m.created_at) AS last FROM mail m
       WHERE (m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?))
         AND (? IS NULL OR EXISTS (SELECT 1 FROM mail w WHERE w.thread_id = m.thread_id AND (w.from_id = ?
              OR EXISTS (SELECT 1 FROM mail_recipients wr WHERE wr.mail_id = w.id AND wr.agent_id = ?))))
       GROUP BY m.thread_id ORDER BY last DESC LIMIT ?`,
    )
    .all(box, box, withId ?? null, withId ?? null, withId ?? null, limit) as { t: string }[];
  return ids.map(({ t }) => ({ thread_id: t, mails: threadMail(t) }));
}

// The threads holding mail about an ITSA (its `about_itsa`), with every message stored here,
// newest activity first. Peers' lists merge by thread; the ITSA's own thread is left to the caller.
export function aboutItsaThreads(itsaId: string): { thread_id: string; mails: ThreadMail[] }[] {
  const ids = open()
    .prepare('SELECT thread_id AS t, MAX(created_at) AS last FROM mail WHERE about_itsa = ? GROUP BY thread_id ORDER BY last DESC')
    .all(itsaId) as { t: string }[];
  return ids.map(({ t }) => ({ thread_id: t, mails: threadMail(t) }));
}

// The ITSA whose own thread this is (S-448). Not the ITSAs its mail is about: any sender can name its
// own ITSA on a reply into someone else's thread, which would open that thread to it.
export function threadItsas(threadId: string): string[] {
  return (open().prepare('SELECT id FROM itsas WHERE thread_id = ?').all(threadId) as { id: string }[]).map((r) => r.id);
}

// Lets an agent read a whole thread: one its spawner cited in the agent's brief (S-1107).
export function grantThread(threadId: string, agentId: string): void {
  open().prepare('INSERT OR IGNORE INTO thread_readers (thread_id, agent_id) VALUES (?, ?)').run(threadId, agentId);
}

export function threadGranted(threadId: string, agentId: string): boolean {
  return !!open().prepare('SELECT 1 FROM thread_readers WHERE thread_id = ? AND agent_id = ?').get(threadId, agentId);
}

// The ITSAs a thread belongs to (S-480): those naming it here (the home), and those its mail carries
// as an ITSA's comments do, which a peer holding a copy knows too.
export function threadItsaIds(threadId: string): string[] {
  const rows = open().prepare('SELECT id FROM itsas WHERE thread_id = ? UNION SELECT itsa_id FROM mail WHERE thread_id = ? AND itsa_id IS NOT NULL').all(threadId, threadId) as { id: string }[];
  return rows.map((r) => r.id);
}

// Every thread that belongs to an ITSA, by the same two marks.
export function itsaThreadIds(): Set<string> {
  const rows = open().prepare('SELECT thread_id FROM itsas WHERE thread_id IS NOT NULL UNION SELECT thread_id FROM mail WHERE itsa_id IS NOT NULL AND thread_id IS NOT NULL').all() as { thread_id: string }[];
  return new Set(rows.map((r) => r.thread_id));
}

// Joins thread groups from several daemons: one group per thread, its mails folded (see foldMails).
export function foldThreads(groups: { thread_id: string; mails: ThreadMail[] }[]): { thread_id: string; mails: ThreadMail[] }[] {
  const byId = new Map<string, ThreadMail[]>();
  for (const g of groups) byId.set(g.thread_id, [...(byId.get(g.thread_id) ?? []), ...g.mails]);
  return [...byId].map(([thread_id, mails]) => ({ thread_id, mails: foldMails(mails).sort((a, b) => a.created_at.localeCompare(b.created_at)) }));
}

// Archiving hides a thread from a mailbox's list without deleting anything. It records the
// ids of the thread's messages at that moment; the thread stays hidden only while it has no
// message beyond that set, so a reply brings it back on any machine and no clock is
// consulted. A pending permission request keeps it in the inbox regardless. See splitArchived.
export function archiveThread(mailbox: string, threadId: string, mailIds: string[]): void {
  const d = open();
  undeferThread(mailbox, threadId);
  d.prepare('INSERT OR REPLACE INTO thread_archive (mailbox_id, thread_id) VALUES (?, ?)').run(mailbox, threadId);
  d.prepare('DELETE FROM thread_archive_mail WHERE mailbox_id = ? AND thread_id = ?').run(mailbox, threadId);
  const ins = d.prepare('INSERT OR IGNORE INTO thread_archive_mail (mailbox_id, thread_id, mail_id) VALUES (?, ?, ?)');
  for (const id of mailIds) ins.run(mailbox, threadId, id);
}

// A message the mailbox's owner sends into an archived thread stays out of sight: it joins the
// archived set, so only a message to the mailbox from someone else brings the thread back.
export function keepArchived(mailbox: string, threadId: string, mailId: string): void {
  const d = open();
  if (!d.prepare('SELECT 1 FROM thread_archive WHERE mailbox_id = ? AND thread_id = ?').get(mailbox, threadId)) return;
  d.prepare('INSERT OR IGNORE INTO thread_archive_mail (mailbox_id, thread_id, mail_id) VALUES (?, ?, ?)').run(mailbox, threadId, mailId);
}

// The human unarchived the thread (S-637): auto-archive leaves it alone until it has new mail for them.
export function keepOpen(mailbox: string, threadId: string, mailIds: string[]): void {
  open().prepare('INSERT OR REPLACE INTO thread_kept_open (mailbox_id, thread_id, mail_ids) VALUES (?, ?, ?)').run(mailbox, threadId, JSON.stringify([...new Set(mailIds)]));
}

// Whether auto-archive must leave the thread alone: the human unarchived it, and every mail to them
// from others in it (`ids`) is one it had then. Their own mail isn't news to them.
export function keptOpen(mailbox: string, threadId: string, ids: string[]): boolean {
  const r = open().prepare('SELECT mail_ids FROM thread_kept_open WHERE mailbox_id = ? AND thread_id = ?').get(mailbox, threadId) as { mail_ids: string } | undefined;
  if (!r) return false;
  const kept = new Set(JSON.parse(r.mail_ids) as string[]);
  return ids.every((id) => kept.has(id));
}

// Records that auto-archive, not the human, archived the thread (S-637), so its repair may undo it.
export function markAutoArchived(mailbox: string, threadId: string): void {
  open().prepare('INSERT OR IGNORE INTO thread_auto_archived (mailbox_id, thread_id) VALUES (?, ?)').run(mailbox, threadId);
}

export function autoArchivedThreads(mailbox: string): string[] {
  return (open().prepare('SELECT thread_id FROM thread_auto_archived WHERE mailbox_id = ?').all(mailbox) as { thread_id: string }[]).map((r) => r.thread_id);
}

export function forgetAutoArchived(mailbox: string, threadId: string): void {
  open().prepare('DELETE FROM thread_auto_archived WHERE mailbox_id = ? AND thread_id = ?').run(mailbox, threadId);
}

export function unarchiveThread(mailbox: string, threadId: string): void {
  const d = open();
  d.prepare('DELETE FROM thread_archive WHERE mailbox_id = ? AND thread_id = ?').run(mailbox, threadId);
  d.prepare('DELETE FROM thread_archive_mail WHERE mailbox_id = ? AND thread_id = ?').run(mailbox, threadId);
}

// How many threads this mailbox has tucked away, so a list can fetch enough to fill a page
// after filtering.
export function archivedCount(mailbox: string): number {
  return (open().prepare('SELECT COUNT(*) AS n FROM thread_archive WHERE mailbox_id = ?').get(mailbox) as { n: number }).n;
}

// Deferring sets a thread aside for later (S-976): it leaves the mailbox's to-do list and its
// unread count, and is listed on its own. Like archive it records the thread's message ids, so a new
// message to the mailbox brings it back. Deferring an archived thread takes it out of the archive.
export function deferThread(mailbox: string, threadId: string, mailIds: string[]): void {
  const d = open();
  unarchiveThread(mailbox, threadId);
  d.prepare('INSERT OR REPLACE INTO thread_defer (mailbox_id, thread_id) VALUES (?, ?)').run(mailbox, threadId);
  d.prepare('DELETE FROM thread_defer_mail WHERE mailbox_id = ? AND thread_id = ?').run(mailbox, threadId);
  const ins = d.prepare('INSERT OR IGNORE INTO thread_defer_mail (mailbox_id, thread_id, mail_id) VALUES (?, ?, ?)');
  for (const id of mailIds) ins.run(mailbox, threadId, id);
}

export function undeferThread(mailbox: string, threadId: string): void {
  const d = open();
  d.prepare('DELETE FROM thread_defer WHERE mailbox_id = ? AND thread_id = ?').run(mailbox, threadId);
  d.prepare('DELETE FROM thread_defer_mail WHERE mailbox_id = ? AND thread_id = ?').run(mailbox, threadId);
}

// The mailbox's own message in a deferred thread stays deferred, as keepArchived does for archive.
export function keepDeferred(mailbox: string, threadId: string, mailId: string): void {
  const d = open();
  if (!d.prepare('SELECT 1 FROM thread_defer WHERE mailbox_id = ? AND thread_id = ?').get(mailbox, threadId)) return;
  d.prepare('INSERT OR IGNORE INTO thread_defer_mail (mailbox_id, thread_id, mail_id) VALUES (?, ?, ?)').run(mailbox, threadId, mailId);
}

export function deferredCount(mailbox: string): number {
  return (open().prepare('SELECT COUNT(*) AS n FROM thread_defer WHERE mailbox_id = ?').get(mailbox) as { n: number }).n;
}

// Splits threads into the ones deferred and the rest (splitDeferredThreads holds the rule). A pending
// permission request can be deferred too (S-1068): it stays pending and listed to answer.
export function splitDeferred<T extends { thread_id: string; mails: { id: string; from_id?: string | null; notice?: number | boolean | null; permission?: { status?: string } | null; recipients?: { id: string }[] }[] }>(
  mailbox: string,
  threads: T[],
  keep: Set<string> = new Set(),
): { rest: T[]; deferred: T[] } {
  const d = open();
  const recorded = new Map<string, Set<string>>();
  for (const r of d.prepare('SELECT thread_id FROM thread_defer WHERE mailbox_id = ?').all(mailbox) as { thread_id: string }[]) recorded.set(r.thread_id, new Set());
  const idsFor = d.prepare('SELECT mail_id FROM thread_defer_mail WHERE mailbox_id = ? AND thread_id = ?');
  for (const [threadId, ids] of recorded) for (const r of idsFor.all(mailbox, threadId) as { mail_id: string }[]) ids.add(r.mail_id);
  return splitDeferredThreads(mailbox, threads, recorded, keep);
}

// Splits a mailbox's threads, as any daemon serving a list merged them, into the ones
// hidden by archive and the rest. A thread is hidden only while every message sent to the
// mailbox is one archive recorded; such a message beyond that set makes it active again. Mail
// between others in the thread (agents talking in a thread the human started, a script's post)
// stays readable there but doesn't bring it back (S-542). A pending
// permission request always keeps its thread in the inbox, wherever that request lives, and
// so does each thread in `keep` (the human's: the ask threads of ITSAs waiting on them).
export function splitArchived<T extends { thread_id: string; mails: { id: string; permission?: { status?: string } | null; recipients?: { id: string }[] }[] }>(
  mailbox: string,
  threads: T[],
  keep: Set<string> = new Set(),
): { active: T[]; archived: T[] } {
  const d = open();
  const rows = d.prepare('SELECT thread_id FROM thread_archive WHERE mailbox_id = ?').all(mailbox) as { thread_id: string }[];
  const taken = new Set(rows.map((r) => r.thread_id));
  const idsFor = d.prepare('SELECT mail_id FROM thread_archive_mail WHERE mailbox_id = ? AND thread_id = ?');
  const isArchived = (t: T) => {
    if (!taken.has(t.thread_id) || keep.has(t.thread_id)) return false;
    if (t.mails.some((m) => m.permission?.status === 'pending')) return false;
    const known = new Set((idsFor.all(mailbox, t.thread_id) as { mail_id: string }[]).map((r) => r.mail_id));
    // A message whose recipients aren't known counts as sent to the mailbox.
    return t.mails.every((m) => known.has(m.id) || !(m.recipients?.some((r) => r.id === mailbox) ?? true));
  };
  return { active: threads.filter((t) => !isArchived(t)), archived: threads.filter(isArchived) };
}

// Mail withdrawn from the human's attention (src/withdraw.ts): marks the human's copy read and
// records who withdrew it and why, once. Returns the mails the human holds here: `held` for
// every one found (withdrawn already or not), `fresh` for the ones this call withdrew, with their threads.
export function withdrawFromHuman(mailIds: string[], by: string, note: string): { held: string[]; fresh: { id: string; thread_id: string }[] } {
  const d = open();
  const held: string[] = [];
  const fresh: { id: string; thread_id: string }[] = [];
  const at = now();
  for (const id of mailIds) {
    const r = d.prepare("SELECT withdrawn_at FROM mail_recipients WHERE mail_id = ? AND agent_id = 'human'").get(id) as { withdrawn_at: string | null } | undefined;
    if (!r) continue;
    held.push(id);
    if (r.withdrawn_at) continue;
    d.prepare("UPDATE mail_recipients SET read_at = COALESCE(read_at, ?), withdrawn_at = ?, withdrawn_by = ?, withdrawn_note = ? WHERE mail_id = ? AND agent_id = 'human'").run(at, at, by, note.slice(0, 500), id);
    fresh.push({ id, thread_id: mailThreadId(id) ?? id });
  }
  if (fresh.length) {
    mailChanged(['human']);
    // Withdrawing marks the human's copy read, so the system view's mail flight ends too.
    for (const m of fresh) events.emitEvent('mail.read', { id: m.id, by: 'human', at });
  }
  return { held, fresh };
}

// Marks `oldId` superseded by `newId` (S-1304) and settles every recipient's copy: it is read, so no
// inbox, unread count or notice lists it. The human's copy is withdrawn by src/withdraw.ts, which the
// caller runs. Returns the recipients that held it unread.
export function supersedeMail(oldId: string, newId: string): string[] {
  const d = open();
  d.prepare('UPDATE mail SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL').run(newId, oldId);
  const unread = (d.prepare('SELECT agent_id FROM mail_recipients WHERE mail_id = ? AND read_at IS NULL').all(oldId) as { agent_id: string }[]).map((r) => r.agent_id);
  for (const a of unread) markRead(a, [oldId]);
  return unread;
}

// The mails that carry a permission request.
export function permissionMailIds(requestId: string): string[] {
  return (open().prepare('SELECT id FROM mail WHERE permission_id = ?').all(requestId) as { id: string }[]).map((r) => r.id);
}

// Mail the recipient set aside with a deferred thread (S-976) isn't unread to them.
const notDeferredOf = (t: string): string => `NOT EXISTS (SELECT 1 FROM thread_defer_mail dm WHERE dm.mailbox_id = ${t}.agent_id AND dm.mail_id = ${t}.mail_id)`;
const notDeferred = notDeferredOf('mail_recipients');

export function unreadCount(agentId: string, loudOnly = false): number {
  const r = open().prepare(`SELECT COUNT(*) AS n FROM mail_recipients WHERE agent_id = ? AND read_at IS NULL AND ${notDeferred} ${loudOnly ? 'AND quiet = 0' : ''}`).get(agentId) as { n: number };
  return r.n;
}

// Every agent's unread mail count in one query, for the agents list (GET /api/agents): the same numbers
// unreadCount gives one agent at a time.
export function unreadCounts(): Map<string, number> {
  const rows = open().prepare(`SELECT agent_id, COUNT(*) AS n FROM mail_recipients WHERE read_at IS NULL AND ${notDeferred} GROUP BY agent_id`).all() as { agent_id: string; n: number }[];
  return new Map(rows.map((r) => [r.agent_id, r.n]));
}

// Each agent's total spend, for the web UI's tree.
export function costByAgent(): Map<string, number> {
  const rows = open().prepare('SELECT agent_id, SUM(cost_usd) AS c FROM usage GROUP BY agent_id').all() as { agent_id: string; c: number }[];
  return new Map(rows.map((r) => [r.agent_id, r.c]));
}

// One agent's total spend, for `agent.changed` on the event stream (events.ts): cheaper than
// costByAgent when only one agent's number is wanted.
export function agentCost(agentId: string): number {
  const r = open().prepare('SELECT SUM(cost_usd) AS c FROM usage WHERE agent_id = ?').get(agentId) as { c: number | null };
  return r.c ?? 0;
}

// Each agent's total spend per account ('' when unmanaged), for the cost display (src/cost-display.ts).
export function costByAgentAccount(): Map<string, Map<string, number>> {
  const rows = open().prepare('SELECT agent_id, account, SUM(cost_usd) AS c FROM usage GROUP BY agent_id, account').all() as { agent_id: string; account: string; c: number }[];
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!out.has(r.agent_id)) out.set(r.agent_id, new Map());
    out.get(r.agent_id)!.set(r.account, r.c ?? 0);
  }
  return out;
}

export function unpushedCount(agentId: string): number {
  const r = open()
    .prepare(`SELECT COUNT(*) AS n FROM mail_recipients WHERE agent_id = ? AND read_at IS NULL AND pushed_at IS NULL AND ${notDeferred}`)
    .get(agentId) as { n: number };
  return r.n;
}

export function markPushed(agentId: string): void {
  open().prepare(`UPDATE mail_recipients SET pushed_at = ? WHERE agent_id = ? AND read_at IS NULL AND pushed_at IS NULL AND ${notDeferred}`).run(now(), agentId);
}

// Returns full mails with attachments and marks them read for this recipient. With a `batch`, the
// mails are also recorded as handed out in it, owed until a batch holding them is acknowledged: the
// client may time out before it gets the reply, so the next read hands them out again (S-357).
export function readMail(agentId: string, ids: string[], batch?: string): Mail[] {
  const d = open();
  // One transaction: the read state and the batch's deliveries land together, or neither does, so a
  // mail is never read but not owed (S-357). The views are told once it has committed.
  const { mails, fresh } = transaction(() => {
    const mails: Mail[] = [];
    const fresh: Mail[] = [];
    for (const id of ids) {
      const m = d
        .prepare('SELECT m.*, r.read_at FROM mail m JOIN mail_recipients r ON r.mail_id = m.id WHERE m.id = ? AND r.agent_id = ?')
        .get(id, agentId) as Mail | undefined;
      if (!m) continue;
      m.from_name ??= m.from_id === 'human' ? 'human' : ((getAgent(m.from_id)?.name) ?? m.from_id);
      m.verdict = parseVerdict(m.verdict);
      m.attachments = d.prepare('SELECT name, path, size FROM attachments WHERE mail_id = ?').all(id) as unknown as Mail['attachments'];
      if (!m.read_at) fresh.push(m);
      d.prepare('UPDATE mail_recipients SET read_at = COALESCE(read_at, ?) WHERE mail_id = ? AND agent_id = ?').run(now(), id, agentId);
      if (batch) d.prepare('INSERT OR IGNORE INTO mail_deliveries (agent_id, mail_id, batch) VALUES (?, ?, ?)').run(agentId, id, batch);
      mails.push(m);
    }
    return { mails, fresh };
  });
  // The reader's view, and its senders', whose views show the mail read.
  if (fresh.length) {
    mailChanged([...new Set([agentId, ...fresh.map((m) => m.from_id)])]);
    const at = now();
    for (const m of fresh) events.emitEvent('mail.read', { id: m.id, by: agentId, at });
  }
  return mails;
}

// Marks mail read for an agent that isn't reading it: the auto-read sweep for automatic notices
// whose answer is settled (src/notices.ts, S-717). Tells the views as readMail does.
export function markRead(agentId: string, ids: string[]): number {
  if (!ids.length) return 0;
  const d = open();
  const at = now();
  const up = d.prepare('UPDATE mail_recipients SET read_at = ? WHERE mail_id = ? AND agent_id = ? AND read_at IS NULL');
  const marked: string[] = [];
  for (const id of ids) if (Number(up.run(at, id, agentId).changes) > 0) marked.push(id);
  if (marked.length) {
    mailChanged([agentId]);
    for (const id of marked) events.emitEvent('mail.read', { id, by: agentId, at });
  }
  return marked.length;
}

// The client got the reply to `batch`: every mail in it is retired, whichever later batch handed it out
// again, so a mail never stays owed once one reply carrying it arrived.
export function ackDelivered(agentId: string, batch: string): void {
  open()
    .prepare('DELETE FROM mail_deliveries WHERE agent_id = ? AND mail_id IN (SELECT mail_id FROM mail_deliveries WHERE agent_id = ? AND batch = ?)')
    .run(agentId, agentId, batch);
}

// What a read without ids hands out, at most `limit`: the mail owed to the agent first (oldest first),
// then its unread mail, oldest first, to fill the rest (S-357).
// Owed mail that is FYI (from a system sender, or ending in "No action needed") or first read more than
// OWED_MAX_AGE_MS ago is not handed out again (S-1091): a client that lost its ack, such as after a
// compaction, otherwise got day-old notices ahead of real mail. It stays read; its owed rows are dropped.
const OWED_MAX_AGE_MS = 6 * 3600_000;
const endsNoAction = (body: string): boolean => /\bno action needed\W*$/i.test(body.trim().split('\n').at(-1)?.trim() ?? '');
export function defaultRead(agentId: string, limit = 10): string[] {
  const d = open();
  const cutoff = new Date(Date.now() - OWED_MAX_AGE_MS).toISOString();
  const candidates = d
    .prepare(
      `SELECT m.id, m.from_id, m.body, r.read_at FROM mail m JOIN mail_recipients r ON r.mail_id = m.id AND r.agent_id = ?
       WHERE m.id IN (SELECT mail_id FROM mail_deliveries WHERE agent_id = ?) ORDER BY m.created_at, m.rowid`,
    )
    .all(agentId, agentId) as { id: string; from_id: string; body: string; read_at: string | null }[];
  const stale = candidates.filter((c) => c.from_id.startsWith('system:') || endsNoAction(c.body) || (c.read_at ?? '') < cutoff);
  const del = d.prepare('DELETE FROM mail_deliveries WHERE agent_id = ? AND mail_id = ?');
  for (const c of stale) del.run(agentId, c.id);
  const owed = candidates.filter((c) => !stale.includes(c)).slice(0, limit).map((c) => c.id);
  const unread = (
    d
      .prepare(
        `SELECT m.id FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
         WHERE r.agent_id = ? AND r.read_at IS NULL AND ${notDeferredOf('r')} AND m.id NOT IN (SELECT mail_id FROM mail_deliveries WHERE agent_id = ?)
         ORDER BY m.created_at, m.rowid LIMIT ?`,
      )
      .all(agentId, agentId, limit - owed.length) as { id: string }[]
  ).map((r) => r.id);
  return [...owed, ...unread];
}

export function searchAgents(q: string): Agent[] {
  const like = `%${q}%`;
  return open()
    .prepare('SELECT * FROM agents WHERE id = ? OR name LIKE ? OR role LIKE ? ORDER BY created_at')
    .all(q, like, like) as unknown as Agent[];
}

// The agents whose role or name contains `role` (case-insensitive; an empty `role` keeps all),
// standing agents first and the given order kept within each group (S-918).
export function agentsByRole<T extends { name: string; role: string | null; standing?: number | null }>(list: T[], role: string): T[] {
  const q = role.trim().toLowerCase();
  const hit = q ? list.filter((a) => `${a.role ?? ''}\n${a.name}`.toLowerCase().includes(q)) : list;
  return [...hit.filter((a) => a.standing), ...hit.filter((a) => !a.standing)];
}

// Mail whose subject or body matches `q`, for a mailbox that sent or received it. Uses FTS5
// (ranked by bm25) with LIKE as the fallback (newest first). Newest-first is what the thread
// grouping wants; a mail whose thread already matched keeps the higher-scoring message.
// Also matches mail in any of `threads`, for a viewer that may read those threads beyond its own mail.
export function searchMailText(q: string, box: string, limit: number, threads: string[] = []): Mail[] {
  const match = fts5Mail ? ftsQuery(q) : '';
  const threadsJson = JSON.stringify(threads);
  if (match) {
    try {
      return open()
        .prepare(
          `SELECT m.* FROM mail_fts f JOIN mail m ON m.rowid = f.rowid
           WHERE mail_fts MATCH ? AND (m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?) OR m.thread_id IN (SELECT value FROM json_each(?)))
           ORDER BY bm25(mail_fts) LIMIT ?`,
        )
        .all(match, box, box, threadsJson, limit) as unknown as Mail[];
    } catch {
      // A query FTS5 still can't read falls through to LIKE rather than failing the search.
    }
  }
  const like = `%${q}%`;
  return open()
    .prepare(
      `SELECT m.* FROM mail m
       WHERE (m.subject LIKE ? OR m.body LIKE ?) AND (m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?) OR m.thread_id IN (SELECT value FROM json_each(?)))
       ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(like, like, box, box, threadsJson, limit) as unknown as Mail[];
}

// The threads a mailbox takes part in, sending or receiving.
export function threadIdsOf(box: string): string[] {
  const rows = open()
    .prepare('SELECT DISTINCT m.thread_id AS t FROM mail m WHERE m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?)')
    .all(box, box) as { t: string }[];
  return rows.map((r) => r.t);
}

// The threads the human takes part in.
export function humanThreadIds(): string[] {
  return threadIdsOf('human');
}

// The mail a mailbox may read: its own, and the threads it may read beyond them (see mail-search.ts).
export function mailScope(box: string, threads: string[]): { id: string; thread: string }[] {
  return open()
    .prepare(
      `SELECT m.id, COALESCE(m.thread_id, m.id) AS thread FROM mail m
       WHERE m.from_id = ? OR EXISTS (SELECT 1 FROM mail_recipients r WHERE r.mail_id = m.id AND r.agent_id = ?) OR m.thread_id IN (SELECT value FROM json_each(?))`,
    )
    .all(box, box, JSON.stringify(threads)) as { id: string; thread: string }[];
}

export interface EmbeddingRow {
  hash: string;
  model: string;
}

export function embeddingRow(source: string, ref: string): EmbeddingRow | undefined {
  return open().prepare('SELECT hash, model FROM embeddings WHERE source = ? AND ref = ?').get(source, ref) as EmbeddingRow | undefined;
}

export function putEmbedding(row: { source: string; ref: string; model: string; dim: number; vec: Uint8Array; hash: string }): void {
  open()
    .prepare('INSERT OR REPLACE INTO embeddings (source, ref, model, dim, vec, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(row.source, row.ref, row.model, row.dim, row.vec, row.hash, new Date().toISOString());
  cachePut(row);
}

// Marks a stored vector as current as of now: its text was checked and hasn't changed.
export function touchEmbedding(source: string, ref: string): void {
  open().prepare('UPDATE embeddings SET updated_at = ? WHERE source = ? AND ref = ?').run(new Date().toISOString(), source, ref);
}

export function putTurnSnippet(ref: string, at: number, snippet: string): void {
  open().prepare('INSERT OR REPLACE INTO turn_snippets (ref, at, snippet) VALUES (?, ?, ?)').run(ref, at, snippet);
}

// A turn's start time (ms) and snippet; none when it isn't indexed.
export function turnSnippet(ref: string): { at: number; snippet: string } | undefined {
  return open().prepare('SELECT at, snippet FROM turn_snippets WHERE ref = ?').get(ref) as { at: number; snippet: string } | undefined;
}

// Forgets the turns that began before `at` (ms): their snippets and their vectors.
export function expireTurns(at: number): void {
  const refs = (open().prepare('SELECT ref FROM turn_snippets WHERE at < ?').all(at) as { ref: string }[]).map((r) => r.ref);
  if (!refs.length) return;
  transaction(() => {
    for (const ref of refs) deleteEmbedding('turn', ref);
    open().prepare('DELETE FROM turn_snippets WHERE at < ?').run(at);
  });
}

export function deleteEmbedding(source: string, ref: string): void {
  open().prepare('DELETE FROM embeddings WHERE source = ? AND ref = ?').run(source, ref);
  cacheDelete(source, ref);
}

// The embedded vectors of one source made by one model.
export function embeddingsOf(source: string, model: string): { ref: string; dim: number; vec: Uint8Array }[] {
  return open().prepare('SELECT ref, dim, vec FROM embeddings WHERE source = ? AND model = ?').all(source, model) as { ref: string; dim: number; vec: Uint8Array }[];
}

// A source's vectors decoded once, per database handle and model, for `nearest` (S-1459): a query
// scans these instead of reading and decoding every row. A put or delete changes the cached rows in
// place (S-1460): dropping them would make the next query decode every vector again.
export interface DecodedVector {
  ref: string;
  vec: Float32Array;
  // The vector's length, so a query needn't compute it per row.
  norm: number;
}
const vectorCache = new WeakMap<DatabaseSync, Map<string, DecodedVector[]>>();
// Where each ref sits in a cached array, so a put or delete finds it without a scan.
const positions = new WeakMap<DecodedVector[], Map<string, number>>();

function decode(ref: string, dim: number, raw: Uint8Array): DecodedVector | undefined {
  if (raw.byteLength !== dim * 4) return undefined;
  const vec = new Float32Array(dim);
  new Uint8Array(vec.buffer).set(raw);
  let n = 0;
  for (const x of vec) n += x * x;
  return { ref, vec, norm: Math.sqrt(n) };
}

function removeCached(rows: DecodedVector[], ref: string): void {
  const pos = positions.get(rows)!;
  const i = pos.get(ref);
  if (i === undefined) return;
  const last = rows.pop()!;
  pos.delete(ref);
  if (i < rows.length) {
    rows[i] = last;
    pos.set(last.ref, i);
  }
}

function cachePut(row: { source: string; ref: string; model: string; dim: number; vec: Uint8Array }): void {
  const m = vectorCache.get(open());
  if (!m) return;
  for (const [key, rows] of m) {
    if (!key.startsWith(row.source + '\0')) continue;
    removeCached(rows, row.ref);
    if (key !== `${row.source}\0${row.model}`) continue;
    const d = decode(row.ref, row.dim, row.vec);
    if (!d) continue;
    positions.get(rows)!.set(row.ref, rows.length);
    rows.push(d);
  }
}

// Forgets the decoded vectors of `source`, so the next search rebuilds them from the table.
export function dropVectorCache(source: string): void {
  const m = vectorCache.get(open());
  if (!m) return;
  for (const key of [...m.keys()]) if (key.startsWith(source + '\0')) m.delete(key);
}

function cacheDelete(source: string, ref: string): void {
  const m = vectorCache.get(open());
  if (!m) return;
  for (const [key, rows] of m) if (key.startsWith(source + '\0')) removeCached(rows, ref);
}

export function decodedEmbeddingsOf(source: string, model: string): DecodedVector[] {
  const d = open();
  let m = vectorCache.get(d);
  if (!m) vectorCache.set(d, (m = new Map()));
  const key = `${source}\0${model}`;
  let rows = m.get(key);
  if (!rows) {
    rows = [];
    const pos = new Map<string, number>();
    for (const r of embeddingsOf(source, model)) {
      const v = decode(r.ref, r.dim, r.vec);
      if (!v) continue;
      pos.set(r.ref, rows.length);
      rows.push(v);
    }
    positions.set(rows, pos);
    m.set(key, rows);
  }
  return rows;
}

// How many rows each source has under the model, for `stam embedder status`.
export function embeddingCounts(): { source: string; model: string; n: number }[] {
  return open().prepare('SELECT source, model, COUNT(*) AS n FROM embeddings GROUP BY source, model').all() as { source: string; model: string; n: number }[];
}

// Mail with no vector from this model yet, newest first: the backfill's work list.
export function mailToEmbed(model: string, limit: number): { id: string }[] {
  return open()
    .prepare(
      `SELECT m.id FROM mail m LEFT JOIN embeddings e ON e.source = 'mail' AND e.ref = m.id
       WHERE e.ref IS NULL OR e.model != ? ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(model, limit) as { id: string }[];
}

export function getAgentBySession(sessionId: string): Agent | undefined {
  return open().prepare('SELECT * FROM agents WHERE session_id = ?').get(sessionId) as Agent | undefined;
}

// The agent's cost blockers as stored; blockers.ts parses them.
export function blockerRows(agentId: string): { agent_id: string; kind: string; account: string; reason: string; since: string; clear: string | null }[] {
  return open().prepare('SELECT * FROM blockers WHERE agent_id = ? ORDER BY since, rowid').all(agentId) as any;
}

export function deleteBlockers(agentId: string): void {
  open().prepare('DELETE FROM blockers WHERE agent_id = ?').run(agentId);
}

// What a poller last saw for one watched subject: its JSON snapshot and request ETags
// (watch_state above). The poller (src/sources/github.ts) reads and rewrites it.
export interface WatchState {
  subject: string;
  state: string;
  etags: string;
  updated_at: string;
}

export function getWatchState(subject: string): WatchState | undefined {
  return open().prepare('SELECT * FROM watch_state WHERE subject = ?').get(subject) as WatchState | undefined;
}

export function setWatchState(subject: string, state: unknown, etags: unknown): void {
  open()
    .prepare('INSERT INTO watch_state (subject, state, etags, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET state = excluded.state, etags = excluded.etags, updated_at = excluded.updated_at')
    .run(subject, JSON.stringify(state), JSON.stringify(etags ?? {}), now());
}

// The human's per-agent default view (agent_views above); no row means the global default.
export type AgentViewChoice = 'terminal' | 'conversation';
export function agentViews(): Map<string, AgentViewChoice> {
  const rows = open().prepare('SELECT agent_id, view FROM agent_views').all() as { agent_id: string; view: AgentViewChoice }[];
  return new Map(rows.map((r) => [r.agent_id, r.view]));
}
export function setAgentView(agentId: string, view: AgentViewChoice | null): void {
  if (view === null) open().prepare('DELETE FROM agent_views WHERE agent_id = ?').run(agentId);
  else open().prepare('INSERT INTO agent_views (agent_id, view, updated_at) VALUES (?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET view = excluded.view, updated_at = excluded.updated_at').run(agentId, view, now());
}

export interface Wait {
  id: string;
  agent_id: string;
  kind: string;
  target: string | null;
  detail: string | null;
  since: string;
  until: string | null;
  source: 'stam' | 'hook' | 'declared';
  data: string | null;
}

// Which wait names an agent's 'waiting' state when it has several.
const WAIT_RANK = ['human', 'agent', 'children', 'job', 'timer', 'event'];
const rank = (w: Wait) => (WAIT_RANK.indexOf(w.kind) + WAIT_RANK.length + 1) % (WAIT_RANK.length + 1);

export function listWaits(agentId: string): Wait[] {
  return (open().prepare('SELECT * FROM waits WHERE agent_id = ? ORDER BY since, rowid').all(agentId) as unknown as Wait[]).sort((a, b) => rank(a) - rank(b));
}

// Every agent's waits, as listWaits gives them, in one query (GET /api/agents).
export function listWaitsByAgent(): Map<string, Wait[]> {
  const out = new Map<string, Wait[]>();
  for (const w of open().prepare('SELECT * FROM waits ORDER BY since, rowid').all() as unknown as Wait[]) {
    (out.get(w.agent_id) ?? out.set(w.agent_id, []).get(w.agent_id)!).push(w);
  }
  for (const ws of out.values()) ws.sort((a, b) => rank(a) - rank(b));
  return out;
}

// The activity_detail of a waiting agent: its top wait, and how many there are.
export function waitSummary(waits: Wait[]): string {
  const w = waits[0];
  // An agent wait without a detail names the agent, as the web UI does: "kid's reply".
  const who = w.kind === 'agent' && w.target ? getAgent(w.target)?.name ?? w.target : null;
  const what = w.detail ?? (who ? `${who}'s reply` : w.target ? `${w.kind} ${w.target}` : w.kind);
  return `waiting for ${what}${waits.length > 1 ? ` (+${waits.length - 1} more)` : ''}`;
}

export function addWait(w: Pick<Wait, 'agent_id' | 'kind' | 'source'> & Partial<Pick<Wait, 'target' | 'detail' | 'until' | 'data'>>): Wait {
  const id = 'w' + randomBytes(5).toString('hex');
  open()
    .prepare('INSERT INTO waits (id, agent_id, kind, target, detail, since, until, source, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, w.agent_id, w.kind, w.target ?? null, w.detail ?? null, now(), w.until ?? null, w.source, w.data ?? null);
  syncWaits(w.agent_id);
  return open().prepare('SELECT * FROM waits WHERE id = ?').get(id) as unknown as Wait;
}

// Clears one wait by id; returns whether it existed.
export function clearWait(id: string): boolean {
  const w = open().prepare('SELECT agent_id FROM waits WHERE id = ?').get(id) as { agent_id: string } | undefined;
  if (!w) return false;
  open().prepare('DELETE FROM waits WHERE id = ?').run(id);
  syncWaits(w.agent_id);
  return true;
}

// Clears an agent's waits of one kind on one target (null matches waits without one);
// returns how many.
export function clearWaits(agentId: string, kind: string, target: string | null): number {
  const r = open().prepare('DELETE FROM waits WHERE agent_id = ? AND kind = ? AND target IS ?').run(agentId, kind, target);
  if (r.changes) syncWaits(agentId);
  return Number(r.changes);
}

// Updates one wait's short detail, such as a 'children' wait's count; the wait stays open,
// but a waiting agent's summary follows it.
export function updateWaitDetail(id: string, detail: string | null): void {
  const w = open().prepare('SELECT agent_id FROM waits WHERE id = ?').get(id) as { agent_id: string } | undefined;
  if (!w) return;
  open().prepare('UPDATE waits SET detail = ? WHERE id = ?').run(detail, id);
  syncWaits(w.agent_id);
}

export function getWait(id: string): Wait | undefined {
  return open().prepare('SELECT * FROM waits WHERE id = ?').get(id) as Wait | undefined;
}

// Waits whose `until` has passed: a declared wait's timeout, and stam's own timers. Hook
// waits (source 'hook') are the harness's own; stam tracks them but never fires them.
export function dueWaits(nowIso: string): Wait[] {
  return open()
    .prepare("SELECT * FROM waits WHERE until IS NOT NULL AND until <= ? AND (source = 'declared' OR (source = 'stam' AND kind = 'timer')) ORDER BY until, rowid")
    .all(nowIso) as unknown as Wait[];
}

// Moves a repeating timer's next fire time.
export function setWaitUntil(id: string, until: string): void {
  open().prepare('UPDATE waits SET until = ? WHERE id = ?').run(until, id);
}

let restingWaitsObserver: ((id: string) => void) | undefined;
export function onRestingWaitsChange(fn: (id: string) => void): void {
  restingWaitsObserver = fn;
}

// Sets an agent's activity from its waits: idle with waits becomes 'waiting', waiting
// without becomes 'idle', and a waiting agent's detail follows its waits. Working,
// blocked, errored, and starting agents keep theirs; their waits count once they go idle.
export function syncWaits(agentId: string): void {
  const a = getAgent(agentId);
  if (!a) return;
  const w = listWaits(agentId);
  // A resting agent's activity doesn't follow its waits, yet whether it has any decides whether it counts as busy
  // (RESTING_WAITING): the observer recomputes the children waits above it, as an activity change would.
  if (restOwned(a)) restingWaitsObserver?.(agentId);
  if (a.activity === 'waiting' && !w.length) updateAgent(agentId, { activity: 'idle', activity_detail: 'waits cleared' });
  else if (a.activity === 'idle' && w.length) updateAgent(agentId, { activity: 'idle', activity_detail: a.activity_detail });
  else if (a.activity === 'waiting' && a.activity_detail !== waitSummary(w)) updateAgent(agentId, { activity_detail: waitSummary(w) });
}

// The directory of agents on other machines (peer_agents). Archived agents stay, marked, so mail
// to one queues without starting its peer (S-245).
// What each remembered peer agent was last written as: GET /api/agents remembers every peer agent on
// each call (S-344), so an unchanged one isn't written again. updated_at is kept only as a record; nothing reads it.
const remembered = new Map<string, string>();
// A peer agent's busy flag counts only while it is this fresh (S-1652): it is rewritten while the agent stays busy
// and listed (every PEER_BUSY_REFRESH_MS at most), so a flag nobody refreshed, with the peer down or the agent gone,
// stops holding a parent's wait and its tree-idle notice after this long.
export const PEER_BUSY_FRESH_MS = 15 * 60_000;
const PEER_BUSY_REFRESH_MS = 5 * 60_000;

// Called with a peer agent's id when its busy flag changes, from whichever path remembered it; org.ts installs
// the one that re-syncs the parents' waits and tree-idle notices.
let peerBusyObserver: ((id: string) => void) | undefined;
export function onPeerBusyChange(fn: (id: string) => void): void {
  peerBusyObserver = fn;
}

// `activity` and `pending_requests` come from a listing or a spawn reply; a call without activity keeps the busy
// flag known. A busy change calls the onPeerBusyChange observer.
export function rememberPeerAgent(a: { id: string; name: string; machine: string; lifecycle?: string; parents?: string[]; parent_id?: string | null; activity?: string; pending_requests?: number; paused_by?: string | null; waits?: unknown[] }): void {
  // A listing carries every parent; a fresh spawn's reply (spawnOnPeer) carries only parent_id.
  const list = a.parents ?? (a.parent_id ? [a.parent_id] : undefined);
  const parents = list ? JSON.stringify(list) : null;
  const busy = a.activity === undefined ? null : a.lifecycle !== 'archived' && ((BUSY_ACTIVITIES as readonly string[]).includes(a.activity) || (a.pending_requests ?? 0) > 0 || restingWithWaits(a)) ? 1 : 0;
  // A busy agent is written again each refresh window, which keeps its busy_at fresh.
  const key = `${a.name}|${a.machine}|${a.lifecycle ?? ''}|${parents ?? ''}|${busy ?? ''}${busy ? '|' + Math.floor(Date.now() / PEER_BUSY_REFRESH_MS) : ''}`;
  if (remembered.get(a.id) === key) return;
  const before = peerAgentBusy(a.id);
  open().prepare('INSERT INTO peer_agents (id, name, machine, updated_at, lifecycle, parents, busy, busy_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, machine = excluded.machine, updated_at = excluded.updated_at, lifecycle = COALESCE(excluded.lifecycle, peer_agents.lifecycle), parents = COALESCE(excluded.parents, peer_agents.parents), busy = COALESCE(excluded.busy, peer_agents.busy), busy_at = CASE WHEN excluded.busy IS NULL THEN peer_agents.busy_at ELSE excluded.busy_at END').run(a.id, a.name, a.machine, now(), a.lifecycle ?? null, parents, busy, busy ? now() : null);
  remembered.set(a.id, key);
  expiredSeen.delete(a.id);
  if (peerAgentBusy(a.id) !== before) peerBusyObserver?.(a.id);
}

// Whether a remembered peer agent counts as busy now: its flag is set and fresh. False when unknown.
export function peerAgentBusy(id: string): boolean {
  const row = open().prepare('SELECT busy, busy_at FROM peer_agents WHERE id = ?').get(id) as { busy: number | null; busy_at: string | null } | undefined;
  return !!row?.busy && !!row.busy_at && Date.parse(row.busy_at) > Date.now() - PEER_BUSY_FRESH_MS;
}

// Peer agents flagged busy whose flag has gone stale since the last call, once each until they are written again:
// the daemon's peer sweep (S-1652) tells their parents, since nothing else changes when a flag only expires.
const expiredSeen = new Set<string>();
export function expiredPeerBusy(): string[] {
  const cutoff = new Date(Date.now() - PEER_BUSY_FRESH_MS).toISOString();
  const rows = open().prepare('SELECT id FROM peer_agents WHERE busy = 1 AND busy_at <= ?').all(cutoff) as { id: string }[];
  const out = rows.map((r) => r.id).filter((id) => !expiredSeen.has(id));
  for (const id of out) expiredSeen.add(id);
  return out;
}

// The parents remembered for a peer agent.
export function peerParentsOf(id: string): string[] {
  const row = open().prepare('SELECT parents FROM peer_agents WHERE id = ?').get(id) as { parents: string | null } | undefined;
  return row?.parents ? (JSON.parse(row.parents) as string[]) : [];
}

// A remembered agent on another machine, by id or name.
// The name an agent last sent mail under, for one this daemon no longer knows (forgotten).
export function lastSenderName(id: string): string | undefined {
  return (open().prepare('SELECT from_name FROM mail WHERE from_id = ? AND from_name IS NOT NULL ORDER BY created_at DESC LIMIT 1').get(id) as { from_name: string } | undefined)?.from_name;
}

export function findPeerAgent(ref: string): { id: string; name: string; machine: string } | undefined {
  return open().prepare('SELECT id, name, machine FROM peer_agents WHERE id = ? OR name = ? ORDER BY id = ? DESC LIMIT 1').get(ref, ref, ref) as any;
}

// A remembered peer agent with this exact id (S-577), or undefined. Only the id column: a peer
// agent whose name happens to equal an id is not the same agent.
export function peerAgentById(id: string): { id: string; name: string; machine: string } | undefined {
  return open().prepare('SELECT id, name, machine FROM peer_agents WHERE id = ?').get(id) as any;
}

// Every parent link of the remembered peer agents. Only src/tree.ts and the attribution index read this.
export function peerParentLinks(): { child_id: string; parent_id: string }[] {
  const rows = open().prepare('SELECT id, parents FROM peer_agents WHERE parents IS NOT NULL').all() as { id: string; parents: string }[];
  return rows.flatMap((r) => (JSON.parse(r.parents) as string[]).map((parent_id) => ({ child_id: r.id, parent_id })));
}

// The remembered peer agents that list `id` as a parent. Callers use tree.childrenOf. Scans the whole table: fine at our size, so not indexed.
export function peerChildrenOf(id: string): string[] {
  return peerParentLinks().filter((l) => l.parent_id === id).map((l) => l.child_id);
}

// The lifecycle a remembered peer agent was last seen with, or undefined when unknown.
export function peerAgentLifecycle(id: string): string | undefined {
  const row = open().prepare('SELECT lifecycle FROM peer_agents WHERE id = ?').get(id) as { lifecycle: string | null } | undefined;
  return row?.lifecycle ?? undefined;
}

export function forgetPeerAgent(ref: string): void {
  remembered.clear();
  open().prepare('DELETE FROM peer_agents WHERE id = ? OR name = ?').run(ref, ref);
}

export interface OutboxRow {
  mail_id: string;
  peer: string;
  body: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

export function queueOutbox(mailId: string, peer: string, body: string): void {
  open().prepare('INSERT OR IGNORE INTO peer_outbox (mail_id, peer, body, created_at, attempts, last_error) VALUES (?, ?, ?, ?, 0, NULL)').run(mailId, peer, body, now());
}

// A mail title (S-297) rides on the forward still queued for a peer. True when there was one.
export function outboxSetTitle(mailId: string, peer: string, title: string, summary?: string): boolean {
  const d = open();
  const row = d.prepare('SELECT body FROM peer_outbox WHERE mail_id = ? AND peer = ?').get(mailId, peer) as { body: string } | undefined;
  if (!row) return false;
  d.prepare('UPDATE peer_outbox SET body = ? WHERE mail_id = ? AND peer = ?').run(JSON.stringify({ ...JSON.parse(row.body), ...(title ? { title } : {}), ...(summary ? { summary } : {}) }), mailId, peer);
  return true;
}

export function outboxHasPeer(peer: string): boolean {
  return !!open().prepare('SELECT 1 FROM peer_outbox WHERE peer = ? LIMIT 1').get(peer);
}

// Queued mail, oldest first across all peers.
export function outboxRows(): OutboxRow[] {
  return open().prepare('SELECT * FROM peer_outbox ORDER BY created_at, rowid').all() as unknown as OutboxRow[];
}

export function outboxDelete(mailId: string, peer: string): void {
  open().prepare('DELETE FROM peer_outbox WHERE mail_id = ? AND peer = ?').run(mailId, peer);
}

export function outboxFailed(mailId: string, peer: string, error: string): void {
  open().prepare('UPDATE peer_outbox SET attempts = attempts + 1, last_error = ? WHERE mail_id = ? AND peer = ?').run(error, mailId, peer);
}

// Queued mail older than `before` (an ISO time), removed and returned.
export function outboxExpire(before: string): OutboxRow[] {
  const d = open();
  const old = d.prepare('SELECT * FROM peer_outbox WHERE created_at < ?').all(before) as unknown as OutboxRow[];
  d.prepare('DELETE FROM peer_outbox WHERE created_at < ?').run(before);
  return old;
}

// Removes a stopped agent from the registry, with its events and mailbox.
export function forgetAgent(id: string): void {
  const d = open();
  d.prepare('DELETE FROM events WHERE agent_id = ?').run(id);
  d.prepare('DELETE FROM mail_recipients WHERE agent_id = ?').run(id);
  d.prepare('DELETE FROM mail_deliveries WHERE agent_id = ?').run(id);
  deleteBlockers(id);
  d.prepare('DELETE FROM waits WHERE agent_id = ?').run(id);
  d.prepare('DELETE FROM agent_views WHERE agent_id = ?').run(id);
  d.prepare('DELETE FROM workspace_grants WHERE grantee_id = ?').run(id);
  d.prepare("UPDATE permission_requests SET status = 'withdrawn', decided_at = ? WHERE agent_id = ? AND status = 'pending'").run(now(), id);
  d.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

export interface PermissionRequest {
  id: string;
  agent_id: string;
  action: string;
  reason: string;
  details: string;
  // An input suggestion (S-422) adds: held (approved, waiting for the agent's box to be free),
  // expired (not approved, or not typed, by expires_at), and failed (typed, but the box didn't show it).
  status: 'pending' | 'approved' | 'denied' | 'withdrawn' | 'held' | 'expired' | 'failed';
  // request (request_permission), dialog (a harness dialog), settings (S-362), or input (suggest_input, S-422).
  kind: 'request' | 'dialog' | 'settings' | 'input';
  // 1 for a harness dialog stam saw on the agent's screen, 0 for request_permission.
  dialog: number;
  // 'human': only the human approves. 'delegate': the parent or chief of staff decides, or escalates it to 'human'.
  audience: 'human' | 'delegate';
  // JSON for a request stam carries out when the human approves (a settings change); null otherwise.
  payload: string | null;
  // Kind input only: the exact text to type, its sha256 (hex), and when the suggestion expires.
  text: string | null;
  sha256: string | null;
  expires_at: string | null;
  session_id: string | null;
  decided_by: string | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

// A request as agents and the web UI see it, with its agent's name and machine.
export type PublicRequest = Omit<PermissionRequest, 'payload'> & { agent_name: string | null; machine: string; with?: string[]; subject?: string };

export function createPermissionRequest(agentId: string, action: string, reason: string, details: string, dialog = false, payload: string | null = null, audience: 'human' | 'delegate' = 'human', input?: { text: string; sha256: string; expires_at: string }): PermissionRequest {
  const id = 'p' + randomBytes(4).toString('hex').slice(0, 6);
  const kind = input ? 'input' : dialog ? 'dialog' : payload ? 'settings' : 'request';
  open()
    .prepare('INSERT INTO permission_requests (id, agent_id, action, reason, details, dialog, payload, audience, kind, text, sha256, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, agentId, action, reason, details, dialog ? 1 : 0, payload, audience, kind, input?.text ?? null, input?.sha256 ?? null, input?.expires_at ?? null, now());
  return getPermissionRequest(id)!;
}

export function getPermissionRequest(id: string): PermissionRequest | undefined {
  return open().prepare('SELECT * FROM permission_requests WHERE id = ?').get(id) as PermissionRequest | undefined;
}

// Whether the agent has an unresolved permission request; org.ts counts that as busy, so
// a parent's tree-idle notice waits for the answer.
// A resting agent (S-1982) has no harness, so its activity is 'unknown', but one with a wait still waits: it
// counts as busy, so its parent keeps its children wait and the tree above it hears no false tree-idle notice.
// Rest-owned: paused with lifecycle.REST_OWNER among its pause owners, so a human, agent or cost pause added on
// top of the rest (lifecycle.pause) doesn't change whether it counts as busy.
const REST_OWNER_JSON = '"standing-idle"';
export const REST_PAUSED_BY = `[${REST_OWNER_JSON}]`;
const RESTING_WAITING = `(a.lifecycle = 'paused' AND instr(a.paused_by, '${REST_OWNER_JSON}') > 0 AND EXISTS (SELECT 1 FROM waits w WHERE w.agent_id = a.id))`;
export const restOwned = (a: { lifecycle?: string; paused_by?: string | null }): boolean =>
  a.lifecycle === 'paused' && !!a.paused_by && a.paused_by.includes(REST_OWNER_JSON);
export const restingWithWaits = (a: { lifecycle?: string; paused_by?: string | null; waits?: unknown[] }): boolean =>
  restOwned(a) && (a.waits?.length ?? 0) > 0;

// How many agents below `id` (children, their children, and so on, through adoptions and the parents remembered
// for peer agents) are busy: a local one working, blocked, waiting, starting, or holding a pending permission
// request; a peer one with a busy flag fresher than PEER_BUSY_FRESH_MS (S-1652). One recursive query over the
// parent indexes, so the cost is the subtree's rows in SQLite, not a lookup per agent in JS. The peer links are
// unpacked from peer_agents.parents once per call (pe, materialized): joined per step instead, every agent in the
// subtree re-read every peer row's JSON, and one call at the root took 0.1-0.7 s (S-1725).
export function busyDescendantCount(id: string): number {
  const fresh = new Date(Date.now() - PEER_BUSY_FRESH_MS).toISOString();
  const r = open()
    .prepare(
      `WITH RECURSIVE pe(child_id, parent_id) AS MATERIALIZED (
         SELECT pa.id, j.value FROM peer_agents pa, json_each(pa.parents) j WHERE pa.parents IS NOT NULL
       ),
       d(id) AS (
         SELECT id FROM agents WHERE parent_id = ?1
         UNION SELECT child_id FROM agent_parents WHERE parent_id = ?1
         UNION SELECT child_id FROM pe WHERE parent_id = ?1
         UNION SELECT a.id FROM agents a JOIN d ON a.parent_id = d.id
         UNION SELECT p.child_id FROM agent_parents p JOIN d ON p.parent_id = d.id
         UNION SELECT pe.child_id FROM pe JOIN d ON pe.parent_id = d.id
       )
       SELECT count(*) AS n FROM d
       WHERE EXISTS (SELECT 1 FROM agents a WHERE a.id = d.id AND (a.activity IN ('working', 'blocked', 'waiting', 'starting')
               OR EXISTS (SELECT 1 FROM permission_requests r WHERE r.agent_id = a.id AND r.status = 'pending') OR ${RESTING_WAITING}))
          OR (NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = d.id)
              AND EXISTS (SELECT 1 FROM peer_agents pa WHERE pa.id = d.id AND pa.busy = 1 AND pa.busy_at > ?2))`,
    )
    .get(id, fresh) as { n: number };
  return r.n;
}

// Whether a local agent is busy by the rules busyIds and busyDescendantCount apply in SQL: a busy activity, a
// pending permission request, or resting with a wait. Every reader of one agent's busy-ness in JS uses this.
export function isBusy(a: Agent): boolean {
  return (BUSY_ACTIVITIES as readonly string[]).includes(a.activity) || hasPendingPermission(a.id) || restingWithWaits({ ...a, waits: listWaits(a.id) });
}

// Whether the agent keeps a machine that shuts itself down when idle up (daemon.ts, STAM_HOME/busy): an active one
// with a busy activity, or a resting one with a wait, whose timer or answer needs the daemon running (S-1982).
export function keepsMachineUp(a: Agent): boolean {
  return (a.lifecycle === 'active' && BUSY_ACTIVITIES.includes(a.activity)) || restingWithWaits({ ...a, waits: listWaits(a.id) });
}

// Every agent busyDescendantCount counts as busy, local and peer, by the same rules: what tree.busyDescendantCounts
// walks up from to count every agent's busy descendants at once.
export function busyIds(): string[] {
  const fresh = new Date(Date.now() - PEER_BUSY_FRESH_MS).toISOString();
  const rows = open()
    .prepare(
      `SELECT a.id FROM agents a WHERE a.activity IN ('working', 'blocked', 'waiting', 'starting')
          OR EXISTS (SELECT 1 FROM permission_requests r WHERE r.agent_id = a.id AND r.status = 'pending') OR ${RESTING_WAITING}
       UNION SELECT pa.id FROM peer_agents pa WHERE pa.busy = 1 AND pa.busy_at > ?
          AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = pa.id)`,
    )
    .all(fresh) as { id: string }[];
  return rows.map((r) => r.id);
}

export function hasPendingPermission(agentId: string): boolean {
  return !!open().prepare("SELECT 1 FROM permission_requests WHERE agent_id = ? AND status = 'pending'").get(agentId);
}

// The agent's pending request for a harness dialog, if one is open.
export function pendingDialog(agentId: string): PermissionRequest | undefined {
  return open().prepare("SELECT * FROM permission_requests WHERE agent_id = ? AND status = 'pending' AND dialog = 1").get(agentId) as PermissionRequest | undefined;
}

// Closes a pending request nobody answered through stam, such as a dialog answered in the terminal.
export function withdrawPermissionRequest(id: string, note: string): void {
  open().prepare("UPDATE permission_requests SET status = 'withdrawn', note = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(note, now(), id);
}

// A request as agents and the web UI see it: the payload (new settings text, secrets included) stays inside stam.
// A pending delegate ask also names who it is with (`with`): the reviewers its mail went to, and
// that mail's subject, which says what the agent wants ("helper wants to run: git …", S-594).
export function publicRequest<T extends PermissionRequest>(r: T): Omit<T, 'payload'> & { agent_name: string | null; machine: string; with?: string[]; subject?: string } {
  const { payload: _payload, ...rest } = r;
  const a = getAgent(r.agent_id);
  const out = { ...rest, agent_name: a?.name ?? null, machine: a?.machine ?? MACHINE };
  if (r.audience !== 'delegate' || r.status !== 'pending') return out;
  const subject = (open().prepare('SELECT subject FROM mail WHERE permission_id = ? ORDER BY created_at LIMIT 1').get(r.id) as { subject: string } | undefined)?.subject;
  return { ...out, with: permissionMailRecipients(r.id).map((id) => getAgent(id)?.name ?? findPeerAgent(id)?.name ?? id), ...(subject ? { subject } : {}) };
}

export function listPermissionRequests(status?: string): PublicRequest[] {
  return (status
    ? open().prepare('SELECT * FROM permission_requests WHERE status = ? ORDER BY created_at DESC').all(status)
    : open().prepare('SELECT * FROM permission_requests ORDER BY created_at DESC LIMIT 100').all()
  ).map((r) => publicRequest(r as unknown as PermissionRequest));
}

// A delegate ask the reviewers escalated, or nobody answered in time: from now on it is the human's.
// Returns whether this call moved it, so an escalation, the timeout, and an answer never both win.
export function escalatePermissionRequest(id: string): boolean {
  return open().prepare("UPDATE permission_requests SET audience = 'human' WHERE id = ? AND status = 'pending' AND audience = 'delegate'").run(id).changes > 0;
}

// Every agent's pending harness-dialog request, oldest first (S-589).
export function pendingDialogs(): PermissionRequest[] {
  return open().prepare("SELECT * FROM permission_requests WHERE status = 'pending' AND dialog = 1 ORDER BY created_at").all() as unknown as PermissionRequest[];
}

// Who a request's first mail went to, besides the human: the reviewers a delegate ask was sent to (S-589),
// in the order it named them (parent first).
export function permissionMailRecipients(requestId: string): string[] {
  return (open().prepare("SELECT r.agent_id FROM mail_recipients r JOIN mail m ON m.id = r.mail_id WHERE m.id = (SELECT id FROM mail WHERE permission_id = ? ORDER BY created_at LIMIT 1) AND r.agent_id != 'human' ORDER BY r.rowid").all(requestId) as { agent_id: string }[]).map((x) => x.agent_id);
}

// Clears what waits on someone for this request: the agent's stam wait, whichever audience it was
// waiting on, and the agent's own wait_for human tied to it (S-609, waits.ts). Its decision mails
// about the request go too: the ones that name it, or sit in its thread. A request and the asks an
// agent adds about it are one item, so they settle together.
export function clearRequestWaits(agentId: string, requestId: string): void {
  const n = open().prepare("DELETE FROM waits WHERE agent_id = ? AND ((source = 'stam' AND (target = ? OR data = ?)) OR (kind = 'human' AND target = ?))").run(agentId, requestId, requestId, requestId).changes;
  if (n) syncWaits(agentId);
  clearRequestDecisionMails(agentId, requestId);
  for (const fn of settledObservers) fn(requestId);
}

// Observers of a request settling, or leaving its first audience (S-637's auto-archive pass).
const settledObservers: ((requestId: string) => void)[] = [];
export function onRequestSettled(fn: (requestId: string) => void): void {
  settledObservers.push(fn);
}

// The agent's decision mails about a request (S-609): they name it, or sit in its thread. `before`
// keeps a later mail, a new question asked after the request settled.
export function clearRequestDecisionMails(agentId: string, requestId: string, before?: string): number {
  return Number(open()
    .prepare(`DELETE FROM decision_mails WHERE mail_id IN (SELECT m.id FROM decision_mails d JOIN mail m ON m.id = d.mail_id WHERE m.from_id = ? AND m.created_at <= ?
      AND (instr(m.subject, ?) > 0 OR instr(m.body, ?) > 0 OR d.thread_id IN (SELECT COALESCE(thread_id, id) FROM mail WHERE permission_id = ?)))`)
    .run(agentId, before ?? '9999', requestId, requestId, requestId).changes);
}

// The permission request whose thread this is (its mail started it), if any.
export function requestOfThread(threadId: string): string | undefined {
  const r = open().prepare('SELECT permission_id FROM mail WHERE (id = ? OR thread_id = ?) AND permission_id IS NOT NULL ORDER BY created_at LIMIT 1').get(threadId, threadId) as { permission_id: string } | undefined;
  return r?.permission_id;
}

export type RequestState = Pick<PermissionRequest, 'id' | 'status' | 'audience' | 'created_at' | 'decided_at'>;

// An agent's requests, newest first: what its waits on the human may be about (waits.ts, org.ts).
export function agentRequests(agentId: string): RequestState[] {
  return open().prepare('SELECT id, status, audience, created_at, decided_at FROM permission_requests WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC').all(agentId) as unknown as RequestState[];
}

// Ties a wait to what it waits on (S-609): a wait_for human to the request it is about.
export function setWaitTarget(id: string, target: string): void {
  const w = open().prepare('SELECT agent_id FROM waits WHERE id = ?').get(id) as { agent_id: string } | undefined;
  if (!w) return;
  open().prepare('UPDATE waits SET target = ? WHERE id = ?').run(target, id);
  syncWaits(w.agent_id);
}

export function decidePermissionRequest(id: string, approve: boolean, by: string, note: string): void {
  open()
    .prepare("UPDATE permission_requests SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
    .run(approve ? 'approved' : 'denied', by, note, now(), id);
}

// Moves an input suggestion from one status to another, only if it is still in `from` (S-422).
// `unexpired` also requires expires_at to be in the future. Returns whether this call moved it,
// so two answers, or an answer and the expiry sweep, never both win.
export function moveInputRequest(id: string, from: PermissionRequest['status'], to: PermissionRequest['status'], fields: { by?: string; note?: string; unexpired?: boolean; session?: string | null } = {}): boolean {
  const r = open()
    .prepare(
      `UPDATE permission_requests SET status = ?, decided_by = COALESCE(?, decided_by), note = COALESCE(?, note), session_id = COALESCE(?, session_id), decided_at = COALESCE(decided_at, ?) WHERE id = ? AND kind = 'input' AND status = ?${fields.unexpired ? ' AND expires_at > ?' : ''}`,
    )
    .run(to, fields.by ?? null, fields.note ?? null, fields.session ?? null, now(), id, from, ...(fields.unexpired ? [now()] : []));
  return Number(r.changes) === 1;
}

// What a held approval waits on, for the card: the text in the agent's input box (S-534), or none.
// While a request is held its note is this and nothing else; a move to another status keeps it (COALESCE),
// so readers look at it only for a held request.
export function setHeldBox(id: string, box: string | null): void {
  open().prepare("UPDATE permission_requests SET note = ? WHERE id = ? AND kind = 'input' AND status = 'held'").run(box === null ? null : `box:${box}`, id);
}

// The mail that carried a permission request to the human, to reply in its thread.
export function permissionMail(id: string): { id: string; thread_id: string } | undefined {
  return open().prepare('SELECT id, thread_id FROM mail WHERE permission_id = ? ORDER BY created_at LIMIT 1').get(id) as { id: string; thread_id: string } | undefined;
}

// Input suggestions in a status, oldest first: for an agent, or every agent's.
export function inputRequests(status: 'pending' | 'held', agentId?: string): PermissionRequest[] {
  return (agentId
    ? open().prepare("SELECT * FROM permission_requests WHERE kind = 'input' AND status = ? AND agent_id = ? ORDER BY created_at").all(status, agentId)
    : open().prepare("SELECT * FROM permission_requests WHERE kind = 'input' AND status = ? ORDER BY created_at").all(status)) as unknown as PermissionRequest[];
}

export interface PushDevice {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  origin: string | null;
  kinds: string[];
  created_at: string;
  last_ok_at: string | null;
  last_error: string | null;
}

const pushDevice = (r: any): PushDevice => ({ ...r, kinds: JSON.parse(r.kinds) });

// A device subscribing again (same endpoint) keeps its id and choices, with fresh keys.
// A renewed subscription names the endpoint it replaces, and takes that device's place.
export function savePushDevice(d: { endpoint: string; p256dh: string; auth: string; label: string; origin: string | null; kinds: string[]; replaces?: string }): PushDevice {
  const find = (e: string) => open().prepare('SELECT id FROM push_devices WHERE endpoint = ?').get(e) as { id: string } | undefined;
  const old = find(d.endpoint) ?? (d.replaces ? find(d.replaces) : undefined);
  if (old) {
    open().prepare('UPDATE push_devices SET endpoint = ?, p256dh = ?, auth = ?, label = ?, origin = COALESCE(?, origin), last_error = NULL WHERE id = ?').run(d.endpoint, d.p256dh, d.auth, d.label, d.origin, old.id);
    return getPushDevice(old.id)!;
  }
  const id = 'd' + randomBytes(4).toString('hex');
  open()
    .prepare('INSERT INTO push_devices (id, endpoint, p256dh, auth, label, origin, kinds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, d.endpoint, d.p256dh, d.auth, d.label, d.origin, JSON.stringify(d.kinds), now());
  return getPushDevice(id)!;
}

export function getPushDevice(id: string): PushDevice | undefined {
  const r = open().prepare('SELECT * FROM push_devices WHERE id = ?').get(id);
  return r ? pushDevice(r) : undefined;
}

export function listPushDevices(): PushDevice[] {
  return open().prepare('SELECT * FROM push_devices ORDER BY created_at').all().map(pushDevice);
}

export function updatePushDevice(id: string, f: { label?: string; kinds?: string[]; last_ok_at?: string; last_error?: string | null }): void {
  const cur = getPushDevice(id);
  if (!cur) return;
  open()
    .prepare('UPDATE push_devices SET label = ?, kinds = ?, last_ok_at = ?, last_error = ? WHERE id = ?')
    .run(f.label ?? cur.label, JSON.stringify(f.kinds ?? cur.kinds), f.last_ok_at ?? cur.last_ok_at, f.last_error === undefined ? cur.last_error : f.last_error, id);
}

export function deletePushDevice(id: string): boolean {
  return open().prepare('DELETE FROM push_devices WHERE id = ?').run(id).changes > 0;
}
