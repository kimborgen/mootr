package mcp

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf16"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// The screen a feedback report carries (src/feedback-screen.ts, S-2679). A report whose details name a
// first-prompt:screen or input:screen event gets the latest such event's screen of each agent the details name, read
// through the agent's events route with the reporter's own token, so the daemon's rule decides which screens are
// readable. Never fails: a report files without the screen, with a line saying why.
//
// TS's patterns use lookbehind, lookahead and JS's Unicode \s, which Go's regexp lacks; those steps are written out by
// hand here, and screen_test.go runs the TS module over the same lines to compare.

var screenTypes = []string{"first-prompt:screen", "input:screen"}

const (
	screenMaxLines  = 40
	screenMaxChars  = 3000
	screenMaxAgents = 3
	redacted        = "[redacted]"
)

// jsSpace is JS's \s (and what String.prototype.trim drops): WhiteSpace and LineTerminator.
const jsSpace = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

var (
	reANSI       = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]`)
	reTokenShape = regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b`)
	reURLCred    = regexp.MustCompile(`://([^` + jsSpace + `:/@]*):[^` + jsSpace + `@/]+@`)
	// JS's `.` stops at a line terminator, and `$` without the m flag is the end of the text.
	reBearer   = regexp.MustCompile(`(?i)\bBearer\b[^\n\r\x{2028}\x{2029}]*$`)
	reLongRun  = regexp.MustCompile(`[A-Za-z0-9_-]{24,}`)
	reCredWord = regexp.MustCompile(`(?i)token|secret|passw(or)?d|passphrase|api[_-]?key|authorization|credential`)
	reCredSeg  = regexp.MustCompile(`(?i)^(token|secret|passw(or)?d|pass|apikey|key|auth(orization)?|cred(ential)?s?)$`)
	reTokens   = regexp.MustCompile(`(?i)(^|_)tokens$`)
	reTrailWS  = regexp.MustCompile(`[` + jsSpace + `]+$`)
	reLead     = regexp.MustCompile(`^[` + jsSpace + `│┃|>❯›]*`)
	reTail     = regexp.MustCompile(`[` + jsSpace + `│┃|]+$`)
	reRunStart = regexp.MustCompile(`^[A-Za-z0-9_\-/+=]+`)
	reRunEnd   = regexp.MustCompile(`[A-Za-z0-9_\-/+=]$`)
	reFence    = regexp.MustCompile("`{3,}")
	reNotWord  = regexp.MustCompile(`[^A-Za-z0-9_-]+`)
)

func isNameByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-'
}

// isJSSpace is whether the rune is JS's \s.
func isJSSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, isJSSpace) }

// gluedPass is /(?<!by|com|sur|over|under|tres)pass$/i: a name glued to `pass`, except the prose words that end in it.
func gluedPass(name string) bool {
	l := strings.ToLower(name)
	if !strings.HasSuffix(l, "pass") {
		return false
	}
	before := l[:len(l)-4]
	for _, w := range []string{"by", "com", "sur", "over", "under", "tres"} {
		if strings.HasSuffix(before, w) {
			return false
		}
	}
	return true
}

func isCredentialName(name string) bool {
	if reCredWord.MatchString(name) || gluedPass(name) {
		return true
	}
	// TS's split keeps the empty segments FieldsFunc drops; an empty one never matches.
	for _, seg := range strings.FieldsFunc(name, func(r rune) bool { return r == '_' || r == '-' }) {
		if reCredSeg.MatchString(seg) {
			return true
		}
	}
	return false
}

// countValue is /^\d+(?:[.,]\d+)*[kmb]?(?=$|[\s,;"'}\])])/i: a number like 12k or 1.2k, ending at the end, a space or
// a closing mark. Any of the number's ends may be the one the lookahead accepts.
func countValue(v string) bool {
	digits := func(i int) int {
		for i < len(v) && v[i] >= '0' && v[i] <= '9' {
			i++
		}
		return i
	}
	term := func(i int) bool {
		if i >= len(v) {
			return true
		}
		if strings.ContainsRune(`,;"'}])`, rune(v[i])) {
			return true
		}
		r := []rune(v[i:])[0]
		return isJSSpace(r)
	}
	e := digits(0)
	if e == 0 {
		return false
	}
	ends := []int{e}
	for e < len(v) && (v[e] == '.' || v[e] == ',') {
		n := digits(e + 1)
		if n == e+1 {
			break
		}
		e = n
		ends = append(ends, e)
	}
	for _, e := range ends {
		if term(e) {
			return true
		}
		if e < len(v) && strings.ContainsRune("kmbKMB", rune(v[e])) && term(e+1) {
			return true
		}
	}
	return false
}

