package claude

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// What src/adapters/claude.ts typeLiteralInput reads off the screen around the input box (S-2848 B3b): whether a turn
// runs, the vim mode, and the cursor's column. Pure functions over captured lines; the lifecycle does the typing.

// workingLine is Claude Code's working line before its timer shows, such as "✽ Marinating…".
var workingLine = regexp.MustCompile(`^` + jsSpace + `*[·✢✳✶✻✽*]` + jsSpace + `+[^` + jsSpaceChars + `].*…`)

// TurnRunning is typeLiteralInput's running: a dialog, or Claude Code's working line (which has no timer yet when the
// turn has just started, before its hook reaches stam). Typing then races the turn's output, and an Esc would
// interrupt it.
func TurnRunning(lines []string) bool {
	for _, l := range lines {
		if dialogUp.MatchString(l) || workingLine.MatchString(l) {
			return true
		}
	}
	return spinner.MatchString(strings.Join(lines, "\n"))
}

// ShowsDialog is whether any line is a dialog's "Enter to confirm" or "Esc to cancel".
func ShowsDialog(lines []string) bool {
	for _, l := range lines {
		if dialogUp.MatchString(l) {
			return true
		}
	}
	return false
}

// InsertMode is whether the footer under the box shows vim's -- INSERT --.
func InsertMode(lines []string) bool { return footerHas(lines, "-- INSERT --") }

// NormalMode is whether the footer under the box shows vim's -- NORMAL --; Claude Code shows nothing in normal mode,
// so false says little (VimKeys reads the config).
func NormalMode(lines []string) bool { return footerHas(lines, "-- NORMAL --") }

func footerHas(lines []string, s string) bool {
	for _, l := range AroundBox(lines).Footer {
		if strings.Contains(l, s) {
			return true
		}
	}
	return false
}

// EmptyBox is whether the screen shows the box with the ❯ mark and nothing in it.
func EmptyBox(lines []string, width int) bool {
	b, ok := InputBox(lines, width)
	return ok && b.Mark == "❯" && b.HasText && b.Text == ""
}

// BoxRows is claude-input.ts boxRows: the box's rows, [at, end).
func BoxRows(lines []string) (at, end int, ok bool) { return boxAt(lines) }

// pictographic is Unicode's Extended_Pictographic, as node's /\p{Extended_Pictographic}/u reads it (Go's unicode has
// no such table): "lo-hi" or "cp" in hex.
var pictographic = parseRanges(
	"a9 ae 203c 2049 2122 2139 2194-2199 21a9-21aa 231a-231b 2328 23cf 23e9-23f3 23f8-23fa 24c2 25aa-25ab " +
		"25b6 25c0 25fb-25fe 2600-2604 260e 2611 2614-2615 2618 261d 2620 2622-2623 2626 262a 262e-262f " +
		"2638-263a 2640 2642 2648-2653 265f-2660 2663 2665-2666 2668 267b 267e-267f 2692-2697 2699 269b-269c " +
		"26a0-26a1 26a7 26aa-26ab 26b0-26b1 26bd-26be 26c4-26c5 26c8 26ce-26cf 26d1 26d3-26d4 26e9-26ea " +
		"26f0-26f5 26f7-26fa 26fd 2702 2705 2708-270d 270f 2712 2714 2716 271d 2721 2728 2733-2734 2744 2747 " +
		"274c 274e 2753-2755 2757 2763-2764 2795-2797 27a1 27b0 27bf 2934-2935 2b05-2b07 2b1b-2b1c 2b50 2b55 " +
		"3030 303d 3297 3299 1f004 1f02c-1f02f 1f094-1f09f 1f0af-1f0b0 1f0c0 1f0cf-1f0d0 1f0f6-1f0ff " +
		"1f170-1f171 1f17e-1f17f 1f18e 1f191-1f19a 1f1ae-1f1e5 1f201-1f20f 1f21a 1f22f 1f232-1f23a " +
		"1f23c-1f23f 1f249-1f25f 1f266-1f321 1f324-1f393 1f396-1f397 1f399-1f39b 1f39e-1f3f0 1f3f3-1f3f5 " +
		"1f3f7-1f3fa 1f400-1f4fd 1f4ff-1f53d 1f549-1f54e 1f550-1f567 1f56f-1f570 1f573-1f57a 1f587 " +
		"1f58a-1f58d 1f590 1f595-1f596 1f5a4-1f5a5 1f5a8 1f5b1-1f5b2 1f5bc 1f5c2-1f5c4 1f5d1-1f5d3 " +
		"1f5dc-1f5de 1f5e1 1f5e3 1f5e8 1f5ef 1f5f3 1f5fa-1f64f 1f680-1f6c5 1f6cb-1f6d2 1f6d5-1f6e5 1f6e9 " +
		"1f6eb-1f6f0 1f6f3-1f6ff 1f7da-1f7ff 1f80c-1f80f 1f848-1f84f 1f85a-1f85f 1f888-1f88f 1f8ae-1f8af " +
		"1f8bc-1f8bf 1f8c2-1f8cf 1f8d9-1f8ff 1f90c-1f93a 1f93c-1f945 1f947-1f9ff 1fa58-1fa5f 1fa6e-1faff " +
		"1fc00-1fffd ")

type runeRange struct{ lo, hi rune }

func parseRanges(s string) []runeRange {
	var out []runeRange
	for _, f := range strings.Fields(s) {
		lo, hi, _ := strings.Cut(f, "-")
		if hi == "" {
			hi = lo
		}
		a, _ := strconv.ParseInt(lo, 16, 32)
		b, _ := strconv.ParseInt(hi, 16, 32)
		out = append(out, runeRange{rune(a), rune(b)})
	}
	return out
}

func isPictographic(c rune) bool {
	for _, r := range pictographic {
		if c < r.lo {
			return false
		}
		if c <= r.hi {
			return true
		}
	}
	return false
}

// Columns is claude.ts columns: the terminal columns of a line, enough for the cursor check before stam clears its own
// leftover. Wide and emoji characters take two, combining marks, joiners, variation selectors and skin tones none. A
// wrong guess only makes the clear refuse.
func Columns(s string) int {
	w := 0
	for _, c := range s {
		if unicode.In(c, unicode.M) || c == 0x200d || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x1f3fb && c <= 0x1f3ff) {
			continue
		}
		if isPictographic(c) || (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
			(c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) {
			w += 2
		} else {
			w++
		}
	}
	return w
}
