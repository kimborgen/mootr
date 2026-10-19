#!/usr/bin/env node
// Unit tests for src/adapters/claude-input.ts (S-422): what a suggestion may be, and whether
// Claude Code's input box shows exactly the text stam typed, in the right mode. Deterministic, no daemon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { displayWidth, inputBox, inputShows, inputProblem, aroundBox, sameAround, bashInputRecorded, menuUnderBox } from '../src/adapters/claude-input.ts';

const pane = (...box) => ['  fake-claude · claude-haiku-5-5 · auto mode', '> earlier prompt', ...box];

test('the box shows exactly the text', () => {
  assert.equal(inputShows(pane('❯ echo  two  spaces;'), 'echo  two  spaces;'), true);
  // Claude Code pads the mark with a no-break space.
  assert.equal(inputShows(pane('❯\u00a0say ok'), 'say ok'), true);
  assert.equal(inputShows(pane('❯\u00a0 say ok'), 'say ok'), false);
  assert.equal(inputShows(pane('❯   leading', '─────'), '  leading'), true);
  // Claude Code's own wrapping indents the next row by the box's padding; a word too long for a
  // full row breaks inside it.
  assert.equal(inputShows(pane('❯ echo aaaa', '  bbbb', '─────', '  ? for shortcuts'), 'echo aaaabbbb', 12), true);
  // A row the terminal filled to the pane's width wraps with no padding.
  assert.equal(inputShows(pane('❯ echo aa', 'bb'), 'echo aabb', 9), true);
  // Without the width, a wrapped box never matches.
  assert.equal(inputShows(pane('❯ echo aaaa', '  bbbb'), 'echo aaaabbbb'), false);
});

test('bash mode: text starting with ! shows the ! mark, and only it does', () => {
  assert.equal(inputShows(pane('!  echo  two  spaces;'), '! echo  two  spaces;'), true);
  assert.equal(inputShows(pane('! git status', '─────'), '!git status'), true);
  assert.equal(inputShows(pane('! git status', '─────'), 'git status'), false);
  assert.equal(inputShows(pane('❯ ! git status'), '! git status'), false);
});

test('anything other than exactly the text fails', () => {
  assert.equal(inputShows(['❯ echo "ab"', '─────'], 'echo "a b"'), false);
  assert.equal(inputShows(['❯ echo a b', '─────'], 'echo a  b'), false);
  assert.equal(inputShows(['❯ rm -rf a b'], 'rm -rf "a b"'), false);
  assert.equal(inputShows(pane('❯ my draft echo hi'), 'echo hi'), false);
  assert.equal(inputShows(pane('❯ echo h'), 'echo hi'), false);
  assert.equal(inputShows(pane('❯'), 'echo hi'), false);
  assert.equal(inputShows(['no box here'], 'echo hi'), false);
  // A wrapped row that isn't padded, or padded with more than the box's padding, fails.
  assert.equal(inputShows(pane('❯ echo aaaa', 'bbbb'), 'echo aaaabbbb', 12), false);
  assert.equal(inputShows(pane('❯ echo aaaa', '   bbbb'), 'echo aaaa bbbb', 12), false);
  assert.equal(inputBox(pane('❯ echo aaaa', 'bbbb')).text, undefined);
});

test('word wrap: spaces may go missing only at a break where the next word would not fit', () => {
  // Row 11 columns + 1 space + 4 = 16, wider than 12 - 1: the space went with the wrap.
  assert.equal(inputShows(pane('❯ echo aaaa', '  bbbb'), 'echo aaaa bbbb', 12), true);
  assert.equal(inputShows(pane('❯ echo aaaa', '  bbbb'), 'echo aaaa   bbbb', 12), true);
  // In a wide pane bbbb would have fitted on the row, so this isn't a wrap that dropped the space.
  assert.equal(inputShows(pane('❯ echo aaaa', '  bbbb'), 'echo aaaa bbbb', 40), false);
  // No space at a break that isn't a full row: a character went missing.
  assert.equal(inputShows(pane('❯ echo aaa', '  bbbb'), 'echo aaaxbbbb', 12), false);
  assert.equal(inputShows(pane('❯ echo aa', '  bbbb'), 'echo aabbbb', 12), false);
  // A word wider than a row breaks inside it at 2 columns under the width, with nothing dropped.
  assert.equal(inputShows(pane('❯ echo aaa', '  bbbb'), 'echo aaabbbb', 12), true);
});

