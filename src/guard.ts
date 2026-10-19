// Refuses broad process kills in an agent's Bash tool: pkill and killall in any command
// position, and a signalling kill that consumes a pgrep, pidof, or ps lookup (in the same
// pipeline, or through $(...), backticks, or a for loop's list). Kills by PID or %job pass,
// and so does signal 0, which only probes. Text that merely mentions these commands (quoted
// arguments, comments, heredoc bodies) is not a command. When the parse is unsure, the
// command passes: a missed broad kill is better than blocking normal work.

type Word = { value: string; subs: string[] };
type Segment = { words: Word[]; pipe: boolean };
type Pipeline = Segment[];

const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec', 'builtin', 'nice', 'xargs', 'stdbuf', 'do', 'then', 'else', '{', '!']);
const LOOKUP = new Set(['pgrep', 'pidof', 'ps']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);

// Drops heredoc bodies, which can hold any text but never run as commands.
function strip(cmd: string): string {
  const out: string[] = [];
  let pending: string[] = [];
  for (const line of cmd.split('\n')) {
    if (pending.length) {
      if (line.trim() === pending[0]) pending.shift();
      continue;
    }
    out.push(line);
    for (const m of line.matchAll(/<<-?\s*['"]?(\w+)['"]?/g)) pending.push(m[1]);
  }
  return out.join('\n');
}

// Splits a command into pipelines of segments. `$(...)` and backticks become a word's subs
// (their inner command, parsed the same way); quotes are removed from word values.
function parse(cmd: string): Pipeline[] {
  const pipelines: Pipeline[] = [];
  let pipeline: Pipeline = [];
  let seg: Word[] = [];
  let word: Word | null = null;
  const endWord = () => {
    if (word) seg.push(word);
    word = null;
  };
  const endSeg = (pipe: boolean) => {
    endWord();
    if (seg.length) pipeline.push({ words: seg, pipe });
    seg = [];
  };
  const endPipeline = () => {
    endSeg(false);
    if (pipeline.length) pipelines.push(pipeline);
    pipeline = [];
  };
  const sub = (end: number, s: string) => {
    word ??= { value: '', subs: [] };
    word.subs.push(s);
    return end;
  };
  // The text of a $(...) starting at i (the '('), balanced over nested parens and quotes.
  const closeParen = (i: number): number => {
    let depth = 0;
    for (let j = i; j < cmd.length; j++) {
      const ch = cmd[j];
      if (ch === "'") {
        j = cmd.indexOf("'", j + 1);
        if (j < 0) break;
      } else if (ch === '"') {
        for (j++; j < cmd.length && cmd[j] !== '"'; j++) if (cmd[j] === '\\') j++;
      } else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return j;
    }
    throw new Error('unbalanced');
  };
  for (let i = 0; i < cmd.length; ) {
    const ch = cmd[i];
    if (ch === ' ' || ch === '\t') {
      endWord();
      i++;
    } else if (ch === '\n' || ch === ';') {
      endPipeline();
      i++;
    } else if (ch === '&' && cmd[i + 1] === '&') {
      endPipeline();
      i += 2;
    } else if (ch === '|' && cmd[i + 1] === '|') {
      endPipeline();
      i += 2;
    } else if (ch === '|') {
      endSeg(true);
      i++;
    } else if (ch === '&' || ch === '(' || ch === ')') {
      endPipeline();
      i++;
    } else if (ch === "'") {
      const e = cmd.indexOf("'", i + 1);
      if (e < 0) throw new Error('unbalanced');
      word ??= { value: '', subs: [] };
      word.value += cmd.slice(i + 1, e);
      i = e + 1;
    } else if (ch === '"') {
      word ??= { value: '', subs: [] };
      i++;
      for (; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === '\\' && i + 1 < cmd.length) word.value += cmd[++i];
        else if (cmd[i] === '$' && cmd[i + 1] === '(') {
          const e = closeParen(i + 1);
          i = sub(e, cmd.slice(i + 2, e)) + 0;
        } else if (cmd[i] === '`') {
          const e = cmd.indexOf('`', i + 1);
          if (e < 0) throw new Error('unbalanced');
          i = sub(e, cmd.slice(i + 1, e));
        } else word.value += cmd[i];
      }
      if (i >= cmd.length) throw new Error('unbalanced');
      i++;
    } else if (ch === '$' && cmd[i + 1] === '(') {
      const e = closeParen(i + 1);
      i = sub(e, cmd.slice(i + 2, e)) + 1;
    } else if (ch === '`') {
      const e = cmd.indexOf('`', i + 1);
      if (e < 0) throw new Error('unbalanced');
      i = sub(e, cmd.slice(i + 1, e)) + 1;
    } else if (ch === '#' && !word) {
      // A comment: an unquoted # that starts a word runs to the end of the line.
      while (i < cmd.length && cmd[i] !== '\n') i++;
    } else if (ch === '\\' && i + 1 < cmd.length) {
      word ??= { value: '', subs: [] };
      word.value += cmd[i + 1];
      i += 2;
    } else {
      word ??= { value: '', subs: [] };
      word.value += ch;
      i++;
    }
  }
  endPipeline();
  return pipelines;
}

// The command word of a segment: skips assignments, wrappers and their options.
function commandOf(words: Word[]): { name: string; args: Word[] } | null {
  let i = 0;
  while (i < words.length) {
    const v = words[i].value;
    if (/^[A-Za-z_]\w*=/.test(v) || v.startsWith('-')) i++;
    else if (WRAPPERS.has(v)) i++;
    else break;
  }
  if (i >= words.length) return null;
  return { name: words[i].value, args: words.slice(i + 1) };
}

// A kill that signals: not `kill -0`, `-s 0`, or `-l` (list).
function signalling(args: Word[]): boolean {
  const vals = args.map((a) => a.value);
  if (vals.includes('-l') || vals.includes('-L')) return false;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === '-0' || vals[i] === '0') return false;
    if ((vals[i] === '-s' || vals[i] === '-n') && vals[i + 1] === '0') return false;
    if (vals[i] === '-s0' || vals[i] === '-n0') return false;
  }
  return true;
}

// True when a command word of this segment, or a substitution it holds, is a lookup.
function consumesLookup(words: Word[]): boolean {
  return words.some((w) => w.subs.some((s) => hasLookup(s)));
}

// A lookup command anywhere in a command, including its substitutions.
function hasLookup(cmd: string): boolean {
  return parse(strip(cmd)).some((p) => p.some((s) => {
    const c = commandOf(s.words);
    return !!c && (LOOKUP.has(c.name) || consumesLookup(s.words));
  }));
}

// Whether a command (or one inside its substitutions, or a shell -c string) is broad.
function broad(cmd: string): boolean {
  const pipelines = parse(strip(cmd));
  let killSignals = false;
  let lookupInCommand = false;
  for (const p of pipelines) {
    let pipeLookup = false;
    let pipeKill = false;
    for (const s of p) {
      const c = commandOf(s.words);
      if (!c) continue;
      if (c.name === 'pkill' || c.name === 'killall') return true;
      if (SHELLS.has(c.name)) {
        const k = c.args.findIndex((a) => a.value === '-c');
        if (k >= 0 && c.args[k + 1] && broad(c.args[k + 1].value)) return true;
      }
      for (const w of s.words) for (const sub of w.subs) if (broad(sub)) return true;
      if (LOOKUP.has(c.name)) pipeLookup = true;
      if (c.name === 'kill' && signalling(c.args)) {
        pipeKill = true;
        if (consumesLookup(c.args)) return true;
      }
      if (c.name === 'for') {
        const i = s.words.findIndex((w) => w.value === 'in');
        if (i >= 0 && s.words.slice(i + 1).some((w) => w.subs.some((x) => hasLookup(x)))) lookupInCommand = true;
      }
      // xargs kill: the kill is the inner command of a wrapper, not the segment's command.
      if (c.name === 'xargs' && c.args.some((w, i) => w.value === 'kill' && signalling(c.args.slice(i + 1)))) pipeKill = true;
    }
    if (pipeLookup && pipeKill) return true;
    killSignals ||= pipeKill;
  }
  // A for loop over a lookup whose body signals a kill, in the same command.
  if (lookupInCommand && killSignals) return true;
  return false;
}

// True when the command is a broad kill. Unparseable commands pass.
export function isBroadKill(command: string): boolean {
  try {
    return broad(command);
  } catch {
    return false;
  }
}

export const BROAD_KILL_MESSAGE =
  'Refused: broad process kill (pkill, killall, or kill from a pgrep/ps lookup) can stop other agents\' processes. ' +
  'Kill only by PID you started: find your PID (for example $! after starting it, or the PID file you wrote), then `kill PID`. ' +
  'Kill your own background job with `kill %job`.';

// The PreToolUse hook's answer for a Bash tool call: a deny decision for a broad kill, and
// nothing otherwise (Claude Code runs the command as usual).
export function guardOutput(input: { tool_name?: string; tool_input?: { command?: unknown } }): string {
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || !isBroadKill(command)) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: BROAD_KILL_MESSAGE } });
}
