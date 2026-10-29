// Ties a stam permission request to the Claude Code permission dialog on an agent's screen
// (S-276), so stam types an answer only into the dialog the request is about.
import { homedir } from 'node:os';

// A dialog request's details: the tool, its input as the hook gave it, and the harness
// session that showed the dialog.
export interface DialogDetails {
  tool?: string;
  input?: Record<string, unknown>;
  session?: string;
}

export function dialogDetails(details: string): DialogDetails {
  try {
    return JSON.parse(details) ?? {};
  } catch {
    return {};
  }
}

// What a permission dialog names: the file's full path, or the whole command, URL, or pattern.
export function dialogTarget(input: Record<string, unknown> = {}): string {
  const v = input.file_path ?? input.notebook_path ?? input.path ?? input.command ?? input.url ?? input.pattern;
  return typeof v === 'string' ? v : '';
}

// Whitespace, line breaks, and box borders go, since the pane wraps and frames long lines.
const squeeze = (t: string) => t.replace(/[\s│┃╭╮╰╯─━]+/g, '');

// Whether the dialog's body names exactly the request's tool and target: the call
// TOOL(target), with TOOL( starting a line, as in "Read(/path)", and the home folder written
// as ~ or in full. Whitespace and box borders are ignored, since the pane wraps and frames
// long lines. A longer path or command, a tool named only inside some text, a target the
// dialog shortened (…), or any other shape fails closed.
export function dialogNames(body: string[], tool: string, target: string): boolean {
  if (!/^\w+$/.test(tool) || !squeeze(target)) return false;
  const rows = body.map(squeeze);
  const text = rows.join('');
  // Where each non-blank squeezed line starts in `text`.
  const starts = new Set<number>();
  for (let i = 0, at = 0; i < rows.length; at += rows[i].length, i++) if (rows[i]) starts.add(at);
  const home = homedir();
  const forms = [target, target.startsWith(home + '/') ? '~' + target.slice(home.length) : target].map(squeeze);
  return forms.some((f) => {
    const call = tool + '(' + f + ')';
    for (let i = text.indexOf(call); i >= 0; i = text.indexOf(call, i + 1)) if (starts.has(i)) return true;
    return false;
  });
}

// The options that answer once (S-320). Claude Code lists others, such as "Yes, and keep
// allowing any reads outside the working directories", that change its settings for good.
const YES_ONCE = /^Yes(, but ask again next time)?$/;
const NO_ONCE = /^No, and ask again next time$/;

// The key that picks the dialog's one-time answer, found by its text: a yes is "Yes" or "Yes,
// but ask again next time", a no "No, and ask again next time". None means the dialog has no
// such option: a yes fails closed, and a no is Esc.
export function dialogKey(body: string[], approve: boolean): string | undefined {
  for (const line of body) {
    const m = /^(?:❯\s*)?([1-9])\.\s+(.*?)$/.exec(line.replace(/[│┃]/g, '').trim());
    if (m && (approve ? YES_ONCE : NO_ONCE).test(m[2])) return m[1];
  }
  return undefined;
}

// A question dialog's one question, its option labels in order, and whether it is multi-select (S-3978). Several
// questions in one call, or none, and an option with no label are not a shape stam can match: undefined. A deny
// matches the screen with this (questionNames), as a yes does with dialogQuestion.
export function dialogPrompt(input: Record<string, unknown> = {}): { question: string; options: string[]; multiSelect: boolean } | undefined {
  const qs = input.questions;
  if (!Array.isArray(qs) || qs.length !== 1) return undefined;
  const q = qs[0] as { question?: unknown; options?: unknown; multiSelect?: unknown };
  if (typeof q.question !== 'string' || !q.question.trim() || !Array.isArray(q.options)) return undefined;
  const options = q.options.map((o) => (o && typeof (o as { label?: unknown }).label === 'string' ? (o as { label: string }).label : undefined));
  if (!options.length || options.some((l) => l === undefined || !l.trim())) return undefined;
  return { question: q.question, options: options as string[], multiSelect: q.multiSelect === true };
}

// The dialog's question a choice can be typed into (S-3978): a multi-select question (a digit only toggles an option
// there) or two options with the same label (the typed number would be the first one's) is not one: undefined.
export function dialogQuestion(input: Record<string, unknown> = {}): { question: string; options: string[] } | undefined {
  const p = dialogPrompt(input);
  if (!p || p.multiSelect || new Set(p.options).size !== p.options.length) return undefined;
  return { question: p.question, options: p.options };
}

// Whether the dialog's body shows the request's question and its options in order, each as "N. label"
// starting a line, so a choice typed as N picks that label and no other. Wrapped text and box borders
// are ignored, as in dialogNames. Anything else fails closed.
export function questionNames(body: string[], question: string, options: string[]): boolean {
  if (!squeeze(question)) return false;
  const text = body.map(squeeze).join('');
  if (!text.includes(squeeze(question))) return false;
  const lines = body.map((l) => l.replace(/[│┃]/g, '').trim()).filter(Boolean);
  return options.every((label, i) => lines.some((l) => {
    const m = /^(?:❯\s*)?(\d+)\.\s+(.*?)$/.exec(l);
    return !!m && m[1] === String(i + 1) && squeeze(m[2]) === squeeze(label);
  }));
}
