package claude

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"stam/internal/jsjson"
)

// Claude Code's input box as the pane shows it, for typing a suggestion the human approved (S-2848 B3b, a port of
// src/adapters/claude-input.ts). Pure functions over captured lines, so they test without a pane. Positions in the
// text are byte offsets: every offset here comes from the lengths of pieces of the same string, so they agree with
// TS's UTF-16 ones.

// unsure is claude-input.ts UNSURE: what a multi-row match may not involve. Printable ASCII, the no-break space, the ❯
// mark, and characters whose width is certain (kana without the combining marks, CJK ideographs, Hangul syllables,
// fullwidth forms) are sure; anything else makes a wrapped box unreadable, so it never matches.
var unsure = regexp.MustCompile(`[^\x{20}-\x{7e}\x{a0}\x{276f}\x{3041}-\x{3096}\x{309b}-\x{30ff}\x{4e00}-\x{9fff}\x{ac00}-\x{d7a3}\x{ff01}-\x{ff60}]`)

var (
	markLine   = regexp.MustCompile(`^(` + jsSpace + `*)([❯!])(.*)$`)
	menuRow    = regexp.MustCompile(`^` + jsSpace + `+❯` + jsSpace)
	notice     = regexp.MustCompile(`^(?:` + jsSpace + `{20,}[^` + jsSpaceChars + `].*|` + jsSpace + `*)$`)
	controls   = regexp.MustCompile(`[\x00-\x1f\x7f-\x{9f}\x{2028}\x{2029}]`)
	endsInWS   = regexp.MustCompile(jsSpace + `$`)
	bashPrefix = "<bash-input>"
)

