// Package search is the text and vector side of search by meaning (S-3735): src/search.ts's ranking and cleaning, the
// stub embedder of src/embed.ts, and the embedding index of src/vectors.ts (index.go).
//
// Strings are measured as JS measures them, in UTF-16 code units, where TS slices or finds an index: an excerpt and the
// embedded text are cut at the same place as the TS daemon cuts them.
package search

import (
	"hash/fnv"
	"math"
	"regexp"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// jsSpace is JS's \s: Go's \s lacks \v and the Unicode spaces.
const jsSpace = `\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// components is src/search.ts COMPONENT: the names a mail component carries on its fence line or the line after a bare fence.
var components = map[string]bool{}

func init() {
	for _, c := range strings.Fields("decision yesno pick rank table csv chart metrics checklist progress timeline diff tests error spend terminal ts mermaid embed pane details compare math") {
		components[c] = true
	}
}

var (
	reFenceOnly  = regexp.MustCompile(`(?i)^[` + jsSpace + "]*```[a-z-]*[" + jsSpace + `]*$`)
	reFenceStart = regexp.MustCompile(`(?i)^[` + jsSpace + "]*```[a-z-]*[" + jsSpace + `]+`)
	reCallout    = regexp.MustCompile(`(?i)\[![A-Z]+\]`)
	reTag        = regexp.MustCompile(`<[^>]*>`)
	reMath       = regexp.MustCompile(`\\[()[\]]`)
	reMarks      = regexp.MustCompile("[#>*`_[\\]]")
	reSpaces     = regexp.MustCompile(`[` + jsSpace + `]+`)
	reRankBefore = regexp.MustCompile(`^[` + jsSpace + `\-_/.([{]$`)
)

func isJSSpace(r rune) bool {
	return reSpaces.MatchString(string(r))
}

// Trim is JS String.prototype.trim.
func Trim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// PlainText is src/search.ts plainText: the prose of a text on one line, with the component fences and markup dropped.
func PlainText(text string) string {
	lines := strings.Split(text, "\n")
	kept := lines[:0:0]
	for _, l := range lines {
		l = reFenceOnly.ReplaceAllString(l, "")
		l = reFenceStart.ReplaceAllString(l, "")
		if components[strings.ToLower(Trim(l))] {
			continue
		}
		kept = append(kept, l)
	}
	out := strings.Join(kept, " ")
	out = reCallout.ReplaceAllString(out, " ")
	out = reTag.ReplaceAllString(out, " ")
	out = reMath.ReplaceAllString(out, " ")
	out = strings.ReplaceAll(out, "$$", " ")
	out = reMarks.ReplaceAllString(out, " ")
	out = reSpaces.ReplaceAllString(out, " ")
	return Trim(out)
}

// u16 is a string as UTF-16 code units, for JS's indexOf and slice.
type u16 []uint16

func units(s string) u16 { return utf16.Encode([]rune(s)) }

func (u u16) String() string { return string(utf16.Decode(u)) }

// slice is JS String.prototype.slice(start, end) with both in range.
func (u u16) slice(start, end int) string {
	start, end = max(0, min(start, len(u))), max(0, min(end, len(u)))
	if start >= end {
		return ""
	}
	return u[start:end].String()
}

// indexOf is JS String.prototype.indexOf: -1 when absent.
func (u u16) indexOf(sub u16) int {
	if len(sub) == 0 {
		return 0
	}
	for i := 0; i+len(sub) <= len(u); i++ {
		match := true
		for j := range sub {
			if u[i+j] != sub[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

// Slice is JS text.slice(0, n): the first n UTF-16 code units.
func Slice(text string, n int) string { return units(text).slice(0, n) }

// Rank is src/search.ts rank: an exact hit 5, a prefix 4, a match at a word start 3, inside a word 2, none 0.
func Rank(text, q string) int {
	t, s := strings.ToLower(text), strings.ToLower(q)
	if s == "" {
		return 0
	}
	i := strings.Index(t, s)
	if i < 0 {
		return 0
	}
	if t == s {
		return 5
	}
	if i == 0 {
		return 4
	}
	r, _ := utf8.DecodeLastRuneInString(t[:i])
	if reRankBefore.MatchString(string(r)) {
		return 3
	}
	return 2
}

// Excerpt is src/search.ts excerpt: a one-line excerpt of prose around the match, n code units long (90 by default).
func Excerpt(text, q string) string {
	const n = 90
	flat := PlainText(text)
	u := units(flat)
	i := units(strings.ToLower(flat)).indexOf(units(strings.ToLower(q)))
	if i < 0 {
		if len(u) > n {
			return u.slice(0, n) + "…"
		}
		return flat
	}
	start := max(0, i-24)
	out := u.slice(start, start+n)
	if start > 0 {
		out = "…" + out
	}
	if start+n < len(u) {
		out += "…"
	}
	return out
}

// Chars is src/embed.ts CHARS: only the first characters of a text are embedded.
const Chars = 2000

// EmbedText is src/embed.ts embedText: the subject and body as prose, capped.
func EmbedText(subject, body string) string {
	return Slice(PlainText(subject+"\n"+body), Chars)
}

// The stub embedder (src/embed.ts stubVector): a deterministic hashed bag of stems, with no model.
const (
	StubModel = "stub-256"
	StubDim   = 256
	// LocalModel is the local provider's model, which only the TS daemon can run (src/embed.ts LOCAL_MODEL).
	LocalModel = "Xenova/all-MiniLM-L6-v2"
	LocalDim   = 384
)

var (
	stop    = map[string]bool{}
	reWords = regexp.MustCompile(`[^a-z0-9]+`)
)

func init() {
	for _, w := range strings.Fields("a an and are as at be been but by can did do does for from had has have he her his i if in into is it its me my no not of on or our she so that the their them then there these they this to too us was we were what when which who why will with would you your") {
		stop[w] = true
	}
}

// stem is src/embed.ts stem: plurals and -ing / -ed forms share one.
func stem(w string) string {
	switch {
	case len(w) > 5 && strings.HasSuffix(w, "ing"):
		return w[:len(w)-3]
	case len(w) > 4 && strings.HasSuffix(w, "ed"):
		return w[:len(w)-2]
	case len(w) > 3 && strings.HasSuffix(w, "s") && !strings.HasSuffix(w, "ss"):
		return w[:len(w)-1]
	}
	return w
}

// StubVector is src/embed.ts stubVector. Its words are ASCII, so FNV-1a over bytes is the TS hash over char codes.
func StubVector(text string) []float32 {
	v := make([]float32, StubDim)
	for _, w := range reWords.Split(strings.ToLower(text), -1) {
		if w == "" || stop[w] {
			continue
		}
		h := fnv.New32a()
		h.Write([]byte(stem(w)))
		v[h.Sum32()%StubDim]++
	}
	return Normalise(v)
}

// Normalise is src/embed.ts normalise: v scaled to length 1, in place (a zero vector stays zero).
func Normalise(v []float32) []float32 {
	n := 0.0
	for _, x := range v {
		n += float64(x) * float64(x)
	}
	n = math.Sqrt(n)
	if n > 0 {
		for i := range v {
			v[i] = float32(float64(v[i]) / n)
		}
	}
	return v
}
