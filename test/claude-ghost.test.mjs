import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inputGhost, promptInBox } from '../src/adapters/claude-ghost.ts';

const RULE = '\x1b[37m' + '─'.repeat(40);
// The box as Claude Code draws it: its rows between two rules, the footer under them.
const box = (...rows) => [RULE, ...rows, RULE, '  \x1b[2m\x1b[37m-- INSERT --\x1b[0m'];

test("Claude Code's own placeholder, captured live (2.1.303, tmux capture-pane -e), is an empty box", () => {
  const real = readFileSync(new URL('fixtures/claude-ghost/placeholder.ansi', import.meta.url), 'utf8').split('\n');
  assert.equal(inputGhost(real), true);
  assert.equal(promptInBox(real, 'ghost first: reply FIRST-DONE'), 'empty');
});

test('a faint placeholder or prompt suggestion in the box counts as an empty box', () => {
  // As Claude Code draws a placeholder: the cursor (inverse) on its first character, the rest dim.
  assert.equal(inputGhost(box('\x1b[39m❯ \x1b[7mT\x1b[27m\x1b[2mry "fix the failing test"\x1b[22m')), true);
  // A suggestion with no cursor drawn on it, and one in bright black.
  assert.equal(inputGhost(box('❯ \x1b[2mrun the tests\x1b[0m')), true);
  assert.equal(inputGhost(box('❯ \x1b[90mrun the tests\x1b[39m')), true);
  // The mark itself may be dim (Claude Code dims the box while a turn runs).
  assert.equal(inputGhost(box('\x1b[2m❯ \x1b[0m\x1b[2mrun the tests')), true);
  // Combined parameters, a background, and a 256-colour foreground under dim.
  assert.equal(inputGhost(box('❯ \x1b[2;37mrun \x1b[48;5;236mthe\x1b[49m \x1b[38;5;245mtests')), true);
  assert.equal(inputGhost(box('❯ \x1b[0;90;48;2;1;2;3mrun the tests')), true);
  // A suggestion that wraps: every row faint.
  assert.equal(inputGhost(box('❯ \x1b[2mrun the tests and then', '  \x1b[2mfix what fails\x1b[22m')), true);
});

test('typed text anywhere in the box, an empty box, or no box is not a ghost', () => {
  assert.equal(inputGhost(box('\x1b[39m❯ run the tests')), false);
  assert.equal(inputGhost(box('\x1b[39m❯ ')), false);
  assert.equal(inputGhost(box('\x1b[2m❯ \x1b[0m')), false);
  assert.equal(inputGhost(['plain output', '\x1b[2mfaint output']), false);
  // Typed text with the cursor drawn inverse on a character: not faint.
  assert.equal(inputGhost(box('❯ run th\x1b[7me\x1b[27m tests')), false);
  // Part faint, part typed: typed text is there, so not a ghost.
  assert.equal(inputGhost(box('❯ run \x1b[2mthe tests\x1b[22m')), false);
  // Mixed rows: a faint first row, typed text on the row it wraps onto.
  assert.equal(inputGhost(box('❯ \x1b[2mrun the tests and then\x1b[22m', '  fix what fails')), false);
  assert.equal(inputGhost(box('❯ typed first row', '  \x1b[2mfaint second row')), false);
  // A reset ends dim, and 22 ends it as well.
  assert.equal(inputGhost(box('❯ \x1b[2mrun\x1b[0m tests')), false);
  assert.equal(inputGhost(box('❯ \x1b[2;1mrun\x1b[22m tests')), false);
  // A 256-colour or truecolour foreground resets bright black; its parameters aren't read as SGR codes.
  assert.equal(inputGhost(box('❯ \x1b[90m\x1b[38;5;2mrun')), false);
  assert.equal(inputGhost(box('❯ \x1b[38;2;2;2;2mrun')), false);
  assert.equal(inputGhost(box('❯ \x1b[90;38:5:2mrun')), false);
  // A background colour's parameters don't turn dim on.
  assert.equal(inputGhost(box('❯ \x1b[48;5;2mrun')), false);
  assert.equal(inputGhost(box('❯ \x1b[48;2;2;90;2mrun')), false);
});