test('the box is the last prompt line; around it is the rest of the screen, footer aside', () => {
  assert.deepEqual(inputBox(pane('❯ old', 'log', '❯ new', '───', 'hint')), { mark: '❯', text: 'new' });
  assert.equal(inputBox(['nothing']), undefined);
  const idle = aroundBox(pane('❯', '', ''));
  assert.equal(sameAround(idle, aroundBox(pane('❯ /re', '', '  ▸ /menu-pick', ''))), false);
  assert.equal(sameAround(idle, aroundBox(pane('❯ /re', '', ''))), true);
  // The footer under the bottom rule changes as text is typed; it isn't compared.
  assert.equal(sameAround(aroundBox(pane('❯', '───', 'a hint')), aroundBox(pane('❯ x', '───', 'another hint'))), true);
  // Wrapped lines scroll the lines above up.
  assert.equal(sameAround(aroundBox(['a', 'b', 'c', '❯']), aroundBox(['b', 'c', '❯ x', '  y'])), true);
  assert.equal(sameAround(aroundBox(['a', 'b', 'c', '❯']), aroundBox(['b', 'menu', '❯ x'])), false);
});

// Real Claude Code 2.1.296 screens (haiku, vim keys, 200 columns), recorded by the S-427 smoke check.
const real = (name) => readFileSync(new URL(`fixtures/claude-input/${name}.txt`, import.meta.url), 'utf8').split('\n');

test('real Claude Code: the box, bash mode, and its completion menu', () => {
  const idle = real('00-idle');
  assert.deepEqual(inputBox(idle, 200), { mark: '❯', text: '' });
  assert.equal(inputShows(real('03-plain-typed'), 'say ok', 200), true);
  assert.equal(inputShows(real('03-plain-typed'), 'say  ok', 200), false);
  assert.equal(inputShows(real('01-bash-typed'), '! echo s422-smoke  a;b', 200), true);
  assert.equal(inputShows(real('01-bash-typed'), 'echo s422-smoke  a;b', 200), false);
  assert.equal(inputShows(real('01-bash-typed'), '!echo s422-smoke  a;b', 200), false);
  // Typing changes only the footer; a / menu draws over the box, and one Esc closes it.
  assert.equal(sameAround(aroundBox(idle), aroundBox(real('03-plain-typed'))), true);
  assert.equal(sameAround(aroundBox(idle), aroundBox(real('01-bash-typed'))), true);
  assert.equal(sameAround(aroundBox(idle), aroundBox(real('05-slash-typed'))), false);
  assert.equal(sameAround(aroundBox(idle), aroundBox(real('06-slash-esc'))), true);
  assert.equal(inputShows(real('06-slash-esc'), '/re', 200), true);
});

// S-500: `! rm ~/.local/share/stam/deploy-hold` opened Claude Code's path menu, whose highlighted
// row starts with ❯. On alpha it drew under the box (09, from the input:screen event, blank
// lines left out); here it drew over it (10), and one Esc closed it, keeping bash mode and the text (11).
test('real Claude Code: a path menu under or over the box is not the box, and holds Enter back', () => {
  const t = '! rm ~/.local/share/stam/deploy-hold';
  const under = real('09-bash-menu-under');
  assert.deepEqual(inputBox(under, 200), { mark: '!', text: ' rm ~/.local/share/stam/deploy-hold' });
  assert.equal(inputShows(under, t, 200), true);
  assert.equal(menuUnderBox(under), true);
  const over = real('10-bash-menu-over');
  assert.equal(inputShows(over, '! rm dir/sub/hold', 200), true);
  assert.equal(menuUnderBox(over), false);
  assert.equal(sameAround(aroundBox(real('00-idle')), aroundBox(over)), false);
  const esc = real('11-bash-menu-esc');
  assert.equal(inputShows(esc, '! rm dir/sub/hold', 200), true);
  assert.equal(menuUnderBox(esc), false);
  for (const name of ['00-idle', '01-bash-typed', '03-plain-typed', '05-slash-typed', '06-slash-esc']) assert.equal(menuUnderBox(real(name)), false, name);
  // Screens with no rules (the fake) still find the last mark line.
  assert.equal(inputShows(pane('❯ say ok'), 'say ok'), true);
});

