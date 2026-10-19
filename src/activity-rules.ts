// Rule classifier for activity items (S-213): settles the activity category of every item a
// deterministic rule can (tool name, shell command family, path), and leaves the rest NULL for
// the model classifier (S-214). Rules read the tool's name, its input (at ingest) or its summary
// (in the backfill), and the turn's order. Nothing here calls a model; the same functions run at
// ingest and in the backfill (`stam activity --classify`). docs/activity-categories.md has the
// rules in prose.
import { posix } from 'node:path';
import { ACTIVITY_DEFINITIONS } from './activity-categories.ts';

export type RuleKind = 'tool' | 'text' | 'model' | 'gap';

// The readers cut stored summaries at this length (S-210).
export const SUMMARY_MAX = 300;

// What the rules see of one item, in the order items happened.
export interface RuleItem {
  kind: RuleKind;
  turn: number;
  name: string | null;
  summary: string | null;
  // The tool's full input, when the reader kept it (at ingest). The backfill has only the summary.
  input?: Record<string, unknown>;
}

export interface Classified {
  category: string | null;
  // rule: a rule settled it; derived: it took its category from the item it produced, or it
  // needs none (a gap, whose wait kind says it all). NULL source: left for the model.
  source: 'rule' | 'derived' | null;
  confidence: 1 | null;
}

const UNCLASSIFIED: Classified = { category: null, source: null, confidence: null };

// Stam's MCP tools by name, without the `mcp__stam__` prefix.
const STAM_TOOLS: Record<string, string> = {
  read_mail: 'communicate.read',
  list_inbox: 'communicate.read',
  defer_thread: 'communicate.read',
  ReadNotifications: 'communicate.read',
  read_thread: 'communicate.read',
  itsa_create: 'track.create',
  itsa_set: 'track.status',
  itsa_post: 'track.note',
  itsa_link: 'track.organize',
  itsa_get: 'track.query',
  itsa_list: 'track.query',
  search: 'track.query',
  spawn_agent: 'delegate.spawn',
  Agent: 'delegate.spawn',
  find_agents: 'delegate.check',
  wait_for: 'self.schedule-wait',
  wake_me: 'self.schedule-wait',
  ScheduleWakeup: 'self.schedule-wait',
  Monitor: 'wait.poll',
  usage_info: 'self.budget',
  ToolSearch: 'self.tools',
  Skill: 'self.tools',
  whoami: 'self.identity',
  register: 'self.identity',
  retro: 'self.retro',
  feedback: 'self.retro',
  compact_self: 'self.context',
  request_permission: 'communicate.ask',
  answer_permission: 'communicate.answer',
  withdraw_ask: 'communicate.answer',
  mail_attach: 'communicate.answer',
};

// Harness tools by name.
const HARNESS_TOOLS: Record<string, string> = {
  WebSearch: 'understand.external',
  WebFetch: 'understand.external',
  Grep: 'understand.search',
  Glob: 'understand.search',
};

const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command']);

const AGENT_CONTROL_ACTIONS: Record<string, string> = {
  pause: 'delegate.steer',
  stop: 'delegate.steer',
  restart: 'delegate.steer',
  archive: 'delegate.retire',
  shutdown: 'delegate.retire',
};

