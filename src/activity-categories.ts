// The activity tree (S-204, S-213): what an agent's item is for, and what its clock waits on.
// Generated from ~/.local/share/stam/s204/categories.md; the definitions are copied verbatim, since
// they double as the model classifier's prompts (S-214). Keys are `top.leaf`, used as stored
// category values (activity_items.category) and as decision-model choice keys.
// docs/activity-categories.md has the tree and how the rules fill it.

export interface ActivityLeaf {
  key: string;
  definition: string;
}

export interface ActivityTop {
  key: string;
  gloss: string;
  leaves: ActivityLeaf[];
}

export const ACTIVITY_TREE: readonly ActivityTop[] = [
  {
    key: "understand",
    gloss: "learn what is there",
    leaves: [
      { key: "understand.task", definition: "read the task, brief, instructions, rules, skills" },
      { key: "understand.material", definition: "read the primary material (source code, a document, a dataset)" },
      { key: "understand.search", definition: "search for where something is (grep, find, ls, glob)" },
      { key: "understand.history", definition: "read change history (git log/show/blame, an ITSA's history)" },
      { key: "understand.state", definition: "inspect the live state of a system (ps, curl an API, a DB read, `stam ls`)" },
      { key: "understand.output", definition: "read output or logs of a run or job" },
      { key: "understand.external", definition: "research outside sources (web search, fetch, external docs)" },
      { key: "understand.experiment", definition: "run something only to observe behaviour" },
    ],
  },
  {
    key: "plan",
    gloss: "decide what to do",
    leaves: [
      { key: "plan.steps", definition: "announce or lay out next steps" },
      { key: "plan.design", definition: "write a design, spec, or brief" },
      { key: "plan.options", definition: "compare alternatives and choose" },
      { key: "plan.prioritize", definition: "order or schedule work against capacity, budget, time" },
      { key: "plan.estimate", definition: "estimate size, time, or cost" },
    ],
  },
  {
    key: "produce",
    gloss: "create or change the deliverable",
    leaves: [
      { key: "produce.write", definition: "create a new artifact (file, document)" },
      { key: "produce.edit", definition: "change an existing artifact" },
      { key: "produce.tests", definition: "write or change tests or checks" },
      { key: "produce.docs", definition: "write documentation or prose for others" },
      { key: "produce.config", definition: "change configuration, settings, environment" },
      { key: "produce.script", definition: "write a one-off script or tool for own use (analysis, migration)" },
      { key: "produce.data", definition: "create or transform data (fixtures, exports, a table)" },
      { key: "produce.media", definition: "create images, diagrams, recordings" },
    ],
  },
  {
    key: "verify",
    gloss: "check that work is right",
    leaves: [
      { key: "verify.static", definition: "typecheck, lint, build, compile, syntax check" },
      { key: "verify.unit", definition: "run fast/unit tests" },
      { key: "verify.integration", definition: "run integration or end-to-end tests" },
      { key: "verify.visual", definition: "check UI or visual output (screenshots, viewports)" },
      { key: "verify.probe", definition: "a manual check of one behaviour (curl, a one-liner)" },
      { key: "verify.review", definition: "review a change (own diff or someone else's)" },
      { key: "verify.rerun", definition: "rerun to confirm a fix or rule out a flake" },
      { key: "verify.measure", definition: "measure performance, size, cost, or quality" },
    ],
  },
  {
    key: "diagnose",
    gloss: "find why something is wrong",
    leaves: [
      { key: "diagnose.read-failure", definition: "read and interpret a failure" },
      { key: "diagnose.hypothesis", definition: "state or test a likely cause" },
      { key: "diagnose.instrument", definition: "add logging, bisect, or narrow down the cause" },
      { key: "diagnose.root-cause", definition: "state the found cause" },
    ],
  },
  {
    key: "integrate",
    gloss: "land work into the shared whole",
    leaves: [
      { key: "integrate.commit", definition: "stage and commit" },
      { key: "integrate.branch", definition: "branch, fetch, rebase, merge" },
      { key: "integrate.conflict", definition: "resolve a conflict" },
      { key: "integrate.release", definition: "release, deploy, publish" },
      { key: "integrate.cleanup", definition: "remove branches, worktrees, leftover artifacts" },
    ],
  },
  {
    key: "operate",
    gloss: "run and maintain the environment",
    leaves: [
      { key: "operate.service", definition: "start, stop, restart a service or process" },
      { key: "operate.install", definition: "install or update dependencies or tools" },
      { key: "operate.resources", definition: "check machine load, disk, memory, capacity" },
      { key: "operate.cleanup", definition: "clean temp files, stray processes" },
      { key: "operate.access", definition: "credentials, permissions, auth" },
      { key: "operate.backup", definition: "back up, copy, or restore data" },
    ],
  },
  {
    key: "communicate",
    gloss: "exchange information with others",
    leaves: [
      { key: "communicate.read", definition: "read messages or notifications" },
      { key: "communicate.report", definition: "report a result, status, or heads-up to someone" },
      { key: "communicate.ask", definition: "ask a question or escalate a decision" },
      { key: "communicate.answer", definition: "answer a question, approve, or deny" },
      { key: "communicate.narrate", definition: "interim narration of own work (to whoever reads the transcript)" },
      { key: "communicate.summary", definition: "final summary ending a turn" },
    ],
  },
  {
    key: "track",
    gloss: "keep the work's records",
    leaves: [
      { key: "track.create", definition: "create a work item" },
      { key: "track.status", definition: "change a work item's status" },
      { key: "track.note", definition: "comment or post an update on a work item" },
      { key: "track.organize", definition: "link, re-parent, label, or reassign items" },
      { key: "track.query", definition: "look up work items or their history" },
      { key: "track.notes", definition: "keep own notes or handover files" },
    ],
  },
  {
    key: "delegate",
    gloss: "have others do work",
    leaves: [
      { key: "delegate.spawn", definition: "start a new agent or worker" },
      { key: "delegate.brief", definition: "give a worker its task or a correction" },
      { key: "delegate.check", definition: "check on a worker's state or progress" },
      { key: "delegate.steer", definition: "pause, stop, restart, or redirect a worker" },
      { key: "delegate.accept", definition: "read and accept or reject a worker's result" },
      { key: "delegate.retire", definition: "archive or shut down a finished worker" },
    ],
  },
  {
    key: "self",
    gloss: "manage own working conditions",
    leaves: [
      { key: "self.tools", definition: "load tools, skills, or capabilities" },
      { key: "self.context", definition: "manage own context (compact, re-read own notes)" },
      { key: "self.budget", definition: "check or manage cost and usage" },
      { key: "self.schedule-wait", definition: "set up a wait, timer, or wake-up" },
      { key: "self.retro", definition: "reflect, file a retro or feedback" },
      { key: "self.identity", definition: "look up own identity or registration" },
    ],
  },
  {
    key: "wait",
    gloss: "an item whose purpose is to wait (tool time spent waiting)",
    leaves: [
      { key: "wait.sleep", definition: "deliberate sleep" },
      { key: "wait.poll", definition: "poll a condition in a loop (job output, a file, a status)" },
      { key: "wait.capacity", definition: "wait for machine capacity or a lock" },
    ],
  },
  {
    key: "other",
    gloss: "",
    leaves: [
      { key: "other.unclear", definition: "cannot tell what it is for" },
      { key: "other.error", definition: "a failed call with no purpose of its own (wrong args, tool error)" },
    ],
  },
];