test('real Claude Code: long text word-wraps in the box', () => {
  const text = (name) => readFileSync(new URL(`fixtures/claude-input/${name}.text`, import.meta.url), 'utf8');
  for (const name of ['07-bash-wrapped', '08-plain-wrapped']) {
    const t = text(name);
    assert.equal(inputShows(real(name), t, 200), true, name);
    // A space missing, or one more, mid-row.
    const mid = t.indexOf(' ', 20);
    assert.equal(inputShows(real(name), t.slice(0, mid) + t.slice(mid + 1), 200), false, `${name}: a space missing`);
    assert.equal(inputShows(real(name), t.slice(0, mid) + ' ' + t.slice(mid), 200), false, `${name}: a space more`);
    // A character missing at the break: the text has one the box doesn't show.
    const row = real(name).find((l) => /^\s*[❯!]/.test(l) && [...l].length > 150);
    const at = t.indexOf(row.slice(-8)) + 8;
    assert.equal(inputShows(real(name), t.slice(0, at) + 'x' + t.slice(at), 200), false, `${name}: a character at the break`);
    // In a wider pane the row would have held the next word.
    assert.equal(inputShows(real(name), t, 260), false, `${name}: wider pane`);
  }
  assert.equal(inputShows(real('07-bash-wrapped'), text('07-bash-wrapped').slice(1), 200), false);
});

test('a suggestion is one line of at most 2000 characters with no control characters', () => {
  assert.equal(inputProblem('! echo  hi;'), undefined);
  assert.equal(inputProblem('x'.repeat(2000)), undefined);
  assert.match(inputProblem('x'.repeat(2001)), /2000/);
  assert.match(inputProblem(''), /empty/);
  assert.match(inputProblem('   '), /empty/);
  assert.match(inputProblem(42), /empty/);
  assert.match(inputProblem('echo hi '), /whitespace/);
  for (const c of ['\n', '\r', '\t', '\x1b', '\x00', '\x7f', '\x9b', '\u2028']) assert.match(inputProblem(`a${c}b`), /one line/, JSON.stringify(c));
});

test('a bash-mode command is found in the transcript rows appended after Enter, as Claude Code records it', () => {
  const real = readFileSync(new URL('fixtures/claude-input/bash-input.jsonl', import.meta.url), 'utf8');
  assert.equal(bashInputRecorded(real, '! echo s422-smoke  a;b'), 'match');
  assert.equal(bashInputRecorded(real, '! echo s422-smoke a;b'), 'other');
  assert.equal(bashInputRecorded(real, '!echo s422-smoke  a;b'), 'other');
  // The agent's own suggest_input call holds the text, but isn't a bash-input record.
  const call = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: { text: '! echo s422-smoke  a;b' } }] } });
  assert.equal(bashInputRecorded(call, '! echo s422-smoke  a;b'), 'none');
  assert.equal(bashInputRecorded(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '<bash-input> ls</bash-input>' }] } }), '! ls'), 'match');
  assert.equal(bashInputRecorded('not json\n', '! ls'), 'none');
});


// S-1984: in a 40-column pane the 116-character `! node …/export.mjs --push --commit SHA` line
// breaks inside its long words (Claude Code 2.1.303 breaks a word wider than a row once the row is
// full, which is 2 columns under the pane width), and the continuation rows start with the padding.
test('real Claude Code: a bash line with words wider than the pane', () => {
  const t = '! node /home/dev/projects/stam2/export/export.mjs --push --commit ccd4a114d2723395b45b9fed4ad5f1b2ca2e26aa';
  const narrow = real('12-bash-long-token-narrow');
  assert.equal(inputShows(narrow, t, 40), true);
  // A changed character, a dropped one, a missing mode mark, or no width never matches.
  assert.equal(inputShows(narrow, t.replace('ccd4a114', 'ccd4a115'), 40), false);
  assert.equal(inputShows(narrow, t.replace('--push ', '--push  '), 40), false);
  assert.equal(inputShows(narrow, t.slice(1).trimStart(), 40), false);
  assert.equal(inputShows(narrow, t, undefined), false);
  assert.equal(inputShows(narrow, t + 'x', 40), false);
});