// A python write: open for writing or appending, a write call, or a file replace or copy.
const PY_WRITE = /open\([^)]*,\s*['"][wa]b?\+?['"]|\.write\(|write_text|os\.replace|shutil\./;

// A path a Read or a shell reader shows: instruction files, logs and task output, else material.
export function readPathCategory(path: string): string {
  if (/(^|\/)(CLAUDE|AGENTS)\.md$/.test(path) || /(^|\/)docs\/.*\.md$/.test(path) || /\/skills\//.test(path) || /SKILL\.md$/.test(path)) return 'understand.task';
  if (/^\/tmp\//.test(path) || /\/tmp\//.test(path) || /\.(log|output)$/.test(path) || /\/tasks?\//.test(path)) return 'understand.output';
  return 'understand.material';
}

// A path a write changes: tests, docs, config, else the edit (or the write, for a new file).
export function writePathCategory(path: string, verb: 'edit' | 'write'): string {
  if (/(^|\/)test\/|\.test\.|\.spec\.|e2e/.test(path)) return 'produce.tests';
  if (/\.md$/.test(path)) return 'produce.docs';
  if (/(^|\/)(package(-lock)?\.json|tsconfig[^/]*|\.env[^/]*)$|\.(json|ya?ml|toml|ini|conf)$|\.config\.[a-z]+$/.test(path)) return 'produce.config';
  return verb === 'edit' ? 'produce.edit' : 'produce.write';
}

// The directory a command runs in, as far as the rules follow it: '' for the directory the
// session started in (relative paths are as written), a path after a simple `cd DIR`, or null
// when a `cd` made it unknown (`cd ~/x`, `cd $DIR`, a bare `cd`): relative paths then go to the model.
type Cwd = string | null;
const UNCLEAR = Symbol('unclear');

function nextCwd(cwd: Cwd, seg: string): Cwd {
  const m = /^cd\s+(\S+)\s*$/.exec(seg);
  if (!m || /[$~`*]/.test(m[1])) return null;
  const dir = m[1].replace(/^['"]|['"]$/g, '');
  if (dir.startsWith('/')) return dir;
  if (cwd === null) return null;
  return cwd ? posix.join(cwd, dir) : dir;
}

// The path a command means: absolute paths as they are, relative ones from its directory.
function resolvePath(p: string, cwd: Cwd): string | typeof UNCLEAR {
  const clean = p.replace(/^['"]|['"]$/g, '');
  if (clean.startsWith('/') || clean.startsWith('~')) return clean;
  if (cwd === null) return UNCLEAR;
  return cwd ? posix.join(cwd, clean) : clean;
}

// The last argument that looks like a path: not a flag, not a redirect.
function lastPath(words: string[]): string | null {
  const args = words.slice(1).filter((w) => w && !w.startsWith('-') && !/^[<>|&]/.test(w));
  return args.length ? args[args.length - 1] : null;
}

// Command families for one simple command (no && ; | or newline), run in `cwd`.
function segmentCategory(raw: string, cwd: Cwd): string | null {
  // Stream redirects to a fd or /dev/null don't change what the command is.
  const seg = raw.replace(/\s\d?>&\d|\s\d?>\s*\/dev\/null/g, ' ');
  const words = seg.trim().replace(/^(\w+=\S*\s+)+/, '').split(/\s+/);
  const w0 = words[0];
  // The path the last argument names, from the directory: null when there is none.
  const target = (): string | null | typeof UNCLEAR => {
    const p = lastPath(words);
    return p ? resolvePath(p, cwd) : null;
  };
  if (/^sleep$/.test(w0) && words.length === 2 && /^[\d.]+$/.test(words[1])) return 'wait.sleep';
  if (/\/proc\/loadavg/.test(seg) || /^(uptime|free)$/.test(w0)) return 'operate.resources';
  if (w0 === 'git') {
    const sub = words[1];
    if (['log', 'show', 'blame'].includes(sub)) return 'understand.history';
    if (sub === 'add' || sub === 'commit') return 'integrate.commit';
    if (['merge', 'rebase', 'fetch', 'branch'].includes(sub)) return 'integrate.branch';
    if (sub === 'checkout' && words.some((w) => w === '-b' || w === '-B')) return 'integrate.branch';
    if (sub === 'push') return 'integrate.release';
    return null;
  }
  if (['grep', 'rg', 'find', 'ls'].includes(w0)) return 'understand.search';
  if (w0 === 'tsc' || ((w0 === 'npx' || w0 === 'pnpx') && words[1] === 'tsc') || (w0 === 'npm' && /^(run )?(build|lint|typecheck)$/.test(words.slice(1).join(' '))) || w0 === 'eslint') return 'verify.static';
  // File-reading and file-writing commands come before the test commands: their paths can name a test.
  // cat > file writes it; the write's path decides, as for an edit.
  if (w0 === 'cat' && /(^|\s)>>?\s*\S/.test(seg)) {
    const raw2 = /(^|\s)>>?\s*(\S+)/.exec(seg)?.[2];
    const p = raw2 ? resolvePath(raw2, cwd) : null;
    if (p === UNCLEAR) return null;
    return p ? writePathCategory(p, 'edit') : 'produce.edit';
  }
  if (/[<>]/.test(seg) && /^(cat|head|tail|sed)$/.test(w0)) return null;
  if (w0 === 'sed' && (words.includes('-i') || words.includes('-n'))) {
    const p = target();
    if (p === UNCLEAR) return null;
    if (words.includes('-i')) return p ? writePathCategory(p, 'edit') : 'produce.edit';
    return p ? readPathCategory(p) : null;
  }
  if (w0 === 'cat' || w0 === 'tail' || w0 === 'head') {
    const p = target();
    if (p === UNCLEAR) return null;
    return p ? readPathCategory(p) : null;
  }
  if (/phone\.mjs|shots\.mjs|web\/check\/run\.sh/.test(seg)) return 'verify.visual';
  if (/\bnode --test\b|\bvitest\b|test\/run\.sh|\.test\.|e2e[^\s]*\.sh/.test(seg)) return /e2e|test\/run\.sh/.test(seg) ? 'verify.integration' : 'verify.unit';
  if (w0 === 'npm' && /^(ci|install|i)$/.test(words[1] ?? '')) return 'operate.install';
  if (w0 === 'ps' || w0 === 'pgrep') return 'understand.state';
  if (w0 === 'kill') return 'operate.service';
  if (w0 === 'rm' && /\s\/tmp\//.test(seg)) return 'operate.cleanup';
  return null;
}

// A shell command's category. Its simple commands are read in order, following `cd`. The main
// command is the first that isn't cd, export or echo. The others must share its top-level
// category (a different leaf is fine: the main command's leaf stands), or the command goes to the model.
export function commandCategory(cmd: string): string | null {
  const trimmed = cmd.trim();
  // A loop is one command, though its body is split by semicolons.
  if (/^(until|while)\b/.test(trimmed)) return /grep|test\s|\[\s+-[fes]\s|-[fes]\s/.test(trimmed) ? 'wait.poll' : null;
  let cwd: Cwd = '';
  const parts: { seg: string; cwd: Cwd }[] = [];
  for (const seg of trimmed
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (/^cd\b/.test(seg)) {
      cwd = nextCwd(cwd, seg);
      continue;
    }
    if (/^(export|echo)\b/.test(seg)) continue;
    parts.push({ seg, cwd });
  }
  // A python heredoc that writes a file: its body is split by newlines, so it is read whole.
  if (/(^|&&|;|\n)\s*python3?\b[^\n]*<</.test(trimmed)) {
    if (!PY_WRITE.test(trimmed)) return null;
    const raw = /['"]([^'"\s]+\.[A-Za-z0-9]+)['"]/.exec(trimmed)?.[1];
    const p = raw ? resolvePath(raw, cwd) : null;
    if (p === UNCLEAR) return null;
    return p ? writePathCategory(p, 'edit') : 'produce.edit';
  }
  if (!parts.length) return null;
  const main = segmentCategory(parts[0].seg, parts[0].cwd);
  if (!main) return null;
  const top = main.split('.')[0];
  for (const p of parts.slice(1)) {
    const c = segmentCategory(p.seg, p.cwd);
    if (c && c.split('.')[0] !== top) return null;
  }
  return main;
}

// The action of an agent_control call, from its summary (its JSON input).
function parseAction(summary: string | null): string | undefined {
  try {
    const action = JSON.parse(summary ?? '{}').action;
    return typeof action === 'string' ? action : undefined;
  } catch {
    return undefined;
  }
}

// The category of a tool call, or null when no rule settles it.
function toolCategory(name: string, summary: string | null, input?: Record<string, unknown>): string | null {
  if (!name) return null;
  // Without the full input, a summary cut at the limit may hide the rest of the command or path.
  if (!input && (summary?.length ?? 0) >= SUMMARY_MAX) return null;
  if (name.startsWith('mcp__stam__')) {
    const tool = name.slice('mcp__stam__'.length);
    if (tool.startsWith('cost_')) return 'self.budget';
    if (tool === 'agent_control') {
      const action = typeof input?.action === 'string' ? input.action : parseAction(summary);
      return action ? (AGENT_CONTROL_ACTIONS[action] ?? null) : null;
    }
    return STAM_TOOLS[tool] ?? null;
  }
  if (SHELL_TOOLS.has(name)) {
    const cmd = typeof input?.command === 'string' ? input.command : summary;
    return cmd ? commandCategory(cmd) : null;
  }
  const file = typeof input?.file_path === 'string' ? input.file_path : summary;
  if (name === 'Read') return file ? readPathCategory(file) : null;
  if (name === 'Edit' || name === 'Write') return file ? writePathCategory(file, name === 'Edit' ? 'edit' : 'write') : null;
  return name in STAM_TOOLS ? STAM_TOOLS[name] : (HARNESS_TOOLS[name] ?? null);
}

// The rule category of one item, or null. `lastInTurn` is set on a text item that is the last
// text item of its turn: that text ends the turn, and is a summary.
export function classifyByRules(item: RuleItem, context: { lastInTurn?: boolean } = {}): { category: string; confidence: 1 } | null {
  let category: string | null = null;
  if (item.kind === 'tool') category = toolCategory(item.name ?? '', item.summary, item.input);
  else if (item.kind === 'text' && context.lastInTurn) category = 'communicate.summary';
  if (!category || !(category in ACTIVITY_DEFINITIONS)) return null;
  return { category, confidence: 1 };
}

// Classifies a sequence of items in the order they happened. Rules settle tool and text items;
// a model item takes the category of the first tool or text item after it in its turn (the
// work it produced); a gap gets no category, only the derived mark.
export function classifyItems(items: readonly RuleItem[]): Classified[] {
  const lastText = new Map<number, number>();
  items.forEach((it, i) => {
    if (it.kind === 'text') lastText.set(it.turn, i);
  });
  const own = items.map((it, i) => {
    if (it.kind !== 'tool' && it.kind !== 'text') return null;
    return classifyByRules(it, { lastInTurn: lastText.get(it.turn) === i });
  });
  return items.map((it, i): Classified => {
    if (it.kind === 'tool' || it.kind === 'text') {
      const c = own[i];
      return c ? { category: c.category, source: 'rule', confidence: 1 } : UNCLASSIFIED;
    }
    if (it.kind === 'gap') return { category: null, source: 'derived', confidence: 1 };
    for (let j = i + 1; j < items.length && items[j].turn === it.turn; j++) {
      if (items[j].kind !== 'tool' && items[j].kind !== 'text') continue;
      const c = own[j];
      return c ? { category: c.category, source: 'derived', confidence: 1 } : UNCLASSIFIED;
    }
    return UNCLASSIFIED;
  });
}
