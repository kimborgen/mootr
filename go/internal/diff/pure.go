// Package diff is src/diff.ts, the PR diff API's local half (S-1530), run on the ITSA home. A PR's diff comes from git,
// not the GitHub API: `refs/pull/N/head` and the main branch are fetched from the repo's origin URL into a bare cache
// repo under STAM_HOME (never into the checkout named in `settings.itsa.repos`, which is a live checkout), and the diff
// runs from the merge base to the head. The file list is cached per head sha; file bytes come from git objects. Only
// the human reaches it (the server forwards to the home); the files deny list holds for every path.
package diff

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"stam/internal/jsjson"
)

// Error is src/diff.ts DiffError: a refusal with its HTTP status.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

func refuse(status int, format string, a ...any) error {
	return &Error{Status: status, Message: fmt.Sprintf(format, a...)}
}

// ClassOrder is the order classes are tried in: the first match wins.
var ClassOrder = []string{"tests", "lockfiles", "generated", "docs"}

// globRe is src/diff.ts globRe: a glob as a regexp source, `**` crossing folders, `*` and `?` inside one.
func globRe(g string) string {
	var b strings.Builder
	for i := 0; i < len(g); i++ {
		c := g[i]
		switch {
		case strings.IndexByte(".+^${}()|[]\\", c) >= 0:
			b.WriteByte('\\')
			b.WriteByte(c)
		case c == '*' && i+1 < len(g) && g[i+1] == '*':
			b.WriteString(".*")
			i++
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?':
			b.WriteString("[^/]")
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// match runs a regexp source on s, false when it doesn't compile.
func match(src, s string) bool {
	re, err := regexp.Compile(src)
	return err == nil && re.MatchString(s)
}

// MatchPattern is src/diff.ts matchPattern: `dir/` names a folder anywhere in the path, a pattern with no other `/`
// matches the file name, anything else matches the whole path.
func MatchPattern(pattern, path string) bool {
	if pattern == "" {
		return false
	}
	if strings.HasSuffix(pattern, "/") {
		dir := pattern[:len(pattern)-1]
		return dir != "" && match(`(^|/)`+globRe(dir)+`/`, path)
	}
	if !strings.Contains(pattern, "/") {
		return match(`^`+globRe(pattern)+`$`, path[strings.LastIndex(path, "/")+1:])
	}
	return match(`^`+globRe(strings.TrimPrefix(pattern, "/"))+`$`, path)
}

// Classify is src/diff.ts classify: the class of a path under classes, or "" for none.
func Classify(path string, classes map[string][]string) string {
	for _, c := range ClassOrder {
		for _, p := range classes[c] {
			if MatchPattern(p, path) {
				return c
			}
		}
	}
	return ""
}

// RawFile is one file a diff touches. HeadBlob and BaseBlob are its git blob ids at the PR head and at the merge base
// (absent on the side it doesn't exist), so a viewer can key per-file state by content. The fields are in TS's order.
type RawFile struct {
	Path      string `json:"path"`
	OldPath   string `json:"oldPath,omitempty"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Binary    bool   `json:"binary"`
	BaseBlob  string `json:"baseBlob,omitempty"`
	HeadBlob  string `json:"headBlob,omitempty"`
}

var statusOf = map[byte]string{'A': "added", 'M': "modified", 'D': "deleted", 'R': "renamed", 'T': "modified", 'C': "added"}

var rawRe = regexp.MustCompile(`^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) (\w)`)

// ParseDiff is src/diff.ts parseDiff: the files of `--name-status -z` and `--numstat -z` (same order), with the blob ids
// of `--raw -z --no-abbrev`.
func ParseDiff(nameStatus, numstat, raw string) []RawFile {
	ns := strings.Split(nameStatus, "\x00")
	at := func(xs []string, i int) string {
		if i < len(xs) {
			return xs[i]
		}
		return ""
	}
	files := []RawFile{}
	for i := 0; i < len(ns) && ns[i] != ""; {
		code := ns[i][0]
		i++
		two := code == 'R' || code == 'C'
		first := at(ns, i)
		i++
		f := RawFile{Path: first, Status: "modified"}
		if s, ok := statusOf[code]; ok {
			f.Status = s
		}
		if two {
			f.Path, f.OldPath = at(ns, i), first
			i++
		}
		files = append(files, f)
	}
	nt := strings.Split(numstat, "\x00")
	for i, f := 0, 0; i < len(nt) && nt[i] != "" && f < len(files); f++ {
		parts := strings.Split(nt[i], "\t")
		i++
		if len(parts) > 2 && parts[2] == "" {
			// A rename: the old and new path follow as two more tokens.
			i += 2
		}
		file := &files[f]
		if parts[0] == "-" {
			file.Binary = true
			continue
		}
		file.Additions = jsInt(parts[0])
		if len(parts) > 1 {
			file.Deletions = jsInt(parts[1])
		}
	}
	rw := strings.Split(raw, "\x00")
	zero := regexp.MustCompile(`^0+$`)
	for i, f := 0, 0; i < len(rw) && rw[i] != "" && f < len(files); f++ {
		m := rawRe.FindStringSubmatch(rw[i])
		i++
		if m != nil && (m[3] == "R" || m[3] == "C") {
			i++
		}
		i++
		if m == nil {
			continue
		}
		if !zero.MatchString(m[1]) {
			files[f].BaseBlob = m[1]
		}
		if !zero.MatchString(m[2]) {
			files[f].HeadBlob = m[2]
		}
	}
	return files
}

// jsInt is `Number(s) || 0` for a count git printed.
func jsInt(s string) int {
	n := jsjson.ToNumber(s)
	if n != n || n > 1<<53 {
		return 0
	}
	return int(n)
}

var slugRe = regexp.MustCompile(`(?i)^(?:https?://(?:[^@/]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)([^/\s]+)/([^/\s]+?)(?:\.git)?/?$`)

// GithubSlug is src/diff.ts githubSlug: the GitHub `OWNER/REPO` a remote URL names (https, ssh or scp form), or "" for any
// other host.
func GithubSlug(url string) string {
	m := slugRe.FindStringSubmatch(jsjson.Trim(url))
	if m == nil {
		return ""
	}
	return m[1] + "/" + m[2]
}

// reviewContext is src/sources/github.ts REVIEW_CONTEXT.
const reviewContext = "stam/review"

// Review is src/diff.ts ReviewVerdict: the stam reviewer's verdict the diff header shows (S-1917).
type Review struct {
	Verdict string  `json:"verdict"`
	By      *string `json:"by"`
	Summary *string `json:"summary"`
	At      *string `json:"at"`
	Head    string  `json:"head"`
	Stale   bool    `json:"stale"`
}

// atOf is `String(x.updated_at ?? x.created_at ?? ”)`.
func atOf(x map[string]any) string {
	for _, k := range []string{"updated_at", "created_at"} {
		if v, ok := x[k]; ok && v != nil {
			return jsjson.ToString(v)
		}
	}
	return ""
}

var (
	agentRe = regexp.MustCompile(`^Review \(([^)]+)\):`)
	// JS's \s: Unicode spaces, the line terminators and the BOM.
	verdictRe = regexp.MustCompile(`^Review \([^)]*\):` + jsSpace + `*(?:approve|request_changes)\.?` + jsSpace + `*`)
)

const jsSpace = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

// ReviewOf is src/diff.ts reviewOf: the verdict in a watch snapshot (state, parsed JSON; nil for none) against the head
// the list shows. Nil when there is no `stam/review` status, or it is pending. The summary is text from the status
// description, cut to 200 UTF-16 units, and never markup.
func ReviewOf(state any, shownHead string) *Review {
	st, ok := state.(map[string]any)
	if !ok {
		return nil
	}
	head, ok := st["checksHead"].(string)
	if !ok {
		return nil
	}
	sts, _ := st["headStatuses"].([]any)
	var reviews []map[string]any
	for _, s := range sts {
		if m, ok := s.(map[string]any); ok && m["context"] == reviewContext {
			reviews = append(reviews, m)
		}
	}
	if len(reviews) == 0 {
		return nil
	}
	// newestReview: the newest by updated_at, else created_at; the sort is stable.
	sort.SliceStable(reviews, func(i, j int) bool { return atOf(reviews[i]) > atOf(reviews[j]) })
	newest := reviews[0]
	var verdict string
	switch newest["state"] {
	case "success":
		verdict = "approve"
	case "failure", "error":
		verdict = "changes"
	default:
		return nil
	}
	desc, _ := newest["description"].(string)
	out := &Review{Verdict: verdict, Head: head, Stale: head != shownHead}
	if m := agentRe.FindStringSubmatch(jsjson.Trim(desc)); m != nil {
		out.By = &m[1]
	}
	if summary := cutUnits(jsjson.Trim(verdictRe.ReplaceAllString(desc, "")), 200); summary != "" {
		out.Summary = &summary
	}
	if at := atOf(newest); at != "" {
		out.At = &at
	}
	return out
}

// cutUnits is s.slice(0, n) in UTF-16 units. A pair the cut splits loses its half, which a Go string can't hold alone.
func cutUnits(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	u = u[:n]
	if len(u) > 0 && utf16.IsSurrogate(rune(u[len(u)-1])) && u[len(u)-1] < 0xdc00 {
		u = u[:len(u)-1]
	}
	return string(utf16.Decode(u))
}
