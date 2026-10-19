// Shapes of what the daemon's /api returns, as far as the web UI reads them.
import type { Conformity } from './req/model'

export type Lifecycle = 'active' | 'paused' | 'shut_down' | 'archived' | string

// What an agent whose turn ended still waits for; any makes it 'waiting'.
export interface Wait {
  id: string
  kind: string
  target?: string | null
  detail?: string | null
  since: string
  until?: string | null
  source: string
  // The mail thread a human wait is tied to (S-351), from the wait_for that declared it; null if none.
  thread?: string | null
}

// What a resting agent (S-1969) rests for, as /api/agents reports it: why, what it waits for, and when it is
// expected to wake (ISO; null with no known time).
export interface Resting {
  reason: 'idle' | 'wait'
  waits: { id: string; kind: string; target: string | null; detail: string | null; since: string; until: string | null }[]
  expected_wake: string | null
}

export interface AgentLoad {
  open_itsas: number
  median_lead_s: number | null
  lead_n: number
  context_tokens: number | null
  context_threshold: number
  context_ratio: number | null
  workspace_bytes: number | null
  workspace_files: number | null
  workspace_capped?: boolean
}
export interface Agent {
  id: string
  name: string
  role?: string | null
  harness: string
  model?: string | null
  effort?: string | null
  kind?: string | null
  // The agent type it was spawned as, such as developer or reviewer.
  type?: string | null
  lifecycle: Lifecycle
  activity?: string | null
  activity_detail?: string | null
  context_tokens?: number | null
  // A long-lived specialist (S-874); `load` is the daemon's numbers for it (S-919), set for standing agents only.
  standing?: number | boolean
  load?: AgentLoad | null
  context_level?: number | null
  context_window?: number | null
  cost_usd?: number | null
  // The cost numbers the daemon adds (S-316), in the user's chosen unit `mode`; null from an older daemon.
  cost?: AgentCost | null
  machine: string
  cwd: string
  parents?: string[]
  parent_id?: string | null
  chief_of_staff?: number | boolean
  permission_mode?: string | null
  // 'settings': follows Settings › Permission modes; 'manual': the human's own pick. Null on an agent from before S-1967.
  permission_source?: string | null
  child_notices?: string | null
  // Set on an optimistic copy (optimistic.ts) while the change is in flight: what the agent is doing, such as 'pausing'.
  pending?: string | null
  unread?: number
  waits?: Wait[]
  // Set while the agent rests: its harness is stopped and its session kept. It stays live and wakes on mail, a notice or a prompt.
  resting?: Resting | null
  pending_requests?: number
  // Whether the agent is in at least one open ITSA (step 10); false only when it is in none.
  in_itsa?: boolean
  // What stam's own view of its conversation offers (S-78), or null when it has none.
  view?: { can_stream: boolean; can_send: boolean; can_interrupt: boolean; can_approve: boolean } | null
  // The view the human opens it in (S-82), kept by the daemon the browser reaches; null
  // follows Settings' default.
  default_view?: 'terminal' | 'conversation' | null
  created_at: string
  updated_at: string
  last_message?: string | null
}

export interface Permission {
  id: string
  agent_id: string
  // held, expired and failed are for an input suggestion (S-422).
  status: 'pending' | 'approved' | 'denied' | 'withdrawn' | 'held' | 'expired' | 'failed' | string
  // request, dialog, settings, or input (S-422: suggested harness input, which only the human types).
  kind?: 'request' | 'dialog' | 'settings' | 'input' | null
  // The machine the agent runs on, and its name (the daemon's public shape).
  agent_name?: string | null
  machine?: string | null
  // Kind input only: the exact text to type, its sha256 (the server's; the page hashes its own), and when it expires.
  text?: string | null
  sha256?: string | null
  expires_at?: string | null
  action?: string | null
  reason?: string | null
  details?: string | null
  decided_by?: string | null
  decided_at?: string | null
  note?: string | null
  created_at?: string
  // 1 for a harness dialog stam saw on the agent's screen, which blocks the agent until answered (S-276).
  dialog?: number | null
  // Who decides it first: the human, or the agent's parent and the chief of staff (S-432).
  audience?: 'human' | 'delegate' | null
  // A pending delegate ask: the names of the reviewers its mail went to, and that mail's subject (S-594).
  with?: string[]
  subject?: string
}

export interface Ring {
  id: string
  name: string
  format: string
  round: number
  max_rounds: number
  status: string
  members: string
}