// Wide characters fill two columns, so rows break by display width. A multi-row match is allowed only
// for printable ASCII and characters of certain width (kana, CJK, Hangul, fullwidth): anything else
// (emoji and their joiners, variation selectors, combining marks, other scripts) is refused.
test('word wrap: only characters of certain width may wrap', () => {
  assert.equal(displayWidth('界a'), 3);
  // Plain ASCII and CJK wraps are accepted. Width 12: "❯ 界界界界" fills 2 + 8 = 10 columns.
  assert.equal(inputShows(pane('❯ echo aaa', '  bbbb'), 'echo aaabbbb', 12), true);
  assert.equal(inputShows(pane('❯ 界界界界', '  界界'), '界界界界界界', 12), true);
  assert.equal(inputShows(pane('❯ 界界界界', '  界界'), '界界界界界x', 12), false);
  assert.equal(inputShows(pane('❯ 界界', '  界界'), '界界界界', 12), false);
  assert.deepEqual(inputBox(pane('❯ 界界界界', '  界界'), 12), { mark: '❯', text: '界界界界界界' });
  assert.deepEqual(inputBox(pane('❯ echo aaa', '  bbbb'), 12), { mark: '❯', text: 'echo aaabbbb' });
  // Refused in a wrap, in the box rows or in the suggestion: emoji, ZWJ, variation selectors (FE0F and
  // FE0E), skin tones, flags, keycaps, combining marks, other scripts. inputBox gives no text.
  const refused = ['😀', '👩‍💻', '❤️', '🖥︎', '👍\u{1f3fd}', '🇳🇴', '1️⃣', 'é', 'é́', 'ж', 'か\u3099', '\u309a'];
  for (const c of refused) {
    const text = c + 'abcdefghi';
    const rows = pane('❯ ' + c + 'abcdefg', '  hi');
    assert.equal(inputShows(rows, text, 12), false, c);
    assert.deepEqual(inputBox(rows, 12), { mark: '❯', text: undefined }, c);
    // A cluster split across the row boundary.
    const split = pane('❯ abcdefgh' + c.slice(0, 1), '  ' + c.slice(1) + 'ij');
    assert.equal(inputShows(split, 'abcdefgh' + c + 'ij', 12), false, c);
    assert.deepEqual(inputBox(split, 12), { mark: '❯', text: undefined }, c);
  }
  // The reviewer's cases: the second row's padding could be read as two literal spaces.
  assert.equal(inputShows(pane('❯ 👩‍💻abcd', '  ef'), '👩‍💻abcd  ef', 10), false);
  assert.equal(inputShows(pane('❯ 🖥︎abcdef', '  gh'), '🖥︎abcdef  gh', 10), false);
  // U+3099 and U+309A combine with the kana before them (the reviewers' case, both readings: the
  // row is full at width 10, and the padding could be two literal spaces).
  for (const m of ['\u3099', '\u309a']) {
    const t = 'か' + m + 'abcdef';
    assert.equal(inputShows(pane('❯ ' + t, '  gh'), t + '  gh', 10), false);
    assert.equal(inputShows(pane('❯ ' + t, '  gh'), t + 'gh', 10), false);
    assert.deepEqual(inputBox(pane('❯ ' + t, '  gh'), 10), { mark: '❯', text: undefined });
  }
  assert.equal(inputShows(pane('❯ がabcdef', '  gh'), 'がabcdefgh', 10), true);
  // A suggestion with an emoji elsewhere makes the wrap refuse too.
  assert.equal(inputShows(pane('❯ echo aaa', '  bbbb'), 'echo aaabbbb 😀', 12), false);
  // On a single row they still match exactly.
  assert.equal(inputShows(pane('❯ 👩‍💻 hi'), '👩‍💻 hi', 40), true);
  assert.equal(inputShows(pane('❯ 🖥︎ hi'), '🖥︎ hi', 40), true);
  assert.deepEqual(inputBox(pane('❯ 😀 hi'), 40), { mark: '❯', text: '😀 hi' });
});
