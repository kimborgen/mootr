// The screen a feedback report carries (S-2679). A report whose details name a first-prompt:screen or
// input:screen event gets the latest such event's screen of each agent the details name, so a reviewer
// without events access can check the cause (S-2557). The read goes through the agent's events route with
// the reporter's own token, so the daemon's rule decides which screens are readable: the same mayActAs rule
// `stam events` uses, and a peer's agent is forwarded to its own daemon. Never throws: a report files
// without the screen, with a line saying why.
import type { Api } from './feedback.ts';

export const SCREEN_TYPES = ['first-prompt:screen', 'input:screen'] as const;
// The bound on an attached screen: its last lines (the input box is at the bottom), and its characters.
export const SCREEN_MAX_LINES = 40;
export const SCREEN_MAX_CHARS = 3000;
// The most agents one report reads: a report that mentions many in passing pulls at most this many screens.
export const SCREEN_MAX_AGENTS = 3;
// The marker a redacted secret takes, as settings.ts REDACTED marks one (this module stays pure, so it is not imported).
const REDACTED = '[redacted]';

// The screen event types the details name, in the order SCREEN_TYPES lists them.
export function screenTypesIn(details: string): string[] {
  return SCREEN_TYPES.filter((t) => details.includes(t));
}

// The agents the details name, by id or name as a whole word, once each. A reply that isn't a list names none.
export function namedAgents(details: string, agents: { id: string; name: string }[]): { id: string; name: string }[] {
  if (!Array.isArray(agents)) return [];
  const words = new Set(details.split(/[^A-Za-z0-9_-]+/));
  const seen = new Set<string>();
  return agents.filter((a) => {
    if (!a || seen.has(a.id) || !(words.has(a.id) || words.has(a.name))) return false;
    seen.add(a.id);
    return true;
  });
}

// Terminal escape sequences out of a captured line: colours, cursor moves and window titles.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// A capture with its credentials taken out: the known token shapes, a bearer token and everything after it on
// the line, a value named like a credential and everything after it on the line (`password=...`, `"token": "..."`),
// `--token VALUE`, and any run of 24 or more letters, digits, `_` or `-`, which covers a stam agent token (32 bare
// base64url characters, with or without a digit). Fails closed: a credential the line doesn't name is still
// redacted when it is long. The same kind of redaction the settings file gets, applied to screen text.
// A name that holds a credential, two ways: one of its `_` or `-` segments is a credential word (`AWS_SECRET_ACCESS_KEY`,
// `DB_PASS`, `--token`, a whole segment so `monkey` stays visible), or the name contains a credential word anywhere
// (`PGPASSWORD`, `dbPassword`, `clientSecret`, `accessToken`). A name that ends in `pass` is a glued one (`dbpass`,
// `PGPASS`), except the words that end in it as prose (`bypass`, `compass`, `surpass`).
const CREDENTIAL_SEGMENT = /^(token|secret|passw(or)?d|pass|apikey|key|auth(orization)?|cred(ential)?s?)$/i;
const CREDENTIAL_WORD = /token|secret|passw(or)?d|passphrase|api[_-]?key|authorization|credential/i;
const GLUED_PASS = /(?<!by|com|sur|over|under|tres)pass$/i;
const isCredentialName = (name: string): boolean => CREDENTIAL_WORD.test(name) || GLUED_PASS.test(name) || name.split(/[_-]/).some((s) => CREDENTIAL_SEGMENT.test(s));

// The first credential named on a line (`NAME=`, `NAME:`, `"NAME": `) and everything after it, redacted. A name
// that isn't a credential is skipped, so `tokens: 12k SECRET=x` still redacts the secret. A `tokens` name (or
// `*_tokens`, such as `max_tokens`) whose whole value is a number, like `12k` or `1.2k`, is a count, and the count
// ends at a comma or space, so `max_tokens=4096,secret=x` redacts the secret. A singular `token` is never a count:
// `token: 4815162342` is an OTP or PIN.
function redactNamed(line: string): string {
  const named = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)("?\s*[:=]\s*"?)/g;
  for (let m = named.exec(line); m; m = named.exec(line)) {
    const value = line.slice(m.index + m[0].length);
    const count = /(^|_)tokens$/i.test(m[1]) && /^\d+(?:[.,]\d+)*[kmb]?(?=$|[\s,;"'}\])])/i.test(value);
    if (isCredentialName(m[1]) && !count) return line.slice(0, m.index + m[0].length) + REDACTED;
  }
  return line;
}

export function redactScreen(line: string): string {
  return redactNamed(
    line
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, REDACTED)
      .replace(/:\/\/([^\s:/@]*):[^\s@/]+@/g, `://$1:${REDACTED}@`)
      .replace(/\bBearer\b.*$/i, `Bearer ${REDACTED}`),
  )
    .replace(/(--?(?:[A-Za-z0-9_-]*(?:token|secret|password|key))\s+)(?!-)\S+/gi, `$1${REDACTED}`)
    .replace(/[A-Za-z0-9_-]{24,}/g, REDACTED);
}