// Every activity leaf key, in tree order.
export const ACTIVITY_KEYS: readonly string[] = ACTIVITY_TREE.flatMap((t) => t.leaves.map((l) => l.key));

export const ACTIVITY_DEFINITIONS: Readonly<Record<string, string>> = Object.fromEntries(
  ACTIVITY_TREE.flatMap((t) => t.leaves.map((l) => [l.key, l.definition] as const)),
);

export interface WaitKind {
  key: string;
  definition: string;
}

// The wait tree's leaves: what an agent's clock is spent waiting on (S-210 stores these keys in
// activity_items.wait_kind).
export const WAIT_KINDS: readonly WaitKind[] = [
  { key: "tool.short", definition: "tool call under 5 s" },
  { key: "tool.build", definition: "build or install" },
  { key: "tool.test", definition: "test run" },
  { key: "tool.network", definition: "network or remote call" },
  { key: "tool.sleep", definition: "deliberate sleep or poll inside a tool" },
  { key: "tool.contention", definition: "load-wait loop, a lock" },
  { key: "model.generate", definition: "model generating (result to next message)" },
  { key: "model.stall", definition: "model API error or retry (gap > 5 min after a result with no new prompt)" },
  { key: "job.background", definition: "a background job the agent started (ended by its completion notice)" },
  { key: "agent.child", definition: "a child agent's work (ended by a child notice or child mail)" },
  { key: "agent.peer", definition: "mail from a parent or peer" },
  { key: "agent.release", definition: "another agent's merge, deploy, or review" },
  { key: "human.reply", definition: "the human's reply to mail or a question" },
  { key: "human.permission", definition: "a permission request" },
  { key: "human.prompt", definition: "a new prompt from the human" },
  { key: "event.timer", definition: "a timer or schedule (wake_me, ScheduleWakeup)" },
  { key: "event.external", definition: "an external event (GitHub, Linear, a subscription)" },
  { key: "throttle.cost", definition: "a cost blocker or pause, rate limit" },
  { key: "throttle.scheduler", definition: "paused or queued by a manager or for capacity" },
  { key: "idle.none", definition: "idle with nothing assigned; harness restart, resume, compaction" },
];