test('only the box counts, not an earlier prompt row above it', () => {
  const earlier = '\x1b[37m\x1b[100m❯ \x1b[97man earlier prompt\x1b[39m';
  assert.equal(inputGhost([earlier, ...box('❯ \x1b[2mrun the tests\x1b[22m')]), true);
  assert.equal(inputGhost(['❯ \x1b[2mold suggestion', ...box('❯ typed')]), false);
});

test('promptInBox: empty, exactly one copy, or anything else', () => {
  const text = 'ghost first: reply FIRST-DONE';
  assert.equal(promptInBox(['no box here'], text), undefined);
  assert.equal(promptInBox(box('❯ '), text), 'empty');
  assert.equal(promptInBox(box('❯ \x1b[7mT\x1b[27m\x1b[2mry "fix it"'), text), 'empty');
  assert.equal(promptInBox(box(`❯ ${text}`), text), 'one');
  // Wrapped at a word, or by the terminal: whitespace doesn't count.
  assert.equal(promptInBox(box('❯ ghost first: reply', '  FIRST-DONE'), text), 'one');
  // A multi-line prompt, each line a row.
  assert.equal(promptInBox(box('❯ line one', '  line two'), 'line one\nline two'), 'one');
  // A paste Claude Code folds into one token.
  assert.equal(promptInBox(box('❯ [Pasted text #1 +42 lines]'), 'x\n'.repeat(43)), 'one');
  // Part of it, two copies, two tokens, a token with text, or other text: 'other'.
  assert.equal(promptInBox(box('❯ ghost first: rep'), text), 'other');
  assert.equal(promptInBox(box(`❯ ${text}${text}`), text), 'other');
  assert.equal(promptInBox(box('❯ [Pasted text #1 +42 lines][Pasted text #2 +42 lines]'), 'x'), 'other');
  assert.equal(promptInBox(box('❯ [Pasted text #1 +42 lines] more'), 'x'), 'other');
  assert.equal(promptInBox(box('❯ a human draft'), text), 'other');
  // A placeholder with typed text on a later row is not empty.
  assert.equal(promptInBox(box('❯ \x1b[2mTry this', '  typed'), text), 'other');
  // A single-line paste Claude Code folds has no line count.
  assert.equal(promptInBox(box('❯ [Pasted text #1]'), 'x'.repeat(900)), 'one');
});

test('promptInBox: a faint hint after an exact copy still counts as one copy', () => {
  assert.equal(promptInBox(box('❯ /review\x1b[2m [pr-number]\x1b[22m'), '/review'), 'one');
  assert.equal(promptInBox(box('❯ look at @src/a\x1b[90mdapters/\x1b[39m'), 'look at @src/a'), 'one');
  // Faint text inside the copy, or a hint after a part, is not.
  assert.equal(promptInBox(box('❯ /rev\x1b[2mie\x1b[22mw'), '/review'), 'other');
  assert.equal(promptInBox(box('❯ /rev\x1b[2miew\x1b[22m'), '/review'), 'other');
});

test('promptInBox: a box too tall for the pane shows its last rows, which end the prompt', () => {
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet ';
  const long = words.repeat(10).slice(0, 600).trim();
  // As Claude Code 2.1.303 drew this prompt at 40x20: a window of five rows, the mark on the first.
  const window = box('❯ alpha bravo charlie delta echo', '  foxtrot golf hotel india juliet', '  alpha bravo charlie delta echo', '  foxtrot golf hotel india juliet', '  alpha bravo charlie delta echo fo');
  assert.equal(promptInBox(window, long), 'one');
  // Rows that don't end the prompt (a paste still landing), or a short box with only the end of it.
  assert.equal(promptInBox(box('❯ alpha bravo charlie delta echo', '  foxtrot golf hotel india juliet', '  alpha bravo'), long), 'other');
  assert.equal(promptInBox(box('❯ alpha bravo charlie delta echo fo'), long), 'other');
  // Extra text after the end is never one copy.
  assert.equal(promptInBox(box('❯ alpha bravo charlie delta echo', '  foxtrot golf hotel india juliet', '  alpha bravo charlie delta echo fo', '  more'), long), 'other');
});