// The lead of a continued line (indentation, a box border or a prompt marker) and the border or whitespace that
// can follow a line's end. A redaction that reaches a line's end continues on the next line past its lead.
const LEAD = /^[\s│┃|>❯›]*/;
const TAIL = /[\s│┃|]+$/;

// The screen lines of an event's data: a first-prompt:screen's `screen`, an input:screen's `now`.
function linesOf(type: string, data: any): string[] {
  const lines = type === 'first-prompt:screen' ? data?.screen : data?.now;
  return Array.isArray(lines) ? lines.map((l) => String(l)) : [];
}

// The lines to attach: cleaned, trailing blank lines dropped, bounded to the last SCREEN_MAX_LINES and
// SCREEN_MAX_CHARS. `truncated` says whether any of the screen was left out.
export function boundedScreen(lines: string[]): { text: string; truncated: boolean } {
  // A redaction that reaches the end of a line may continue on the next one (a key wrapped by the terminal), so
  // that line's leading run of token characters, past its lead, is redacted too, and so on while the run
  // reaches its line's end. A border after the end doesn't break the chain.
  const clean: string[] = [];
  let carry = false;
  for (const raw of lines) {
    const plain = raw.replace(ANSI, '').replace(/\s+$/, '');
    let line: string = redactScreen(plain);
    if (carry) {
      const lead = LEAD.exec(line)![0];
      const run = /^[A-Za-z0-9_\-/+=]+/.exec(line.slice(lead.length))?.[0] ?? '';
      if (run) line = lead + REDACTED + line.slice(lead.length + run.length);
    }
    carry = /[A-Za-z0-9_\-/+=]$/.test(plain.replace(TAIL, '')) && line.replace(TAIL, '').endsWith(REDACTED);
    clean.push(line);
  }
  while (clean.length && !clean[clean.length - 1]) clean.pop();
  let text = clean.slice(-SCREEN_MAX_LINES).join('\n');
  let truncated = clean.length > SCREEN_MAX_LINES;
  if (text.length > SCREEN_MAX_CHARS) {
    text = text.slice(-SCREEN_MAX_CHARS);
    truncated = true;
  }
  // A capture can't close the fence the body puts it in.
  return { text: text.replace(/`{3,}/g, "'''"), truncated };
}

// The why of a refused or failed read: a 403 is the rule saying the agent isn't in the reporter's tree.
function why(e: unknown): string {
  const status = (e as { status?: number }).status;
  const message = e instanceof Error ? e.message : String(e);
  return status === 403 ? `not in your tree (${message})` : `the read failed (${message})`;
}

// The screen sections for a report's details, one per named agent and screen type, plus a line for each
// screen not attached. Empty when the details name no screen event.
export async function screenSection(api: Api, details: string): Promise<string> {
  try {
    return await sectionOf(api, details);
  } catch (e) {
    return `Screen not attached: ${why(e)}.`;
  }
}

async function sectionOf(api: Api, details: string): Promise<string> {
  const types = screenTypesIn(details);
  if (!types.length) return '';
  let agents: { id: string; name: string }[];
  try {
    agents = await api('GET', '/api/agents');
  } catch (e) {
    return `Screen not attached: the agent list couldn't be read (${why(e)}).`;
  }
  const found = namedAgents(details, agents);
  const named = found.slice(0, SCREEN_MAX_AGENTS);
  const parts: string[] = [];
  if (!found.length) parts.push('Screen not attached: the report names no agent this daemon knows.');
  if (found.length > named.length) parts.push(`Screen not attached for ${found.length - named.length} more agent${found.length - named.length === 1 ? '' : 's'}: a report reads at most ${SCREEN_MAX_AGENTS}.`);
  for (const a of named) {
    for (const type of types) {
      try {
        const [event] = await api('GET', `/api/agents/${encodeURIComponent(a.id)}/events?type=${type}&limit=1`);
        if (!event) {
          parts.push(`Screen not attached: no ${type} event for ${a.name}.`);
          continue;
        }
        const { text, truncated } = boundedScreen(linesOf(type, JSON.parse(event.data ?? 'null')));
        parts.push(`Screen of ${type} on ${a.name} (event at ${event.ts}, latest${truncated ? '; truncated to its last lines' : ''}):\n\n\`\`\`text\n${text}\n\`\`\``);
      } catch (e) {
        parts.push(`Screen not attached: ${type} on ${a.name}, ${why(e)}.`);
      }
    }
  }
  return parts.join('\n\n');
}
