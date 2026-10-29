package tiny

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"stam/internal/jsjson"
)

// The answer parsers of src/mail-title.ts: cleanTitle, parseBoth, cleanSummary and cutText. TS's patterns are /i over
// ASCII words, which match only ASCII letters, so the words here are spelled as [tT][iI]... classes (RE2's (?i) folds ſ
// to s and K to k). parseBoth's lookaheads have no RE2 form, so it walks the text as the backtracking match does.

const (
	titleWords   = 3
	titleChars   = 40
	summaryChars = 400
	summaryLines = 5
)

// ci is an ASCII word as a case-blind pattern, as JavaScript's /i reads it.
func ci(word string) string {
	var b strings.Builder
	for _, r := range word {
		if r >= 'a' && r <= 'z' {
			b.WriteString("[" + string(r) + string(r-'a'+'A') + "]")
		} else {
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	return b.String()
}

// lowerASCII lowers only ASCII letters, so a lowercase ASCII pattern matches as JavaScript's /i does.
func lowerASCII(s string) string {
	return strings.Map(func(r rune) rune {
		if r >= 'A' && r <= 'Z' {
			return r + 'a' - 'A'
		}
		return r
	}, s)
}

var (
	titleMarks   = regexp.MustCompile("[*_`#\"“”‘’]")
	titleLabel   = regexp.MustCompile(`^` + jsSpace + `*` + ci("title") + jsSpace + `*:` + jsSpace + `*`)
	titleEdges   = regexp.MustCompile(`^['` + jsSpaceSet + `]+|['` + jsSpaceSet + `]+$`)
	endPunct     = regexp.MustCompile(`[.,;:!?]+$`)
	bullet       = regexp.MustCompile(`^` + jsSpace + `*[•*+]` + jsSpace + `+`)
	summaryMarks = regexp.MustCompile("[*`\"“”‘’]")
	heading      = regexp.MustCompile(`^` + jsSpace + `*#+` + jsSpace + `+`)
	summaryLabel = regexp.MustCompile(`^` + jsSpace + `*` + ci("summary") + jsSpace + `*:` + jsSpace + `*`)
	blanks       = regexp.MustCompile(`[ \t]+`)
	// chatter is CHATTER, matched against lowerASCII of the line.
	chatter = regexp.MustCompile(`^(let me know if (you|there)|hope (this|that) helps|feel free to|i can also|happy to help)`)
	// titleLabelAt is a "Title:" label after the line's marks, or a "Line 1:", "1." or "1)" prefix.
	titleLabelAt = "(?:(?:" + ci("line") + "[ \\t]*)?[0-9]+[ \\t]*[:.)][ \\t]*)?[*_`\\t ]*" + ci("title") + "[*_`]*[ \\t]*:"
	titleLine    = regexp.MustCompile("^[*_`#>\\-\\t ]*" + titleLabelAt)
	// nextTitle is where a summary that a later "Title:" line follows ends (its marks take no "-").
	nextTitle = regexp.MustCompile("\\n[*_`#>\\t ]*" + titleLabelAt)
)

// CleanTitle is cleanTitle: the model's answer as a title, its first line without a "Title:" label, quotes, Markdown
// marks or end punctuation, cut to three words and 40 characters. "" when nothing is left.
func CleanTitle(raw string) string {
	line := ""
	for _, l := range strings.Split(raw, "\n") {
		if l = jsjson.Trim(l); l != "" {
			line = l
			break
		}
	}
	line = titleMarks.ReplaceAllString(line, "")
	line = titleLabel.ReplaceAllString(line, "")
	line = titleEdges.ReplaceAllString(line, "")
	var ws []string
	for _, w := range spaces.Split(line, -1) {
		if w != "" && len(ws) < titleWords {
			ws = append(ws, w)
		}
	}
	return jsjson.Trim(jsSlice(endPunct.ReplaceAllString(strings.Join(ws, " "), ""), titleChars))
}

// CleanMailSummary is src/mail-title.ts cleanSummary: a condensed copy of the mail, up to five lines, without a "Summary:" label, quotes or
// Markdown marks other than "- " bullets, without a trailing sign-off line, cut to 400 characters. "" when nothing is
// left.
func CleanMailSummary(raw string) string {
	var lines []string
	for _, l := range strings.Split(raw, "\n") {
		l = bullet.ReplaceAllString(l, "- ")
		l = summaryMarks.ReplaceAllString(l, "")
		l = heading.ReplaceAllString(l, "")
		l = summaryLabel.ReplaceAllString(l, "")
		if l = jsjson.Trim(blanks.ReplaceAllString(l, " ")); l != "" {
			lines = append(lines, l)
		}
	}
	for len(lines) > 0 && chatter.MatchString(lowerASCII(lines[len(lines)-1])) {
		lines = lines[:len(lines)-1]
	}
	return CutText(strings.Join(lines[:min(len(lines), summaryLines)], "\n"), summaryChars)
}

// CutText is cutText: text cut to max code points, at a word boundary when one is near, with an ellipsis; text that
// fits comes back as it is.
func CutText(text string, max int) string {
	chars := []rune(text)
	if len(chars) <= max {
		return text
	}
	head := chars[:max-1]
	at := -1
	for i, r := range head {
		if jsjson.IsSpace(r) {
			at = i
		}
	}
	if 2*at > max {
		head = head[:at]
	}
	return jsjson.TrimEnd(string(head)) + "…"
}

// ParseBoth is parseBoth: the answer to a title-and-summary prompt, the title from its "Title:" line and the summary
// from the "Summary:" text, in either order and layout. An answer with neither label is read as a bare title.
func ParseBoth(raw string) (title, summary string) {
	t, hasT := titleField(raw)
	s, hasS := summaryField(raw)
	if !hasT && !hasS {
		return CleanTitle(raw), ""
	}
	if hasT {
		title = CleanTitle(t)
	}
	if hasS {
		if loc := nextTitle.FindStringIndex(s); loc != nil {
			s = s[:loc[0]]
		}
		summary = CleanMailSummary(s)
	}
	return title, summary
}

// lineEnd is a JavaScript line terminator, where /m's ^ and $ match and . stops.
func lineEnd(r rune) bool { return r == '\n' || r == '\r' || r == 0x2028 || r == 0x2029 }

// titleField is the title regex's group: on the first line with a "Title:" label, the text after it up to a "Summary:"
// label with text after it, or the end of the line.
func titleField(raw string) (string, bool) {
	for start := 0; start <= len(raw); {
		end := len(raw)
		next := len(raw) + 1
		for i, r := range raw[start:] {
			if lineEnd(r) {
				end, next = start+i, start+i+utf8.RuneLen(r)
				break
			}
		}
		if loc := titleLine.FindStringIndex(raw[start:end]); loc != nil {
			from := start + loc[1]
			for p := from; p <= end; {
				if p == end || summaryAhead(raw, p) {
					return raw[from:p], true
				}
				_, w := utf8.DecodeRuneInString(raw[p:])
				p += w
			}
		}
		start = next
	}
	return "", false
}

// wordByte is a character of JavaScript's \w, for \b.
func wordByte(b byte) bool {
	return b == '_' || b >= '0' && b <= '9' || b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}

// summaryAt is where a `\bsummary[*_`]*[ \t]*:` label at i ends, else -1.
func summaryAt(raw string, i int) int {
	if i > 0 && wordByte(raw[i-1]) || len(raw) < i+7 || lowerASCII(raw[i:i+7]) != "summary" {
		return -1
	}
	p := i + 7
	for p < len(raw) && strings.IndexByte("*_`", raw[p]) >= 0 {
		p++
	}
	for p < len(raw) && (raw[p] == ' ' || raw[p] == '\t') {
		p++
	}
	if p == len(raw) || raw[p] != ':' {
		return -1
	}
	return p + 1
}

// nonSpaceAt is whether the character at i is \S.
func nonSpaceAt(raw string, i int) bool {
	if i >= len(raw) {
		return false
	}
	r, _ := utf8.DecodeRuneInString(raw[i:])
	return !jsjson.IsSpace(r)
}

// run is the end of the run of chars from set at i.
func run(raw string, i int, set string) int {
	for i < len(raw) && strings.IndexByte(set, raw[i]) >= 0 {
		i++
	}
	return i
}

// summaryAhead is the title regex's lookahead at p: `[*_`]*\bsummary[*_`]*[ \t]*:[*_`\t ]*\S`.
func summaryAhead(raw string, p int) bool {
	a := summaryAt(raw, run(raw, p, "*_`"))
	if a < 0 {
		return false
	}
	// [*_`\t ]*\S: a mark in the run is \S itself, so the run may stop before it.
	for i := a; i < len(raw); i++ {
		switch raw[i] {
		case '*', '_', '`':
			return true
		case ' ', '\t':
			continue
		}
		return nonSpaceAt(raw, i)
	}
	return false
}

// titleAhead is `\s*[*_`]*title` at i.
func titleAhead(raw string, i int) bool {
	for i < len(raw) {
		r, w := utf8.DecodeRuneInString(raw[i:])
		if !jsjson.IsSpace(r) {
			break
		}
		i += w
	}
	i = run(raw, i, "*_`")
	return len(raw) >= i+5 && lowerASCII(raw[i:i+5]) == "title"
}

// summaryField is the summary regex's group, `\bsummary[*_`]*[ \t]*:[*_`\t ]*\n?(?!\s*[*_`]*title)[*_`\t ]*(\S[\s\S]*)$`:
// at the first label that has text after it, the rest of the answer from that text on. It tries the choices in the order
// the backtracking match does.
func summaryField(raw string) (string, bool) {
	for q := 0; q < len(raw); q++ {
		a := summaryAt(raw, q)
		if a < 0 {
			continue
		}
		for b := run(raw, a, "*_`\t "); b >= a; b-- {
			for _, nl := range []bool{true, false} {
				c := b
				if nl {
					if b >= len(raw) || raw[b] != '\n' {
						continue
					}
					c = b + 1
				}
				if titleAhead(raw, c) {
					continue
				}
				for d := run(raw, c, "*_`\t "); d >= c; d-- {
					if nonSpaceAt(raw, d) {
						return raw[d:], true
					}
				}
			}
		}
	}
	return "", false
}
