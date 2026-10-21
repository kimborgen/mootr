package claude

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"stam/internal/jsjson"
)

// What Claude Code's input box holds while stam types a first prompt (S-2123), read from the pane captured with its
// styles (tmux capture-pane -e): a port of src/adapters/claude-ghost.ts and the box finding of
// src/adapters/claude-input.ts. Faint is SGR 2 (dim) or bright black (90); the cursor may sit, drawn inverse, on the
// first character. Pure, so it tests without a pane.

var (
	sgrRe   = regexp.MustCompile(`^\x1b\[([0-9;:]*)m`)
	otherRe = regexp.MustCompile(`^\x1b(\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|.)`)
	pasted  = regexp.MustCompile(`^\[Pastedtext#\d+(\+\d+lines?)?\]$`)
)

type cell struct {
	ch            string
	faint, invert bool
}

// cells is one captured row: each character with whether it was drawn faint or inverse.
func cells(row string) []cell {
	var out []cell
	dim, grey, inverse := false, false, false
	for i := 0; i < len(row); {
		if m := sgrRe.FindStringSubmatch(row[i:]); m != nil {
			p := []string{"0"}
			if m[1] != "" {
				p = strings.Split(m[1], ";")
			}
			for k := 0; k < len(p); k++ {
				// A colon form (38:5:n) is one parameter, so it never reads as separate codes.
				if strings.Contains(p[k], ":") {
					if strings.HasPrefix(p[k], "38") {
						grey = false
					}
					continue
				}
				n, _ := strconv.Atoi(p[k])
				skip := func() {
					if k+1 < len(p) && p[k+1] == "5" {
						k += 2
					} else if k+1 < len(p) && p[k+1] == "2" {
						k += 4
					}
				}
				switch {
				case n == 0:
					dim, grey, inverse = false, false, false
				case n == 2:
					dim = true
				case n == 22:
					dim = false
				case n == 7:
					inverse = true
				case n == 27:
					inverse = false
				case n == 90:
					grey = true
				case (n >= 30 && n <= 37) || n == 39 || (n >= 91 && n <= 97):
					grey = false
				case n == 38:
					grey = false
					skip()
				case n == 48 || n == 58:
					skip()
				}
			}
			i += len(m[0])
			continue
		}
		if row[i] == '\x1b' {
			if m := otherRe.FindString(row[i:]); m != "" {
				i += len(m)
			} else {
				i++
			}
			continue
		}
		_, size := utf8.DecodeRuneInString(row[i:])
		out = append(out, cell{ch: row[i : i+size], faint: dim || grey, invert: inverse})
		i += size
	}
	return out
}

func plain(row string) string {
	var b strings.Builder
	for _, c := range cells(row) {
		b.WriteString(c.ch)
	}
	return b.String()
}

func visible(c cell) bool { return jsjson.Trim(c.ch) != "" && c.ch != " " }

// isRule is claude-input.ts RULE: a row that starts with a run of at least three box-drawing dashes.
func isRule(l string) bool {
	rest := strings.TrimLeftFunc(l, jsjson.IsSpace)
	n := 0
	for _, r := range rest {
		if r != '─' && r != '━' {
			break
		}
		n++
	}
	return n >= 3
}

// isMark is a row starting with the box's prompt mark: ❯, or ! in bash mode.
func isMark(l string) bool {
	rest := strings.TrimLeftFunc(l, jsjson.IsSpace)
	return strings.HasPrefix(rest, "❯") || strings.HasPrefix(rest, "!")
}

