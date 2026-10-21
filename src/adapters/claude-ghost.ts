// What Claude Code's input box holds while stam types a first prompt (S-2123): nothing, a
// placeholder or prompt suggestion it draws faint in an empty box (which typing or a paste
// replaces), exactly the prompt, or something else. A plain capture can't tell faint text from
// typed text, so this reads the pane captured with its styles (tmux capture-pane -e). Faint is
// SGR 2 (dim) or bright black (90); the cursor may sit, drawn inverse, on the first character.
// Pure, so it tests without a pane.
import { promptBoxRows } from './claude-input.ts';

const SGR = /\x1b\[([0-9;:]*)m/y;
const OTHER = /\x1b(\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|.)/y;

type Cell = { ch: string; faint: boolean; inverse: boolean };

// The cells of one captured row: each character with whether it was drawn faint or inverse.
function cells(row: string): Cell[] {
  const out: Cell[] = [];
  let dim = false, grey = false, inverse = false;
  for (let i = 0; i < row.length; ) {
    SGR.lastIndex = i;
    const m = SGR.exec(row);
    if (m) {
      // A colon form (38:5:n) is one parameter, so it never reads as separate codes.
      const p = m[1] ? m[1].split(';') : ['0'];
      for (let k = 0; k < p.length; k++) {
        if (p[k].includes(':')) {
          if (p[k].startsWith('38')) grey = false;
          continue;
        }
        const n = Number(p[k] || 0);
        const skip = () => (k += p[k + 1] === '5' ? 2 : p[k + 1] === '2' ? 4 : 0);
        if (n === 0) (dim = false), (grey = false), (inverse = false);
        else if (n === 2) dim = true;
        else if (n === 22) dim = false;
        else if (n === 7) inverse = true;
        else if (n === 27) inverse = false;
        else if (n === 90) grey = true;
        else if ((n >= 30 && n <= 37) || n === 39 || (n >= 91 && n <= 97)) grey = false;
        else if (n === 38) (grey = false), skip();
        else if (n === 48 || n === 58) skip();
      }
      i = SGR.lastIndex;
      continue;
    }
    if (row[i] === '\x1b') {
      OTHER.lastIndex = i;
      i = OTHER.exec(row) ? OTHER.lastIndex : i + 1;
      continue;
    }
    const ch = String.fromCodePoint(row.codePointAt(i)!);
    out.push({ ch, faint: dim || grey, inverse });
    i += ch.length;
  }
  return out;
}

const plain = (row: string) => cells(row).map((c) => c.ch).join('');
const visible = (c: Cell) => !!c.ch.trim() && c.ch !== ' ';

// The box's text cells, every row of it: the first row after its mark, the rows it wraps onto as
// they are. Undefined with no box.
function boxCells(ansi: string[]): Cell[][] | undefined {
  const rows = promptBoxRows(ansi.map(plain));
  if (!rows) return undefined;
  return ansi.slice(rows.at, rows.end).map((r, i) => {
    const c = cells(r);
    return i ? c : c.slice(c.findIndex((x) => x.ch === '❯' || x.ch === '!') + 1);
  });
}

// True when the box holds text and every visible character of it, on every row, is faint, but
// for an inverse cursor on the first one. Typed text anywhere in it, an empty box, or no box: false.
export function inputGhost(ansi: string[]): boolean {
  const text = boxCells(ansi)?.flat().filter(visible);
  if (!text?.length) return false;
  return text.every((c, i) => c.faint || (i === 0 && c.inverse)) && text.some((c) => c.faint);
}

// What the box holds, for a prompt being typed: 'empty' (nothing, or only faint text), 'one'
// (exactly one copy of `text`), 'other' (anything else, such as a part, or two copies), or
// undefined with no box. Whitespace doesn't count, since Claude Code wraps at words and draws a
// pasted newline as a new row. A faint tail after the copy (a completion hint) doesn't count either.
// A paste Claude Code folds into one `[Pasted text #N]` token (2.1.303 folds one of over 800
// characters; `+M lines` follows for several lines) counts as one copy; two tokens, or a token with
// other text, are 'other'. A box too tall for the pane shows a window of its last rows, the mark on
// the first one (seen on 2.1.303 at 40x20: five rows): a box of three rows or more whose text ends
// the prompt counts as one copy. Two copies that both outgrow the window can't be told from one.
export function promptInBox(ansi: string[], text: string): 'empty' | 'one' | 'other' | undefined {
  const box = boxCells(ansi);
  if (!box) return undefined;
  const shown = box.flat().filter(visible);
  if (!shown.length || inputGhost(ansi)) return 'empty';
  const solid = shown.findLastIndex((c) => !c.faint);
  if (shown.slice(0, solid + 1).some((c) => c.faint)) return 'other';
  const squash = (s: string) => s.replace(/[\s\u00a0]+/g, '');
  const got = shown.slice(0, solid + 1).map((c) => c.ch).join('');
  const want = squash(text);
  if (got === want || /^\[Pastedtext#\d+(\+\d+lines?)?\]$/.test(got)) return 'one';
  if (box.filter((r) => r.some(visible)).length >= 3 && got.length < want.length && want.endsWith(got)) return 'one';
  return 'other';
}
