// Claude Code's input box as the pane shows it, for typing a suggestion the human approved
// (S-422). Pure functions over captured lines, so they test without a pane.

const RULE = /^\s*[─━]{3,}/;

// What a multi-row match may involve: printable ASCII, the no-break space and the ❯ mark of the box,
// and characters whose width is certain (kana, without the combining marks U+3099 and U+309A, CJK ideographs, Hangul syllables and fullwidth forms,
// 2 columns each). Emoji and their joiners, variation selectors, combining marks and other scripts
// have a width the terminals and Claude Code may disagree on, so a wrap that involves one can't be
// told from literal spaces: it never matches, and `inputBox` gives no text.
const UNSURE = /[^\u0020-\u007e\u00a0\u276f\u3041-\u3096\u309b-\u30ff\u4e00-\u9fff\uac00-\ud7a3\uff01-\uff60]/u;

// Terminal columns a string fills: combining marks, zero-width characters and variation selectors
// take none, East Asian wide and fullwidth characters and emoji take two, everything else one.
export function displayWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (/^[\p{M}\p{Cf}]$/u.test(ch) || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x303e) || (c >= 0x3041 && c <= 0x33ff) || (c >= 0x3400 && c <= 0x4dbf) ||
      (c >= 0x4e00 && c <= 0xa4cf) || (c >= 0xa960 && c <= 0xa97f) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd);
    n += wide ? 2 : 1;
  }
  return n;
}

// Where the box is: the last line starting with its prompt mark (❯, or ! in bash mode), and the
// lines it wrapped onto, up to the rule under it or a blank line. Claude Code draws the box
// between two rules; a completion menu's highlighted row also starts with ❯ and may draw under
// the bottom rule (S-500), so a mark line with a rule above and under it wins when there is one.
function boxAt(lines: string[]): { at: number; end: number } | undefined {
  const endOf = (at: number) => {
    let end = at + 1;
    while (end < lines.length && !RULE.test(lines[end]) && lines[end].trim()) end++;
    return end;
  };
  const mark = (l: string) => /^\s*[❯!]/.test(l);
  let at = lines.findLastIndex((l, i) => mark(l) && i > 0 && RULE.test(lines[i - 1]) && RULE.test(lines[endOf(i)] ?? ''));
  if (at < 0) at = lines.findLastIndex(mark);
  if (at < 0) return undefined;
  return { at, end: endOf(at) };
}

// The rows the box fills, [at, end), or undefined without a box.
export function boxRows(lines: string[]): { at: number; end: number } | undefined {
  return boxAt(lines);
}

// Whether a completion menu shows under the box (S-500): Claude Code marks its highlighted row
// with ❯, and Enter would take that row. A menu over the box changes the lines above it instead,
// which sameAround finds.
export function menuUnderBox(lines: string[]): boolean {
  const box = boxAt(lines);
  return !!box && lines.slice(box.end).some((l) => /^\s+❯\s/.test(l));
}

// The box's mark and its text, rebuilt exactly: the mark and the one space after it (Claude Code
// draws a no-break space) are the box's padding. A line it wrapped onto joins with no separator:
// after a row the terminal filled to `width` (autowrap) as it is, else (Claude Code's own
// wrapping) only when it starts with the same padding, which is removed. Any other shape, such as
// wrapping that dropped a space (Claude Code wraps at words), can't be rebuilt exactly, so `text`
// is undefined and nothing matches it: a suggestion that wraps in the box fails closed.
export function inputBox(lines: string[], width?: number): { mark: string; text: string | undefined } | undefined {
  const box = boxAt(lines);
  if (!box) return undefined;
  const [, lead, mark, first] = /^(\s*)([❯!])(.*)$/.exec(lines[box.at])!;
  const pad = ' '.repeat([...lead].length + 2);
  let text: string | undefined = /^[ \u00a0]/.test(first) ? first.slice(1) : first;
  let prev = lines[box.at];
  if (box.end > box.at + 1 && UNSURE.test(lines.slice(box.at, box.end).join(''))) return { mark, text: undefined };
  for (const l of lines.slice(box.at + 1, box.end)) {
    if (width && displayWidth(prev) === width) text += l;
    else if (l.startsWith(pad) && l[pad.length] !== ' ') text += l.slice(pad.length);
    else text = undefined;
    if (text === undefined) break;
    prev = l;
  }
  return { mark, text };
}

// The screen around the box, where a completion menu (`/` commands, `@` files) draws: Claude Code
// draws it above the box, in place of the lines over its top rule; the fake draws it under the
// footer. `footer` is what Claude Code shows under the box's bottom rule, up to a blank line: the
// status line and the mode hints, which change as text is typed, and vim's -- INSERT --. Left out
// of `above` and `below`: the box, its rules, the footer, and the line just over the top rule when
// it is blank or a notice drawn right-aligned ("◐ medium · /effort"), which come and go by themselves.
export function aroundBox(lines: string[]): { above: string[]; below: string[]; footer: string[] } {
  const box = boxAt(lines);
  if (!box) return { above: lines, below: [], footer: [] };
  let top = box.at > 0 && RULE.test(lines[box.at - 1]) ? box.at - 1 : box.at;
  if (top < box.at && top > 0 && /^(\s{20,}\S.*|\s*)$/.test(lines[top - 1])) top--;
  let end = box.end;
  const footer: string[] = [];
  if (end < lines.length && RULE.test(lines[end])) for (end++; end < lines.length && lines[end].trim(); end++) footer.push(lines[end]);
  const below = lines.slice(end);
  while (below.length && !below[below.length - 1].trim()) below.pop();
  return { above: lines.slice(0, top), below, footer };
}