// boxAt is claude-input.ts boxAt: the last line starting with the prompt mark, and the lines it wrapped onto, up to the
// rule under it or a blank line. A mark line with a rule above and under it wins, since a completion menu's highlighted
// row also starts with ❯ and may draw under the bottom rule. ok false with no box.
func boxAt(lines []string) (at, end int, ok bool) {
	endOf := func(at int) int {
		end := at + 1
		for end < len(lines) && !isRule(lines[end]) && jsjson.Trim(lines[end]) != "" {
			end++
		}
		return end
	}
	at = -1
	for i := len(lines) - 1; i >= 0; i-- {
		if isMark(lines[i]) && i > 0 && isRule(lines[i-1]) {
			if e := endOf(i); e < len(lines) && isRule(lines[e]) {
				at = i
				break
			}
		}
	}
	if at < 0 {
		for i := len(lines) - 1; i >= 0; i-- {
			if isMark(lines[i]) {
				at = i
				break
			}
		}
	}
	if at < 0 {
		return 0, 0, false
	}
	return at, endOf(at), true
}

// promptBoxRows is claude-input.ts promptBoxRows: with a rule over the mark line and one under it, everything between
// the two, blank rows too; otherwise as boxAt.
func promptBoxRows(lines []string) (at, end int, ok bool) {
	at, end, ok = boxAt(lines)
	if !ok {
		return
	}
	if at > 0 && isRule(lines[at-1]) {
		for i := at + 1; i < len(lines); i++ {
			if isRule(lines[i]) {
				return at, i, true
			}
		}
	}
	return
}

// boxCells is the box's text cells, every row of it: the first row after its mark, the rows it wraps onto as they are.
// ok false with no box.
func boxCells(ansi []string) ([][]cell, bool) {
	plainRows := make([]string, len(ansi))
	for i, r := range ansi {
		plainRows[i] = plain(r)
	}
	at, end, ok := promptBoxRows(plainRows)
	if !ok {
		return nil, false
	}
	out := make([][]cell, 0, end-at)
	for i, r := range ansi[at:end] {
		c := cells(r)
		if i == 0 {
			from := 0
			for j, x := range c {
				if x.ch == "❯" || x.ch == "!" {
					from = j + 1
					break
				}
			}
			c = c[from:]
		}
		out = append(out, c)
	}
	return out, true
}

func shownCells(box [][]cell) []cell {
	var out []cell
	for _, row := range box {
		for _, c := range row {
			if visible(c) {
				out = append(out, c)
			}
		}
	}
	return out
}

// InputGhost is claude-ghost.ts inputGhost: the box holds text and every visible character of it is faint, but for an
// inverse cursor on the first one.
func InputGhost(ansi []string) bool {
	box, ok := boxCells(ansi)
	if !ok {
		return false
	}
	text := shownCells(box)
	if len(text) == 0 {
		return false
	}
	some := false
	for i, c := range text {
		if !c.faint && !(i == 0 && c.invert) {
			return false
		}
		some = some || c.faint
	}
	return some
}

// Box states PromptInBox returns; "" is no box.
const (
	BoxEmpty = "empty"
	BoxOne   = "one"
	BoxOther = "other"
)

func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// PromptInBox is claude-ghost.ts promptInBox: what the box holds for a prompt being typed. Empty (nothing, or only
// faint text), one (exactly one copy of text, whitespace aside, or one `[Pasted text #N]` token, or the tail of a box
// too tall for the pane), other (anything else), or "" with no box.
func PromptInBox(ansi []string, text string) string {
	box, ok := boxCells(ansi)
	if !ok {
		return ""
	}
	shown := shownCells(box)
	if len(shown) == 0 || InputGhost(ansi) {
		return BoxEmpty
	}
	solid := -1
	for i := len(shown) - 1; i >= 0; i-- {
		if !shown[i].faint {
			solid = i
			break
		}
	}
	var got strings.Builder
	for _, c := range shown[:solid+1] {
		if c.faint {
			return BoxOther
		}
		got.WriteString(c.ch)
	}
	g := got.String()
	want := strings.Map(func(r rune) rune {
		if jsjson.IsSpace(r) {
			return -1
		}
		return r
	}, text)
	if g == want || pasted.MatchString(g) {
		return BoxOne
	}
	rows := 0
	for _, r := range box {
		for _, c := range r {
			if visible(c) {
				rows++
				break
			}
		}
	}
	if rows >= 3 && utf16Len(g) < utf16Len(want) && strings.HasSuffix(want, g) {
		return BoxOne
	}
	return BoxOther
}
