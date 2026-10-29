// A stand-in for Claude Code's input box in a tmux pane, for go/internal/lifecycle's typing tests (S-2848 B3b): the
// output above, the box between two rules with the cursor at the end of its text, and the footer under it. Keys edit
// the box as Claude Code does: a backspace deletes a grapheme, Enter submits (appended to LOG) or takes a completion
// menu's row, Esc closes the menu or leaves vim's insert mode, and in normal mode i and A enter insert mode. Set by the
// environment: ABOVE (lines split on |), BOX (the text already in the box), VIM (normal or insert), MENU (draw a menu
// under the box while the text starts with /), IGNORE_BS (backspaces to drop, as a slow terminal could), LOG.
import { appendFileSync } from 'node:fs';

const env = process.env;
const above = (env.ABOVE ?? 'some output').split('|');
let buf = env.BOX ?? '';
let mode = env.VIM ?? '';
let menu = false;
let ignoreBs = Number(env.IGNORE_BS ?? 0);
const graphemes = (s) => [...new Intl.Segmenter().segment(s)].map((g) => g.segment);
const rule = '─'.repeat(30);

function draw() {
  const footer = mode === 'insert' ? '-- INSERT --' : mode === 'normal' ? '-- NORMAL --' : '? for shortcuts';
  const rows = [...above, '', rule, '❯ ' + buf, rule, '  ' + footer];
  if (menu) rows.push('  ❯ /help', '    /hooks');
  // The box's row, 1-based, and the column after its text (ASCII in these tests).
  process.stdout.write('\x1b[2J\x1b[H' + rows.join('\r\n') + `\x1b[${above.length + 3};${3 + [...buf].length}H`);
}

function key(c) {
  if (c === '\x1b') {
    if (menu) menu = false;
    else if (mode === 'insert') mode = 'normal';
  } else if (c === '\x7f') {
    if (ignoreBs > 0) ignoreBs--;
    else if (mode !== 'normal') buf = graphemes(buf).slice(0, -1).join('');
  } else if (c === '\r') {
    if (menu) {
      buf = '/help';
      menu = false;
    } else {
      appendFileSync(env.LOG, buf + '\n');
      buf = '';
    }
  } else if (mode === 'normal') {
    if (c === 'i' || c === 'A') mode = 'insert';
  } else {
    buf += c;
    menu = !!env.MENU && buf.startsWith('/');
  }
}

process.stdin.setRawMode(true);
process.stdin.on('data', (d) => {
  let s = d.toString('utf8');
  while (s) {
    // A key tmux sends as a sequence, such as End: nothing in the box.
    const seq = s.match(/^\x1b[[O][0-9;]*[A-Za-z~]/);
    if (seq) {
      s = s.slice(seq[0].length);
      continue;
    }
    const [c] = s;
    s = s.slice(c.length);
    key(c);
  }
  draw();
});
draw();