// redactNamed is src/feedback-screen.ts redactNamed: the first credential named on a line (`NAME=`, `NAME:`,
// `"NAME": `) and everything after it, redacted. A `tokens` name whose whole value is a count is skipped.
func redactNamed(line string) string {
	skipWS := func(i int) int {
		for i < len(line) {
			r := []rune(line[i:])[0]
			if !isJSSpace(r) {
				break
			}
			i += len(string(r))
		}
		return i
	}
	from := 0
	for p := 0; p < len(line); p++ {
		// (?<![A-Za-z0-9_-])([A-Za-z0-9_-]+): a name is a whole run, found at or after the last match's end.
		if p < from || !isNameByte(line[p]) || (p > 0 && isNameByte(line[p-1])) {
			continue
		}
		q := p
		for q < len(line) && isNameByte(line[q]) {
			q++
		}
		i := q
		if i < len(line) && line[i] == '"' {
			i++
		}
		i = skipWS(i)
		if i >= len(line) || (line[i] != ':' && line[i] != '=') {
			continue
		}
		i = skipWS(i + 1)
		if i < len(line) && line[i] == '"' {
			i++
		}
		name := line[p:q]
		if isCredentialName(name) && !(reTokens.MatchString(name) && countValue(line[i:])) {
			return line[:i] + redacted
		}
		from = i
	}
	return line
}

// redactFlagged is /(--?(?:[A-Za-z0-9_-]*(?:token|secret|password|key))\s+)(?!-)\S+/gi: a flag named like a credential
// and its value, `--token VALUE`.
func redactFlagged(line string) string {
	var b strings.Builder
	last := 0
	for p := 0; p < len(line); p++ {
		if p < last || line[p] != '-' {
			continue
		}
		q := p
		for q < len(line) && isNameByte(line[q]) {
			q++
		}
		run := strings.ToLower(line[p:q])
		ok := false
		for _, kw := range []string{"token", "secret", "password", "key"} {
			if strings.HasSuffix(run, kw) && len(run) >= 1+len(kw) {
				ok = true
			}
		}
		if !ok {
			continue
		}
		r := q
		for r < len(line) {
			c := []rune(line[r:])[0]
			if !isJSSpace(c) {
				break
			}
			r += len(string(c))
		}
		if r == q || r >= len(line) || line[r] == '-' {
			continue
		}
		s := r
		for s < len(line) {
			c := []rune(line[s:])[0]
			if isJSSpace(c) {
				break
			}
			s += len(string(c))
		}
		b.WriteString(line[last:r])
		b.WriteString(redacted)
		last = s
		p = s - 1
	}
	b.WriteString(line[last:])
	return b.String()
}

// redactScreen is src/feedback-screen.ts redactScreen: a capture line with its credentials taken out. It fails closed:
// any run of 24 or more token characters is redacted, which covers a stam agent token.
func redactScreen(line string) string {
	line = reTokenShape.ReplaceAllString(line, redacted)
	line = reURLCred.ReplaceAllString(line, "://${1}:"+redacted+"@")
	line = reBearer.ReplaceAllString(line, "Bearer "+redacted)
	line = redactFlagged(redactNamed(line))
	return reLongRun.ReplaceAllString(line, redacted)
}

// utf16Len and utf16Tail measure and cut as JS strings do, in UTF-16 code units.
func utf16Len(s string) int { return len(utf16.Encode([]rune(s))) }

func utf16Tail(s string, n int) string {
	u := utf16.Encode([]rune(s))
	return string(utf16.Decode(u[len(u)-n:]))
}

// boundedScreen is src/feedback-screen.ts boundedScreen: the lines cleaned and redacted, a redaction that reaches a
// line's end carried onto the next line's leading run, trailing blank lines dropped, and the last screenMaxLines lines
// and screenMaxChars characters kept.
func boundedScreen(lines []string) (string, bool) {
	clean := make([]string, 0, len(lines))
	carry := false
	for _, raw := range lines {
		plain := reTrailWS.ReplaceAllString(reANSI.ReplaceAllString(raw, ""), "")
		line := redactScreen(plain)
		if carry {
			lead := reLead.FindString(line)
			if run := reRunStart.FindString(line[len(lead):]); run != "" {
				line = lead + redacted + line[len(lead)+len(run):]
			}
		}
		carry = reRunEnd.MatchString(reTail.ReplaceAllString(plain, "")) && strings.HasSuffix(reTail.ReplaceAllString(line, ""), redacted)
		clean = append(clean, line)
	}
	for len(clean) > 0 && clean[len(clean)-1] == "" {
		clean = clean[:len(clean)-1]
	}
	truncated := len(clean) > screenMaxLines
	if truncated {
		clean = clean[len(clean)-screenMaxLines:]
	}
	text := strings.Join(clean, "\n")
	if utf16Len(text) > screenMaxChars {
		text = utf16Tail(text, screenMaxChars)
		truncated = true
	}
	return reFence.ReplaceAllString(text, "'''"), truncated
}

