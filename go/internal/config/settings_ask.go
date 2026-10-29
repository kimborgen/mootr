package config

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"stam/internal/jsjson"
)

// The settings ask of src/permissions.ts (S-362, S-3071): the chief of staff or the assistant asks to change the
// settings, the human sees a diff with every secret hidden, and an approval applies the change unless what it touches
// changed since. Pure parts only; the server routes and answers.

// Change is src/permissions.ts SettingsChange for the settings file: a whole file (Kind "post") or a patch.
type Change struct {
	Kind  string
	Text  string
	Patch *jsjson.Object
	Fill  bool
}

// JSON is the change as TS stores it in the request's payload.
func (c Change) JSON() *jsjson.Object {
	if c.Kind == "patch" {
		return jsjson.NewObject("kind", "patch", "patch", c.Patch, "fill", c.Fill)
	}
	return jsjson.NewObject("kind", c.Kind, "text", c.Text)
}

// ParseChange reads a payload's change back; ok is false for one this port doesn't apply (the registry's).
func ParseChange(v jsjson.Value) (Change, bool) {
	kind, _ := member(v, "kind")
	switch kind {
	case "patch":
		p, _ := member(v, "patch")
		fill, _ := member(v, "fill")
		return Change{Kind: "patch", Patch: spread(p), Fill: fill == true}, obj(p) != nil
	case "post":
		t, _ := member(v, "text")
		s, ok := t.(string)
		return Change{Kind: "post", Text: s}, ok
	}
	return Change{}, false
}

// Hash is the sha256 hex digest of a text, as the payload keeps it.
func Hash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// Payload is src/permissions.ts settingsPayload: the change and what it was shown against, the whole file's hash and,
// for a patch, the hash of the values it touches (S-974).
func Payload(c Change, current string) *jsjson.Object {
	out := jsjson.NewObject("change", c.JSON(), "baseHash", Hash(current))
	if c.Kind == "patch" {
		out.Set("touchedHash", Hash(PatchTouchedText(current, c.Patch)))
	}
	return out
}

// RedactedPayload is a settings request's payload once the request is decided or withdrawn (S-3869): the change with its
// secrets replaced as an agent reads the settings (RedactValue on a patch, RedactText on a text), so a plain MCP
// client_secret never stays in stam.db, and "redacted": true. The hashes go too: they serve only the approval's check, and
// a hash of a touched value could be guessed back. A payload that isn't a JSON object becomes {"redacted":true}. TS keeps
// the plaintext.
func RedactedPayload(payload string) string {
	out := jsjson.NewObject()
	if v, err := jsjson.Parse([]byte(payload)); err == nil {
		raw, _ := member(v, "change")
		if c := obj(raw); c != nil {
			change := jsjson.NewObject()
			for _, k := range c.Keys() {
				e, _ := c.Get(k)
				switch {
				case k == "patch":
					e = RedactValue(e)
				case k == "text":
					s, _ := e.(string)
					e = RedactText(s)
				}
				change.Set(k, e)
			}
			out.Set("change", change)
		}
	}
	out.Set("redacted", true)
	return jsjson.Stringify(out, "")
}

// UnchangedSince is src/permissions.ts settingsUnchangedSince: a patch needs only the values it touches unchanged, a
// whole file the whole file. A file that doesn't parse to an object takes the whole-file check.
func UnchangedSince(payload jsjson.Value, c Change, current string) bool {
	parsed, err := jsjson.Parse([]byte(current))
	touched, has := member(payload, "touchedHash")
	if c.Kind == "patch" && has && err == nil && obj(parsed) != nil {
		return Hash(PatchTouchedText(current, c.Patch)) == touched
	}
	base, _ := member(payload, "baseHash")
	return Hash(current) == base
}