export interface Recipient {
  id: string
  read_at?: string | null
  // Pulled from the human once someone else settled it (S-413): who, when, and the line to show.
  withdrawn_at?: string | null
  withdrawn_by?: string | null
  withdrawn_note?: string | null
}

export interface Attachment {
  name: string
  size?: number
  // The file's absolute path on the machine that stores the mail; the file view opens it (S-1529).
  path?: string
}

// An ITSA a mail is linked to, with the link's source.
export interface MailItsa { id: string; key: string; title: string; status: string; source: 'itsa' | 'named' | 'thread' | 'attached' }

export interface Mail {
  id: string
  from_id: string
  from_name?: string | null
  subject?: string | null
  body: string
  recipients: Recipient[]
  attachments?: Attachment[]
  created_at: string
  permission_id?: string | null
  permission?: Permission | null
  // The mail its sender named as replacing this one (S-1304): this one stays, dimmed, in its thread.
  superseded_by?: string | null
  auto_threaded?: number | boolean
  // A mail in an ITSA's thread: a comment, or an owner's update with a health.
  itsa_id?: string | null
  // The ITSA the mail is about: named by the sender, else the ITSA of its thread (S-91).
  about_itsa?: string | null
  // The ITSAs the mail is linked to (S-986): what the sender named, keys in its text, and the ITSA of its thread.
  itsas?: MailItsa[]
  // The agents attached to the mail (S-1305), by id.
  agents?: string[]
  kind?: 'comment' | 'update' | string | null
  health?: string | null
  // The decision model's verdict on a mail to the human; null until it is checked.
  verdict?: MailVerdict | null
  // The reason the sender gave to send this mail past the mail gate (S-983); null on every other mail.
  override?: string | null
  // A 1-3 word title a cheap model gave the mail, for scanning (S-297); null when titles are off.
  title?: string | null
  // A one-line summary of a mail to the human from the same model (S-1001), for the swipe cards; null when absent.
  summary?: string | null
  // The mail this one replies to: an ask names the owner's comment it repeats.
  reply_to?: string | null
  thread_id?: string | null
  // A reply the human sent that the daemon hasn't confirmed yet; local to the thread view.
  pending?: boolean
}

export interface MailVerdict {
  follows: boolean
  score: number
  concise: number | null
  fluff: number | null
  value: number | null
  kind?: string
  kind_confidence?: number
  at: string
}

export interface Thread {
  thread_id: string
  mails: Mail[]
}

export interface PlainShell {
  id: string
  machine: string
  cwd: string
}

export interface Thresholds {
  warnTokens: number
  instructTokens: number
  enforceTokens: number
}

// One row from `GET /api/search`, ranked with everything else the query matched.
export type SearchKind = 'agent' | 'thread' | 'itsa' | 'setting'
export interface SearchResult {
  kind: SearchKind
  id: string
  title: string
  snippet?: string
  meta?: string
  score: number
  section?: string
  item?: string
}

export interface UploadFile {
  name: string
  type: string
  size: number
  content_b64: string
}

// ITSAs (issue management): one nestable item; see docs/itsa-design.md.
export type ItsaCategory = 'backlog' | 'ready' | 'active' | 'review' | 'closed'
export type Rollup = Record<ItsaCategory, number>

export interface ItsaStatus {
  name: string
  category: ItsaCategory
  // Waits on the human.
  human: boolean
}

export interface Itsa {
  id: string
  key: string
  parent_id: string | null
  kind: string | null
  title: string
  summary: string | null
  body: string | null
  status: string
  owner: string | null
  thread_id: string | null
  created_by: string
  created_at: string
  updated_at: string
  closed_at: string | null
  // Its place in a board column, lower first; null sorts by creation time.
  rank?: number | null
  // From the owner's latest update, once updates exist (step 3).
  health?: 'on_track' | 'at_risk' | 'off_track' | null
  // GET /api/itsas carries each ITSA's links, for board cards.
  links?: ItsaLink[]
  // Set on an optimistic copy (optimistic.ts) until the daemon and a poll agree; never polled.
  pending?: boolean
  // And its participants (agents and `human`; the owner is always one).
  participants?: string[]
  // Field values by the field's key (S-364); GET /api/itsas carries them.
  fields?: Record<string, unknown>
}

// What the human can do to an ITSA waiting on them (settings.itsa.actions).
export interface ItsaAction {
  id: string
  label: string
  to: string
  text: 'none' | 'optional' | 'required'
}