// screenWhy is the why of a refused or failed read: a 403 is the rule saying the agent isn't in the reporter's tree.
func screenWhy(err error) string {
	var ce *client.Error
	if errors.As(err, &ce) && ce.Status == 403 {
		return fmt.Sprintf("not in your tree (%s)", err.Error())
	}
	return fmt.Sprintf("the read failed (%s)", err.Error())
}

// screenSection is the screen sections for a report's details, one per named agent and screen type, plus a line for
// each screen not attached. Empty when the details name no screen event.
func screenSection(ctx context.Context, call API, details string) string {
	var types []string
	for _, t := range screenTypes {
		if strings.Contains(details, t) {
			types = append(types, t)
		}
	}
	if len(types) == 0 {
		return ""
	}
	list, err := call(ctx, "GET", "/api/agents?state=all", nil, 0)
	if err != nil {
		return fmt.Sprintf("Screen not attached: the agent list couldn't be read (%s).", screenWhy(err))
	}
	// The agents the details name, by id or name as a whole word, once each. A reply that isn't a list names none.
	words := map[string]bool{}
	for _, w := range reNotWord.Split(details, -1) {
		words[w] = true
	}
	type named struct{ id, name string }
	var found []named
	seen := map[string]bool{}
	if list.Kind == jsfmt.Array {
		for _, a := range list.Items {
			if !a.Truthy() {
				continue
			}
			// Set.has(undefined) is false: an absent or non-text id or name matches no word.
			idv, _ := a.Get("id")
			namev, _ := a.Get("name")
			id, name := jsString(memberOr(a, "id")), jsString(memberOr(a, "name"))
			if seen[id] || !((idv.Kind == jsfmt.String && words[id]) || (namev.Kind == jsfmt.String && words[name])) {
				continue
			}
			seen[id] = true
			found = append(found, named{id, name})
		}
	}
	var parts []string
	if len(found) == 0 {
		parts = append(parts, "Screen not attached: the report names no agent this daemon knows.")
	}
	read := found
	if len(read) > screenMaxAgents {
		read = read[:screenMaxAgents]
		more := len(found) - len(read)
		parts = append(parts, fmt.Sprintf("Screen not attached for %d more agent%s: a report reads at most %d.", more, plural(more), screenMaxAgents))
	}
	for _, a := range read {
		for _, t := range types {
			parts = append(parts, screenOf(ctx, call, a.id, a.name, t))
		}
	}
	return strings.Join(parts, "\n\n")
}

// screenOf is one agent's latest screen of one type, or why it isn't attached.
func screenOf(ctx context.Context, call API, id, name, typ string) string {
	evs, err := call(ctx, "GET", "/api/agents/"+uriComponent(id)+"/events?type="+typ+"&limit=1", nil, 0)
	if err != nil {
		return fmt.Sprintf("Screen not attached: %s on %s, %s.", typ, name, screenWhy(err))
	}
	if evs.Kind != jsfmt.Array || len(evs.Items) == 0 || !evs.Items[0].Truthy() {
		return fmt.Sprintf("Screen not attached: no %s event for %s.", typ, name)
	}
	ev := evs.Items[0]
	data := jsfmt.NullValue()
	if d, ok := ev.Get("data"); ok && d.Kind != jsfmt.Null {
		if data, err = jsfmt.Parse([]byte(jsString(d))); err != nil {
			return fmt.Sprintf("Screen not attached: %s on %s, %s.", typ, name, screenWhy(err))
		}
	}
	key := "now"
	if typ == "first-prompt:screen" {
		key = "screen"
	}
	var lines []string
	if v, ok := data.Get(key); ok && v.Kind == jsfmt.Array {
		for _, l := range v.Items {
			lines = append(lines, jsString(l))
		}
	}
	text, truncated := boundedScreen(lines)
	note := ""
	if truncated {
		note = "; truncated to its last lines"
	}
	return fmt.Sprintf("Screen of %s on %s (event at %s, latest%s):\n\n```text\n%s\n```", typ, name, member(ev, "ts"), note, text)
}

// memberOr is a member, or undefined's text when it is absent.
func memberOr(v jsfmt.Value, key string) jsfmt.Value {
	if m, ok := v.Get(key); ok {
		return m
	}
	return jsfmt.StringValue("undefined")
}