// DisplayWidth is claude-input.ts displayWidth: the terminal columns a string fills. Combining marks, format
// characters and variation selectors take none, East Asian wide and fullwidth characters and emoji take two.
func DisplayWidth(s string) int {
	n := 0
	for _, c := range s {
		if unicode.In(c, unicode.M, unicode.Cf) || (c >= 0xfe00 && c <= 0xfe0f) {
			continue
		}
		wide := (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x303e) || (c >= 0x3041 && c <= 0x33ff) || (c >= 0x3400 && c <= 0x4dbf) ||
			(c >= 0x4e00 && c <= 0xa4cf) || (c >= 0xa960 && c <= 0xa97f) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
			(c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ||
			(c >= 0x20000 && c <= 0x3fffd)
		if wide {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// padded is whether s starts with a space or the no-break space Claude Code draws after the mark.
func padded(s string) bool { return strings.HasPrefix(s, " ") || strings.HasPrefix(s, " ") }

// dropPad is `/^[  ]/.test(s) ? s.slice(1) : s`.
func dropPad(s string) string {
	if padded(s) {
		_, n := utf8.DecodeRuneInString(s)
		return s[n:]
	}
	return s
}

// MenuUnderBox is claude-input.ts menuUnderBox: a completion menu's highlighted row (marked ❯) under the box, which
// Enter would take.
func MenuUnderBox(lines []string) bool {
	_, end, ok := boxAt(lines)
	if !ok {
		return false
	}
	for _, l := range lines[end:] {
		if menuRow.MatchString(l) {
			return true
		}
	}
	return false
}

// Box is the input box's mark and its text; HasText false when the text can't be rebuilt exactly (TS's undefined).
type Box struct {
	Mark    string
	Text    string
	HasText bool
}

// InputBox is claude-input.ts inputBox: the box's mark and its text, rebuilt exactly. The mark and the one space after
// it are padding. A wrapped row joins with no separator: after a row the terminal filled to width as it is, else only
// when it starts with the same padding, which is removed. Any other shape has no text. ok false with no box.
func InputBox(lines []string, width int) (Box, bool) {
	at, end, ok := boxAt(lines)
	if !ok {
		return Box{}, false
	}
	m := markLine.FindStringSubmatch(lines[at])
	if m == nil {
		return Box{}, false
	}
	lead, mark, first := m[1], m[2], m[3]
	pad := strings.Repeat(" ", utf8.RuneCountInString(lead)+2)
	if end > at+1 && unsure.MatchString(strings.Join(lines[at:end], "")) {
		return Box{Mark: mark}, true
	}
	text, prev := dropPad(first), lines[at]
	for _, l := range lines[at+1 : end] {
		switch {
		case width > 0 && DisplayWidth(prev) == width:
			text += l
		case strings.HasPrefix(l, pad) && (len(l) == len(pad) || l[len(pad)] != ' '):
			text += l[len(pad):]
		default:
			return Box{Mark: mark}, true
		}
		prev = l
	}
	return Box{Mark: mark, Text: text, HasText: true}, true
}

// Around is the screen around the box (claude-input.ts aroundBox): the lines above it, those below its footer, and
// the footer under its bottom rule.
type Around struct{ Above, Below, Footer []string }

// AroundBox is claude-input.ts aroundBox. Left out of Above and Below: the box, its rules, the footer, and the line
// just over the top rule when it is blank or a notice drawn right-aligned, which come and go by themselves.
func AroundBox(lines []string) Around {
	at, end, ok := boxAt(lines)
	if !ok {
		return Around{Above: lines}
	}
	top := at
	if at > 0 && isRule(lines[at-1]) {
		top = at - 1
	}
	if top < at && top > 0 && notice.MatchString(lines[top-1]) {
		top--
	}
	var footer []string
	if end < len(lines) && isRule(lines[end]) {
		for end++; end < len(lines) && jsjson.Trim(lines[end]) != ""; end++ {
			footer = append(footer, lines[end])
		}
	}
	below := append([]string(nil), lines[end:]...)
	for len(below) > 0 && jsjson.Trim(below[len(below)-1]) == "" {
		below = below[:len(below)-1]
	}
	return Around{Above: lines[:top], Below: below, Footer: footer}
}

func solid(l []string) []string {
	var out []string
	for _, x := range l {
		if jsjson.Trim(x) != "" {
			out = append(out, x)
		}
	}
	return out
}

func sameLines(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// SameAround is claude-input.ts sameAround: the screen around the box is as before, blank lines aside. The lines
// next to the box above it, as many as both screens have, must be the same, and the lines below all of them.
func SameAround(before, now Around) bool {
	b, a := solid(before.Above), solid(now.Above)
	n := min(len(b), len(a))
	return sameLines(b[len(b)-n:], a[len(a)-n:]) && sameLines(solid(before.Below), solid(now.Below))
}

func leadingSpaces(s string) int { return len(s) - len(strings.TrimLeft(s, " ")) }

func firstWord(s string) string {
	if i := strings.IndexByte(s, ' '); i >= 0 {
		return s[:i]
	}
	return s
}

// InputShows is claude-input.ts inputShows: the box shows exactly text, in the right mode (a leading ! is bash mode,
// shown as the box's mark). The rows must spell the text with one allowance where a row wraps onto the next, as
// Claude Code word-wraps: a run of spaces may be missing at the break when the word after it wouldn't have fitted;
// with no space there, the row must be full; after a row the terminal filled to width, the next goes on as is.
// Without width, a box of more than one row never matches.
func InputShows(lines []string, text string, width int) bool {
	at, end, ok := boxAt(lines)
	if !ok || text == "" {
		return false
	}
	bash := strings.HasPrefix(text, "!")
	want, wantMark := text, "❯"
	if bash {
		want, wantMark = text[1:], "!"
	}
	m := markLine.FindStringSubmatch(lines[at])
	if m == nil || m[2] != wantMark {
		return false
	}
	pad := strings.Repeat(" ", utf8.RuneCountInString(m[1])+2)
	seg0 := dropPad(m[3])
	if !strings.HasPrefix(want, seg0) {
		return false
	}
	pos, prev := len(seg0), lines[at]
	for _, l := range lines[at+1 : end] {
		if width == 0 || unsure.MatchString(text+strings.Join(lines[at:end], "")) {
			return false
		}
		// The row after a full one is the terminal's autowrap, as is, or Claude Code's own break inside a word too long
		// for a row, which starts with the padding: the one that spells the text wins.
		byPadding := func() (string, bool) {
			if !strings.HasPrefix(l, pad) || padded(l[len(pad):]) {
				return "", false
			}
			rest := l[len(pad):]
			if DisplayWidth(prev) >= width-2 && strings.HasPrefix(want[pos:], rest) {
				return rest, true
			}
			run := leadingSpaces(want[pos:])
			word := firstWord(want[pos+run:])
			if run > 0 && DisplayWidth(prev)+run+DisplayWidth(word) <= width-1 || run == 0 && DisplayWidth(prev) < width-1 {
				return "", false
			}
			pos += run
			return rest, true
		}
		start := pos
		seg, ok := "", false
		if DisplayWidth(prev) == width && l != "" && strings.HasPrefix(want[pos:], l) {
			seg, ok = l, true
		}
		if !ok {
			pos = start
			seg, ok = byPadding()
		}
		if !ok || seg == "" || !strings.HasPrefix(want[pos:], seg) {
			return false
		}
		pos += len(seg)
		prev = l
	}
	return pos == len(want)
}

// MaxInput is claude-input.ts MAX_INPUT, in characters.
const MaxInput = 2000

// InputProblem is claude-input.ts inputProblem: why text can't be a suggestion, "" when it can. It must be a string
// of one line with no control characters, at most 2000 characters, not ending in whitespace.
func InputProblem(v jsjson.Value) string {
	text, ok := v.(string)
	if !ok || jsjson.Trim(text) == "" {
		return "the text is empty"
	}
	if utf8.RuneCountInString(text) > MaxInput {
		return "the text is over 2000 characters"
	}
	if controls.MatchString(text) {
		return "the text must be one line with no control characters (no newline, carriage return, tab, or escape)"
	}
	if endsInWS.MatchString(text) {
		return "the text can't end in whitespace"
	}
	return ""
}

// BashInputRecorded is claude-input.ts bashInputRecorded: whether a bash-mode command shows in transcript rows
// appended after Enter, as a user message `<bash-input>TEXT AFTER THE !</bash-input>`. The first bash-input record is
// the one typed: "other" when it isn't the text, "none" while none shows yet.
func BashInputRecorded(appended, text string) string {
	want := bashPrefix + text[min(1, len(text)):] + "</bash-input>"
	for _, line := range strings.Split(appended, "\n") {
		v, err := jsjson.Parse([]byte(line))
		if err != nil {
			continue
		}
		row, _ := v.(*jsjson.Object)
		if t, _ := get(row, "type").(string); t != "user" || row == nil {
			continue
		}
		msg, _ := get(row, "message").(*jsjson.Object)
		var texts []jsjson.Value
		switch c := get(msg, "content").(type) {
		case string:
			texts = []jsjson.Value{c}
		case []jsjson.Value:
			for _, p := range c {
				o, _ := p.(*jsjson.Object)
				texts = append(texts, get(o, "text"))
			}
		}
		other := false
		for _, t := range texts {
			s, ok := t.(string)
			if ok && s == want {
				return "match"
			}
			if ok && strings.HasPrefix(s, bashPrefix) {
				other = true
			}
		}
		if other {
			return "other"
		}
	}
	return "none"
}

// Graphemes is `[...new Intl.Segmenter().segment(s)]` for what a suggestion holds: a character with the combining
// marks, joiners, variation selectors, skin tones and tags after it, a pictograph joined to the one before by a ZWJ,
// a pair of regional indicators (a flag), and a Hangul syllable spelled in conjoining jamo each make one cluster.
// Claude Code deletes a cluster per backspace; a miscount only leaves the box not as expected, which the typing then
// reads and fails closed on.
func Graphemes(s string) []string {
	var out []string
	var prev rune
	afterZWJ, flags := false, 0
	for _, r := range s {
		ri := r >= 0x1f1e6 && r <= 0x1f1ff
		join := len(out) > 0 && ((afterZWJ && isPictographic(r)) || unicode.In(r, unicode.M) || r == 0x200d || (r >= 0xfe00 && r <= 0xfe0f) ||
			(r >= 0x1f3fb && r <= 0x1f3ff) || (r >= 0xe0020 && r <= 0xe007f) || (ri && flags%2 == 1) || jamoJoins(prev, r))
		if join {
			out[len(out)-1] += string(r)
		} else {
			out = append(out, string(r))
		}
		afterZWJ = r == 0x200d
		if ri {
			flags++
		} else {
			flags = 0
		}
		prev = r
	}
	return out
}

// jamoJoins is Unicode's rules GB6 to GB8 for Hangul: a leading consonant joins a following one, a vowel or a syllable;
// a vowel or an LV syllable a vowel or a trailing consonant; a trailing consonant or an LVT syllable a trailing one.
func jamoJoins(a, b rune) bool {
	switch ka, kb := jamo(a), jamo(b); ka {
	case 'L':
		return kb == 'L' || kb == 'V' || kb == 'S' || kb == 'X'
	case 'V', 'S':
		return kb == 'V' || kb == 'T'
	case 'T', 'X':
		return kb == 'T'
	}
	return false
}

// jamo is r's Hangul syllable type: L, V or T, S for an LV syllable, X for an LVT one, and 0 for none.
func jamo(r rune) byte {
	switch {
	case (r >= 0x1100 && r <= 0x115f) || (r >= 0xa960 && r <= 0xa97c):
		return 'L'
	case (r >= 0x1160 && r <= 0x11a7) || (r >= 0xd7b0 && r <= 0xd7c6):
		return 'V'
	case (r >= 0x11a8 && r <= 0x11ff) || (r >= 0xd7cb && r <= 0xd7fb):
		return 'T'
	case r >= 0xac00 && r <= 0xd7a3:
		if (r-0xac00)%28 == 0 {
			return 'S'
		}
		return 'X'
	}
	return 0
}

// VimKeys is src/adapters/claude.ts vimKeys: whether Claude Code runs with vim keys (editorMode "vim" in the config
// dir's settings.json or ~/.claude.json). In normal mode it shows no mode at all, so the screen alone can't tell.
func VimKeys(configDir, userHome string) bool {
	if configDir == "" {
		configDir = filepath.Join(userHome, ".claude")
	}
	for _, f := range []string{filepath.Join(configDir, "settings.json"), filepath.Join(userHome, ".claude.json")} {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		v, err := jsjson.Parse(b)
		if err != nil {
			continue
		}
		o, _ := v.(*jsjson.Object)
		if m, _ := get(o, "editorMode").(string); m == "vim" {
			return true
		}
	}
	return false
}