// PatchTouchedText is src/settings.ts patchTouchedText: the values a patch would overwrite, as current holds them (a
// view record, only the ids it sets), without the sub-keys the daemon owns.
func PatchTouchedText(current string, patch *jsjson.Object) string {
	user := ParseObject(current)
	touched := jsjson.NewObject()
	for _, k := range patch.Keys() {
		v, _ := patch.Get(k)
		cur, has := user.Get(k)
		if viewRecords[k] && obj(v) != nil {
			ids := jsjson.NewObject()
			for _, id := range obj(v).Keys() {
				if x, ok := member(cur, id); ok {
					ids.Set(id, x)
				}
			}
			touched.Set(k, ids)
			continue
		}
		var owned []string
		for _, d := range daemonOwned {
			if d[0] == k {
				owned = append(owned, d[1])
			}
		}
		switch {
		case obj(cur) != nil && len(owned) > 0:
			kept := jsjson.NewObject()
			for _, sub := range obj(cur).Keys() {
				if !containsStr(owned, sub) {
					x, _ := obj(cur).Get(sub)
					kept.Set(sub, x)
				}
			}
			touched.Set(k, kept)
		case has:
			touched.Set(k, cur)
		}
	}
	return jsjson.Stringify(touched, "")
}

func containsStr(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// destination are the fields a secret goes with: a marker under a changed one is refused.
var destination = []string{"url", "command", "args"}

// destinationMoved is src/permissions.ts destinationMoved.
func destinationMoved(next, cur jsjson.Value) bool {
	for _, k := range destination {
		a, aok := memberAny(next, k)
		b, bok := memberAny(cur, k)
		if show(a, aok) != show(b, bok) {
			return true
		}
	}
	return false
}

// matchElement is src/permissions.ts matchElement: the index of the element of cur that el stands for (the same name,
// else the same url), or -1.
func matchElement(el, cur jsjson.Value) int {
	list, ok := cur.([]jsjson.Value)
	if !ok || !isObject(el) {
		return -1
	}
	for _, key := range []string{"name", "url"} {
		v, has := memberAny(el, key)
		s, isStr := v.(string)
		if !has || !isStr {
			continue
		}
		for i, c := range list {
			if x, ok := memberAny(c, key); isObject(c) && ok && x == s {
				return i
			}
		}
		return -1
	}
	return -1
}

// errRedacted is a marker that can't be put back.
type errRedacted string

func (e errRedacted) Error() string { return string(e) }

// restoreRedacted is src/permissions.ts restoreRedacted: each Redacted marker takes cur's value at the same path,
// unless cur has none there or the marker sits under a changed url, command or args.
func restoreRedacted(next, cur jsjson.Value, curOK bool, path string, moved bool) (jsjson.Value, error) {
	if next == Redacted {
		if !curOK || moved {
			where := path
			if where == "" {
				where = "the settings"
			}
			why := "where the settings have no value"
			if moved {
				why = "under a changed url or command"
			}
			return nil, errRedacted(where + " holds \"" + Redacted + "\" " + why + "; send the real value, or keep the url")
		}
		return cur, nil
	}
	switch x := next.(type) {
	case []jsjson.Value:
		uses := map[int]int{}
		for _, v := range x {
			if m := matchElement(v, cur); m >= 0 {
				uses[m]++
			}
		}
		out := make([]jsjson.Value, len(x))
		curList, _ := cur.([]jsjson.Value)
		for i, v := range x {
			var c jsjson.Value
			ok := false
			if m := matchElement(v, cur); m >= 0 && uses[m] == 1 {
				c, ok = curList[m], true
			}
			r, err := restoreRedacted(v, c, ok, fmt.Sprintf("%s[%d]", path, i), moved)
			if err != nil {
				return nil, err
			}
			out[i] = r
		}
		return out, nil
	case *jsjson.Object:
		here := moved || (isObject(cur) && destinationMoved(next, cur))
		out := jsjson.NewObject()
		for _, k := range x.Keys() {
			v, _ := x.Get(k)
			var c jsjson.Value
			ok := false
			if isObject(cur) {
				c, ok = memberAny(cur, k)
			}
			p := k
			if path != "" {
				p = path + "." + k
			}
			r, err := restoreRedacted(v, c, ok, p, here)
			if err != nil {
				return nil, err
			}
			out.Set(k, r)
		}
		return out, nil
	}
	return next, nil
}

// UnredactedChange is src/permissions.ts unredactedChange: the change an agent sent, with each redacted value it kept
// put back from current (its GET is redacted), so a non-home daemon can tell which keys it really changes (S-398). It
// refuses where a redacted value can't be put back, as ResultOf does. A whole file that isn't an object is {}.
func UnredactedChange(c Change, current string) (*jsjson.Object, error) {
	cur, err := jsjson.Parse([]byte(current))
	if err != nil {
		cur = jsjson.NewObject()
	}
	if c.Kind != "patch" {
		parsed, err := jsjson.Parse([]byte(c.Text))
		if err != nil {
			return nil, errors.New("not valid JSON: the text does not parse")
		}
		r, err := restoreRedacted(parsed, cur, true, "", false)
		if err != nil {
			return nil, err
		}
		if o := obj(r); o != nil {
			return o, nil
		}
		return jsjson.NewObject(), nil
	}
	out := jsjson.NewObject()
	for _, k := range c.Patch.Keys() {
		v, _ := c.Patch.Get(k)
		cv, ok := member(cur, k)
		r, err := restoreRedacted(v, cv, ok, k, false)
		if err != nil {
			return nil, err
		}
		out.Set(k, r)
	}
	return out, nil
}

// markChangedSecrets is src/permissions.ts markChangedSecrets: where a secret differs from cur's, the diff says so.
func markChangedSecrets(redactedNew, rawNew jsjson.Value, newOK bool, rawCur jsjson.Value, curOK bool, moved bool) jsjson.Value {
	if redactedNew == Redacted {
		if moved || !strictEqual(rawNew, newOK, rawCur, curOK) {
			return "[redacted: changed]"
		}
		return Redacted
	}
	switch x := redactedNew.(type) {
	case []jsjson.Value:
		out := make([]jsjson.Value, len(x))
		curList, _ := rawCur.([]jsjson.Value)
		for i, v := range x {
			n, nok := memberAny(rawNew, jsjson.Number(float64(i)))
			var c jsjson.Value
			cok := false
			if m := matchElement(n, rawCur); m >= 0 {
				c, cok = curList[m], true
			}
			out[i] = markChangedSecrets(v, n, nok, c, cok, moved)
		}
		return out
	case *jsjson.Object:
		out := jsjson.NewObject()
		here := moved || (obj(rawCur) != nil && destinationMoved(rawNew, rawCur))
		for _, k := range x.Keys() {
			v, _ := x.Get(k)
			n, nok := memberAny(rawNew, k)
			c, cok := memberAny(rawCur, k)
			out.Set(k, markChangedSecrets(v, n, nok, c, cok, here))
		}
		return out
	}
	return redactedNew
}

// strictEqual is `a === b` for parsed values: an object or array is only ever equal to itself, so never here.
func strictEqual(a jsjson.Value, aok bool, b jsjson.Value, bok bool) bool {
	if aok != bok {
		return false
	}
	if !aok {
		return true
	}
	if isObject(a) || isObject(b) {
		return false
	}
	return a == b
}

// RedactedForDiff is src/permissions.ts redactedForDiff: next redacted, with each changed secret marked.
func RedactedForDiff(current, next string) string {
	red, _ := jsjson.Parse([]byte(RedactText(next)))
	raw, _ := jsjson.Parse([]byte(next))
	cur, err := jsjson.Parse([]byte(current))
	if err != nil {
		cur = jsjson.NewObject()
	}
	return Text(markChangedSecrets(red, raw, true, cur, true, false))
}

// ResultOf is src/permissions.ts resultOf for the settings file: the text the change makes of current, or the reason
// it is refused, as the human's routes refuse it. A Redacted marker the agent kept takes current's value. problem is
// set when the refusal is an invalid file (the caller mails a cost problem to the human).
func ResultOf(c Change, current string, registry *jsjson.Object) (text string, problem *Problem, err error) {
	if c.Kind == "patch" {
		t, p := Patched(current, c.Patch, c.Fill, registry)
		if p != nil {
			return "", p, p
		}
		text = t
	} else {
		text = c.Text
	}
	parsed, perr := jsjson.Parse([]byte(text))
	if perr != nil {
		return "", nil, errors.New("not valid JSON: the text does not parse")
	}
	cur, cerr := jsjson.Parse([]byte(current))
	if cerr != nil {
		cur = jsjson.NewObject()
	}
	restored, rerr := restoreRedacted(parsed, cur, true, "", false)
	if rerr != nil {
		return "", nil, rerr
	}
	if jsjson.Stringify(restored, "") != jsjson.Stringify(parsed, "") {
		parsed = restored
		text = Text(parsed)
	}
	if p := FileProblem(parsed, registry); p != nil {
		return "", p, p
	}
	return text, nil, nil
}

// UnifiedDiff is src/textdiff.ts unifiedDiff with three lines of context: "" when a and b have the same lines.
func UnifiedDiff(a, b, labelA, labelB string) string {
	const context = 3
	x, y := strings.Split(a, "\n"), strings.Split(b, "\n")
	if x[len(x)-1] == "" {
		x = x[:len(x)-1]
	}
	if y[len(y)-1] == "" {
		y = y[:len(y)-1]
	}
	n, m := len(x), len(y)
	lcs := make([][]int, n+1)
	for i := range lcs {
		lcs[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if x[i] == y[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	type op struct {
		t byte
		s string
	}
	var ops []op
	i, j := 0, 0
	for i < n || j < m {
		switch {
		case i < n && j < m && x[i] == y[j]:
			ops = append(ops, op{' ', x[i]})
			i++
			j++
		case j < m && (i >= n || lcs[i][j+1] >= lcs[i+1][j]):
			ops = append(ops, op{'+', y[j]})
			j++
		default:
			ops = append(ops, op{'-', x[i]})
			i++
		}
	}
	var hunks [][2]int
	for k, o := range ops {
		if o.t == ' ' {
			continue
		}
		lo, hi := max(0, k-context), min(len(ops), k+context+1)
		if len(hunks) > 0 && lo <= hunks[len(hunks)-1][1] {
			hunks[len(hunks)-1][1] = hi
		} else {
			hunks = append(hunks, [2]int{lo, hi})
		}
	}
	if len(hunks) == 0 {
		return ""
	}
	out := []string{"--- " + labelA, "+++ " + labelB}
	for _, h := range hunks {
		startA, startB := 1, 1
		for _, o := range ops[:h[0]] {
			if o.t != '+' {
				startA++
			}
			if o.t != '-' {
				startB++
			}
		}
		lenA, lenB := 0, 0
		for _, o := range ops[h[0]:h[1]] {
			if o.t != '+' {
				lenA++
			}
			if o.t != '-' {
				lenB++
			}
		}
		out = append(out, fmt.Sprintf("@@ -%d,%d +%d,%d @@", startA, lenA, startB, lenB))
		for _, o := range ops[h[0]:h[1]] {
			out = append(out, string(o.t)+o.s)
		}
	}
	return strings.Join(out, "\n")
}

var (
	plainName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	envVar    = regexp.MustCompile(`^[A-Z_][A-Z0-9_]{0,127}$`)
	originOK  = regexp.MustCompile(`(?i)^[a-z0-9.:/\[\]-]+$`)
)

func quoteName(x string, ok *regexp.Regexp, otherwise string) string {
	if ok.MatchString(x) {
		return "`" + x + "`"
	}
	return otherwise
}

// webOrigin is a URL's origin as WHATWG URL prints it, "null" for a scheme without one, ok false when it doesn't parse.
func webOrigin(raw string) (string, bool) {
	u, err := url.Parse(jsjson.Trim(raw))
	if err != nil || u.Scheme == "" {
		return "", false
	}
	scheme := strings.ToLower(u.Scheme)
	ports := map[string]string{"http": "80", "https": "443", "ws": "80", "wss": "443", "ftp": "21"}
	def, special := ports[scheme]
	if !special {
		return "null", true
	}
	if u.Host == "" {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if p := u.Port(); p != "" && p != def {
		host += ":" + p
	}
	return scheme + "://" + host, true
}

// destinationOf is src/permissions.ts destinationOf: where a provider sends its key, as shown and as raw text.
func destinationOf(p jsjson.Value) (string, string) {
	kind, _ := memberAny(p, "kind")
	str := func(k string) (jsjson.Value, bool) { return memberAny(p, k) }
	var raw jsjson.Value
	var ok bool
	switch kind {
	case "azure":
		raw, ok = str("endpoint")
	case "bedrock":
		raw, ok = str("endpoint")
		if isNullish(raw, ok) {
			if r, isStr := memberAny(p, "region"); isStr {
				if rs, s := r.(string); s {
					raw, ok = "https://bedrock-runtime."+rs+".amazonaws.com", true
				}
			}
		}
	default:
		raw, ok = str("baseUrl")
		if isNullish(raw, ok) {
			raw, ok = str("endpoint")
		}
	}
	s, isStr := raw.(string)
	if !ok || !isStr || jsjson.Trim(s) == "" {
		return "an unset address", ""
	}
	if o, parsed := webOrigin(s); parsed && o != "null" && originOK.MatchString(o) {
		return "`" + o + "`", o
	}
	return "an address that is not a URL", s
}

// keyDestination is one provider's key and where it goes.
type keyDestination struct{ provider, key, to, sig string }

// keyDestinations is src/permissions.ts keyDestinations.
func keyDestinations(s jsjson.Value) []keyDestination {
	var out []keyDestination
	providers, _ := member(s, "providers")
	for _, pair := range pairs(providers) {
		id, p := pair[0].(string), pair[1]
		if id == "openrouter" {
			continue
		}
		ref, _ := memberAny(p, "apiKey")
		refStr := func(k string) string {
			v, _ := memberAny(ref, k)
			s, _ := v.(string)
			return s
		}
		type key struct{ raw, shown string }
		var keys []key
		if sec := refStr("secret"); sec != "" {
			shown := "a stored value"
			if secretName.MatchString(sec) {
				shown = "the stored secret `" + sec + "`"
			}
			keys = append(keys, key{"secret:" + sec, shown})
		}
		if env := refStr("env"); env != "" {
			keys = append(keys, key{"env:" + env, "the environment variable " + quoteName(env, envVar, "with an unusual name")})
		}
		if kind, _ := memberAny(p, "kind"); kind == "bedrock" && refStr("secret") == "" && refStr("env") == "" {
			profile, _ := memberAny(p, "profile")
			ps, isStr := profile.(string)
			shown := "the AWS credentials"
			if isStr && ps != "" {
				shown = "the AWS credentials of profile " + quoteName(ps, plainName, "with an unusual name")
			}
			keys = append(keys, key{"aws:" + ps, shown})
		}
		if len(keys) == 0 {
			continue
		}
		to, dest := destinationOf(p)
		for _, k := range keys {
			sig := jsjson.Stringify([]jsjson.Value{id, k.raw, dest}, "")
			out = append(out, keyDestination{quoteName(id, plainName, "with an unusual name"), k.shown, to, sig})
		}
	}
	return out
}

// KeyDestinationNotes is src/permissions.ts keyDestinationNotes: a line for each key a change would newly send to an
// origin (S-2115).
func KeyDestinationNotes(current, next string) string {
	parse := func(t string) jsjson.Value {
		v, err := jsjson.Parse([]byte(t))
		if err != nil {
			return jsjson.NewObject()
		}
		return v
	}
	before := map[string]bool{}
	for _, d := range keyDestinations(parse(current)) {
		before[d.sig] = true
	}
	var b strings.Builder
	for _, d := range keyDestinations(parse(next)) {
		if !before[d.sig] {
			b.WriteString("\n\nKey destination: provider " + d.provider + " would send " + d.key + " to " + d.to + ".")
		}
	}
	return b.String()
}