export const WAIT_DEFINITIONS: Readonly<Record<string, string>> = Object.fromEntries(WAIT_KINDS.map((w) => [w.key, w.definition] as const));

// Human labels for the keys the activity views show (S-225): one place, sent with /api/activity so the
// web shows words, not keys. A wait kind's label names what the clock was on; a top-level category's
// names the work. Leaves show their top-level label and their leaf, as "Verifying · unit".
export const WAIT_LABELS: Readonly<Record<string, string>> = {
  agent: "Agents",
  human: "The human",
  job: "Background jobs",
  tool: "Tools",
  throttle: "Throttled",
  event: "Events",
  idle: "Idle",
  model: "Model",
  "tool.short": "Quick tool call",
  "tool.build": "Running a build",
  "tool.test": "Running tests",
  "tool.network": "Network or remote call",
  "tool.sleep": "Sleeping or polling in a tool",
  "tool.contention": "Waiting on a lock or load",
  "model.generate": "Model thinking",
  "model.stall": "Model API error or retry",
  "job.background": "Background job",
  "agent.child": "Waiting on a child agent",
  "agent.peer": "Mail from a peer or parent",
  "agent.release": "Waiting on a merge, deploy or review",
  "human.reply": "Waiting on the human's reply",
  "human.permission": "Waiting on a permission",
  "human.prompt": "Waiting on a new prompt from the human",
  "event.timer": "Timer or schedule",
  "event.external": "External event",
  "throttle.cost": "Cost pause or rate limit",
  "throttle.scheduler": "Queued for capacity",
  "idle.none": "Idle",
  unknown: "Unknown wait",
};

export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  understand: "Understanding",
  plan: "Planning",
  produce: "Producing",
  verify: "Verifying",
  diagnose: "Diagnosing",
  integrate: "Integrating",
  operate: "Operating",
  communicate: "Communicating",
  track: "Tracking",
  delegate: "Delegating",
  self: "Self",
  wait: "Waiting",
  other: "Other",
  unclassified: "Unclassified",
};

// The label for a wait kind, a top-level category, or a category leaf (top label · leaf).
export function activityLabel(key: string): string {
  if (WAIT_LABELS[key]) return WAIT_LABELS[key];
  if (CATEGORY_LABELS[key]) return CATEGORY_LABELS[key];
  const [top, ...rest] = key.split(".");
  if (CATEGORY_LABELS[top] && rest.length) return `${CATEGORY_LABELS[top]} · ${rest.join('.')}`;
  return key;
}

// The clock's groups (S-1009): every second of an agent's clock lands in exactly one, so they sum to
// the total. Friction is time lost to the system itself: cost pauses and capacity queues (waits), and
// sleeping, lock and load waits and model stalls inside the work. Working is the rest of the work; the
// other waits go to the agents and jobs the agent waits on, to the human, or to idle (a gap with no
// known wait kind is idle too).
export type ClockGroup = "working" | "friction" | "others" | "you" | "idle";
export const CLOCK_GROUPS: readonly { key: ClockGroup; label: string }[] = [
  { key: "working", label: "Working" },
  { key: "friction", label: "Friction" },
  { key: "others", label: "Other agents and jobs" },
  { key: "you", label: "Waiting on you" },
  { key: "idle", label: "Idle" },
];
export const FRICTION_KINDS: readonly string[] = ["throttle.cost", "throttle.scheduler", "tool.sleep", "tool.contention", "model.stall"];
// Slow work the bottlenecks list beside the friction, human and idle waits: it can often be made faster.
export const SLOW_WORK_KINDS: readonly string[] = ["tool.test", "tool.build", "agent.release"];
const FRICTION = new Set(FRICTION_KINDS);

// The clock group of an item's leaf: its wait kind, and whether it is a gap (a wait) or work.
export function clockGroup(leaf: string, gap: boolean): ClockGroup {
  if (FRICTION.has(leaf)) return "friction";
  if (!gap) return "working";
  const t = leaf.split(".")[0];
  if (t === "human") return "you";
  if (t === "agent" || t === "job" || t === "event") return "others";
  return "idle";
}