// Whether the screen around the box is as before, blank lines aside. The lines above the box
// shift when the box grows (wrapped lines scroll them up) or the footer shrinks (bash mode drops
// the status line, which moves the box down a line): the lines next to the box, as many as both
// screens have, must be the same.
export function sameAround(before: { above: string[]; below: string[] }, now: { above: string[]; below: string[] }): boolean {
  const solid = (l: string[]) => l.filter((x) => x.trim());
  const [b, a] = [solid(before.above), solid(now.above)];
  const n = Math.min(b.length, a.length);
  return JSON.stringify(b.slice(b.length - n)) === JSON.stringify(a.slice(a.length - n)) && JSON.stringify(solid(before.below)) === JSON.stringify(solid(now.below));
}

// Whether the box shows exactly `text`, in the right mode: Claude Code takes a leading ! as bash
// mode, shown as the box's mark, so text starting with ! must show the ! mark with the rest, and
// any other text the ❯ mark. The box's rows must spell the text character for character, with one
// allowance where a row wraps onto the next, as Claude Code word-wraps (seen on 2.1.296):
// - a run of spaces in the text may be missing at the break, if the word after it wouldn't have
//   fitted on the row (row + spaces + word wider than `width` - 1 columns);
// - with no space there, the row must be full (a word too long for a row breaks inside it);
// - after a row the terminal filled to `width` (the fake's autowrap) the next row goes on as is.
// Without `width`, a box of more than one row never matches. Anything else fails closed.
export function inputShows(lines: string[], text: string, width?: number): boolean {
  const box = boxAt(lines);
  if (!box || !text) return false;
  const bash = text.startsWith('!');
  const want = bash ? text.slice(1) : text;
  const [, lead, mark, first] = /^(\s*)([❯!])(.*)$/.exec(lines[box.at])!;
  if (mark !== (bash ? '!' : '❯')) return false;
  const pad = ' '.repeat([...lead].length + 2);
  const cols = displayWidth;
  const seg0 = /^[ \u00a0]/.test(first) ? first.slice(1) : first;
  if (!want.startsWith(seg0)) return false;
  let pos = seg0.length;
  let prev = lines[box.at];
  for (const l of lines.slice(box.at + 1, box.end)) {
    if (!width || UNSURE.test(text + lines.slice(box.at, box.end).join(''))) return false;
    // The row after a full one is either the terminal's autowrap, as is, or Claude Code's own break
    // inside a word too long for a row (a long path), which starts with the padding: both are read,
    // and the one that spells the text wins.
    const padded = () => {
      if (!l.startsWith(pad) || /^[ \u00a0]/.test(l.slice(pad.length))) return undefined;
      const rest = l.slice(pad.length);
      // A word too long for a row breaks inside it once the row is full (width - 2 columns, as the
      // box pads both sides), with nothing dropped.
      if (cols(prev) >= width - 2 && want.startsWith(rest, pos)) return rest;
      const run = /^ */.exec(want.slice(pos))![0].length;
      const word = /^[^ ]*/.exec(want.slice(pos + run))![0];
      if (run ? cols(prev) + run + cols(word) <= width - 1 : cols(prev) < width - 1) return undefined;
      pos += run;
      return rest;
    };
    const start = pos;
    let seg = cols(prev) === width && l && want.startsWith(l, pos) ? l : undefined;
    if (seg === undefined) {
      pos = start;
      seg = padded();
    }
    if (seg === undefined) return false;
    if (!seg || !want.startsWith(seg, pos)) return false;
    pos += seg.length;
    prev = l;
  }
  return pos === want.length;
}

// What a suggestion may be: one line, no control characters, at most 2000 characters, and not
// ending in whitespace, which the box can't show. Returns the reason it isn't, or undefined.
export const MAX_INPUT = 2000;
export function inputProblem(text: unknown): string | undefined {
  if (typeof text !== 'string' || !text.trim()) return 'the text is empty';
  if ([...text].length > MAX_INPUT) return `the text is over ${MAX_INPUT} characters`;
  // C0 controls (newline, carriage return, tab, ESC among them), DEL, C1 controls, and Unicode line breaks.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) return 'the text must be one line with no control characters (no newline, carriage return, tab, or escape)';
  if (/\s$/.test(text)) return "the text can't end in whitespace";
  return undefined;
}

// Whether a bash-mode command shows in transcript rows appended after Enter, as Claude Code
// (2.1.296) records one: a user message `<bash-input>TEXT AFTER THE !</bash-input>`. The first
// bash-input record is the one typed: 'other' when it isn't the text, 'none' while none shows yet.
export function bashInputRecorded(appended: string, text: string): 'match' | 'other' | 'none' {
  const want = `<bash-input>${text.slice(1)}</bash-input>`;
  for (const line of appended.split('\n')) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const c = row?.type === 'user' ? row.message?.content : undefined;
    const texts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.map((p: any) => p?.text) : [];
    if (texts.includes(want)) return 'match';
    if (texts.some((t: unknown) => typeof t === 'string' && t.startsWith('<bash-input>'))) return 'other';
  }
  return 'none';
}