// An ITSA in a human status, as the attention list shows it: when it entered the status.
export interface ItsaAttention extends Itsa {
  since: string
  actions: ItsaAction[]
  // The latest ask mail to the human about it, which the mail list shows as its row; null if none.
  ask_thread_id?: string | null
  ask_mail_id?: string | null
  // The human deferred the ask's thread (S-353): it stays open, off the waiting list.
  deferred?: boolean
}

// An agent's mail to the human that holds a decision and waits for their reply (S-352).
export interface DecisionMail {
  mail_id: string
  thread_id: string
  from_id: string
  from_name: string | null
  subject: string
  created_at: string
  // The human deferred the thread (S-353): it stays open, off the waiting list.
  deferred?: boolean
}

export interface ItsaLink {
  n: number
  system: string
  external_id: string | null
  url: string
  // A branch link's repo and recorded facts (S-40); null for other kinds.
  meta?: LinkMeta | null
}

// A branch link's record (src/itsa.ts LinkMeta): its review verdict, its tests, its screenshots.
export interface LinkMeta {
  repo?: string
  review?: { verdict: string; by: string; summary: string | null; at: string }
  tests?: { passed: number; failed: number; skipped: number; command: string | null; at: string }
  screenshots?: { mail_id: string; name: string }[]
}

// A branch link's facts, computed by the ITSA home daemon (itsa-queue.ts): the diff against
// the main branch, whether it merges cleanly, its head, and how far behind main it is. Each
// fact that couldn't be read is null, and `error` says why.
export interface BranchFacts {
  repo: string
  branch: string
  path: string | null
  head: string | null
  diff: { files: number; insertions: number; deletions: number } | null
  mergeable: boolean | null
  behind: number | null
  error: string | null
}

// One row of the merge queue (GET /api/itsas/queue): a ready_to_merge ITSA with a branch link.
export interface ItsaQueueRow {
  id: string
  key: string
  title: string
  owner: string | null
  updated_at: string
  link: { n: number; branch: string; repo: string }
  facts: BranchFacts
  // The requirement checks on this head (src/itsa-queue.ts), while requirements are on.
  conformity?: Conformity | null
}

// GET /api/machines: one computer's load, its percentages a one-minute rolling average.
export interface Machine {
  name: string
  // Set on a peer when the page's daemon doesn't relay the human's terminals (auth.humanStrict): the page opens them here.
  terminalOrigin?: string
  online: boolean
  ts: number
  cpu: { pct: number; cores: number[]; count: number }
  ram: { pct: number; used: number; total: number }
  swap: { pct: number; used: number; total: number }
  load: number[]
}

export interface ItsaEvent {
  id: number
  ts: string
  actor: string | null
  type: string
  data: string | null
}

// GET /api/itsas/:id/threads: one row per mail thread about the ITSA, newest activity first.
export interface AboutThread { thread_id: string; subject: string; participants: string[]; last_at: string; unread: number }

// GET /api/mail/linked/:id: one row per mail thread linked to the ITSA (S-986), newest first.
export interface LinkedThread { thread_id: string; subject: string; from_id: string; from_name: string | null; last_at: string; mails: number; source: 'itsa' | 'named' | 'thread' }

// GET /api/itsas/:id/thread: the thread's mails and the status and owner changes, by time.
export type ItsaThreadItem =
  | { type: 'mail'; ts: string; mail: Mail }
  | { type: 'event'; ts: string; id: number; actor: string | null; event: string; text: string }

export interface ItsaView extends Itsa {
  participants: string[]
  links: ItsaLink[]
  parent_chain: { id: string; key: string; title: string; status: string }[]
  rollup: Rollup
  children: (Itsa & { rollup: Rollup })[]
  events?: ItsaEvent[]
  actions?: ItsaAction[]
}

// GET /api/retros (S-162): the open retro items ranked by +1s, the effort split per model and
// type (each area's average share, in percent), and coverage of the archived agents.
export interface RetroItem {
  id: string
  key: string
  title: string
  kind: string
  target: string
  plusOnes: number
  status: string
  created_at: string
}
export interface RetrosView {
  items: RetroItem[]
  effort: { model: string | null; type: string | null; rounds: number; avg: Record<string, number> }[]
  coverage: { archived: number; withRound: number; without: string[] }
}

// One agent's or tree's cost in every unit (S-316). A converted value is null when it can't be
// worked out yet (the worth isn't calibrated, or no price is set); paid_usd is real money.
export type CostMode = 'api' | 'five_hour' | 'seven_day' | 'subscription'
export type CostModes = { api: number | null; five_hour: number | null; seven_day: number | null; subscription: number | null; paid_usd: number }
export type AgentCost = { mode: CostMode; own: CostModes; tree: CostModes }
