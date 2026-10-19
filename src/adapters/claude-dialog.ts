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
