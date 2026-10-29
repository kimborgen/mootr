package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The agent routes beside agent control (src/daemon.ts, S-3774): the human's prompt, a peer's notice, the final retro
// round, the files stam generated for an agent, and an agent's own usage.

func (s *Server) agentMiscRoutes() {
	s.handle("POST /api/agents/{id}/prompt", agentPath(s.humanPrompt))
	s.handle("POST /api/agents/{id}/notice", agentPath(s.peerNotice))
	s.handle("POST /api/agents/{id}/retro-final", agentPath(s.retroFinal))
	s.handle("GET /api/agents/{id}/files", agentPath(s.agentFiles))
	s.handle("GET /api/agents/{id}/usage", agentPath(s.agentUsage))
}

// humanPrompt is the web UI's prompt input: the human's message, pasted into the agent's terminal as typed input. Files
// are saved under STAM_HOME/uploads and named at the end of the message. A retry with the same client_id from the same
// caller is delivered once (src/client-dedup.ts): the key is reserved before the first runs, so a retry that comes while
// it runs waits for its answer instead of pasting again, and only a failed first lets a retry run.
func (s *Server) humanPrompt(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	id := ""
	if v, _ := w.body.Get("client_id"); v != nil {
		id, _ = v.(string)
	}
	scope := string(c.Kind) + ":" + c.Agent + "|" + r.URL.Path
	// The whole delivery outlives a client that hangs up: a paste whose event then failed would let the retry paste again.
	ctx := context.WithoutCancel(r.Context())
	return s.sends.run(scope, id, func() (any, error) { return s.typePrompt(ctx, w, r.PathValue("id")) })
}

type promptEvent struct {
	Chars int `json:"chars"`
	Files int `json:"files"`
}

func (s *Server) typePrompt(ctx context.Context, w write, ref string) (any, error) {
	if !w.human {
		return nil, Errorf(http.StatusForbidden, "only the human types into an agent")
	}
	a, err := s.mustAgent(ctx, ref)
	if err != nil {
		return nil, err
	}
	if s.life == nil {
		return nil, Errorf(http.StatusNotImplemented, "typing into an agent isn't available on this daemon")
	}
	if !s.life.HasSession(ctx, a.ID) {
		return nil, Errorf(http.StatusConflict, "%s isn't running", a.Name)
	}
	// The human's choice even when the agent is held: admitted, with a cost:override event. Only an agent taken over by
	// a live successor refuses it.
	if ok, reason := s.life.AdmitHuman(ctx, a.ID); !ok {
		return nil, Errorf(http.StatusConflict, "%s is %s", a.Name, reason)
	}
	text := ""
	if v, _ := w.body.Get("text"); v != nil {
		text = claude.JSString(v)
	}
	files, _ := w.body.Get("files")
	full, err := s.withUploads(text, files, a.ID)
	if err != nil {
		return nil, err
	}
	if err := s.life.PasteHumanPrompt(ctx, a, full); err != nil {
		return nil, err
	}
	n := 0
	if list, ok := files.([]jsjson.Value); ok {
		n = len(list)
	}
	if err := s.db.AddEvent(ctx, a.ID, "human:prompt", promptEvent{Chars: utf16Len(text), Files: n}); err != nil {
		return nil, err
	}
	return map[string]bool{"sent": true}, nil
}

var uploadUnsafe = regexp.MustCompile(`[^\w.-]+`)

// withUploads is src/daemon.ts withUploads: the files saved under STAM_HOME/uploads/OWNER/TIME/, each named N-BASENAME
// with anything but word characters, dots and dashes made `_`, and listed at the end of the message. In a shell the
// paths join the command line, quoted, as a file dropped on a terminal does.
func (s *Server) withUploads(text string, files jsjson.Value, owner string, shell ...bool) (string, error) {
	list, ok := files.([]jsjson.Value)
	if !ok || len(list) == 0 {
		return text, nil
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	dir := filepath.Join(s.cfg.Home, "uploads", owner, stamp)
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return "", err
	}
	paths := make([]string, len(list))
	for i, f := range list {
		o, _ := f.(*jsjson.Object)
		name := "file"
		if v := get(o, "name"); jsjson.Truthy(v) {
			name = claude.JSString(v)
		}
		// path.basename: what follows the last slash, trailing slashes dropped.
		base := strings.TrimRight(name, "/")
		if k := strings.LastIndex(base, "/"); k >= 0 {
			base = base[k+1:]
		}
		p := filepath.Join(dir, fmt.Sprintf("%d-%s", i+1, uploadUnsafe.ReplaceAllString(base, "_")))
		content := ""
		if v := get(o, "content_b64"); v != nil {
			content = claude.JSString(v)
		}
		// Buffer.from(s, 'base64') skips what isn't base64 and takes padding as optional.
		raw, _ := base64.RawStdEncoding.DecodeString(strings.TrimRight(base64Chars.ReplaceAllString(strings.NewReplacer("-", "+", "_", "/").Replace(content), ""), "="))
		if err := os.WriteFile(p, raw, 0o666); err != nil {
			return "", err
		}
		paths[i] = p
	}
	if len(shell) > 0 && shell[0] {
		words := []string{}
		if text != "" {
			words = append(words, text)
		}
		for _, p := range paths {
			words = append(words, "'"+strings.ReplaceAll(p, "'", `'\''`)+"'")
		}
		return strings.Join(words, " "), nil
	}
	head := "Attached file"
	if len(paths) > 1 {
		head = "Attached files"
	}
	lines := make([]string, len(paths))
	for i, p := range paths {
		lines[i] = "- " + p
	}
	return jsjson.Trim(text + "\n\n" + head + ":\n" + strings.Join(lines, "\n")), nil
}

var base64Chars = regexp.MustCompile(`[^A-Za-z0-9+/=]`)

// peerNotice is a notice for an agent here, from a peer (an owner's stop, for the parent ITSA's owner).
func (s *Server) peerNotice(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	if !w.local {
		return nil, Errorf(http.StatusForbidden, "only a peer can queue a notice")
	}
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if text, ok := get(w.body, "text").(string); ok && (a.Lifecycle == "active" || a.Lifecycle == "paused") {
		s.queueNotice(r.Context(), a.ID, text)
	}
	return struct{}{}, nil
}

// retroFinal is an agent's final retro round, filed as it is archived (S-159): its effort split, stored as an event
// with the measured split (S-227) beside it, null when the agent has no timed activity.
func (s *Server) retroFinal(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	ctx := r.Context()
	a, err := s.mustAgent(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if by, ok := get(w.body, "by").(string); !ok || by != a.ID {
		return nil, Errorf(http.StatusForbidden, "only the agent itself files its final retro round")
	}
	ev := jsjson.NewObject()
	// JSON.stringify drops an effort that is undefined.
	if v, ok := w.body.Get("effort"); ok {
		ev.Set("effort", v)
	}
	ev.Set("model", jsNullable(a.Model))
	ev.Set("type", jsNullable(a.Type))
	m, err := s.measuredEffort(ctx, a.ID)
	if err != nil {
		return nil, err
	}
	var measured jsjson.Value
	if m != nil {
		b, err := json.Marshal(m.Split)
		if err != nil {
			return nil, err
		}
		if measured, err = jsjson.Parse(b); err != nil {
			return nil, err
		}
	}
	ev.Set("measured", measured)
	if err := s.db.AddEvent(ctx, a.ID, "retro_final", json.RawMessage(jsjson.Stringify(ev, ""))); err != nil {
		return nil, err
	}
	return struct{}{}, nil
}

func jsNullable(p *string) jsjson.Value {
	if p == nil {
		return nil
	}
	return *p
}

// agentFile is one file stam generated for an agent.
type agentFile struct {
	Name string `json:"name"`
	Text string `json:"text"`
}

// fileLimit is how much of a file the route shows, in UTF-16 code units as String.prototype.slice counts.
const fileLimit = 50_000

// readLimit is how many bytes of a file are read: no UTF-8 text has fewer than one code unit per 3 bytes, so it holds
// the fileLimit units shown.
const readLimit = 3 * fileLimit

// cutUnsafe is the files that can't be shown cut off: a shell script, where the cap may land inside a quoted (and
// multi-line) value. A cut-off JSON file is withheld too, as it doesn't parse (redactSecrets).
func cutUnsafe(name string) bool { return strings.HasSuffix(name, ".sh") }

// agentFiles is the files stam generated for an agent, such as its system prompt and harness settings: the regular files
// in STAM_HOME/agents/ID, by name. A symlink is left out whatever it points at, so nothing outside the folder is read,
// and the secrets a harness config holds (an MCP server's env and headers, a bearer) are redacted.
func (s *Server) agentFiles(r *http.Request, c auth.Resolved) (any, error) {
	a, err := s.mustAgent(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	dir, err := claude.AgentDir(s.cfg.Home, a.ID)
	if err != nil {
		return nil, err
	}
	return readAgentFiles(dir)
}

// beforeOpen is a test's hook between listing a file and opening it; nil outside tests.
var beforeOpen func(path string)

// readAgentFiles reads dir's regular files. A symlink is skipped as it is listed, and one put in a file's place after
// that fails to open (O_NOFOLLOW). The open doesn't block (O_NONBLOCK), so a FIFO swapped in is refused by its fstat
// rather than waited on forever.
func readAgentFiles(dir string) ([]agentFile, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := []agentFile{}
	for _, e := range entries {
		// ReadDir's type is the entry's own (Lstat): a symlink is not a regular file. A name is one path element, so it
		// can't climb out with `..`.
		if !e.Type().IsRegular() || e.Name() == "." || e.Name() == ".." || strings.ContainsRune(e.Name(), filepath.Separator) {
			continue
		}
		p := filepath.Join(dir, e.Name())
		if beforeOpen != nil {
			beforeOpen(p)
		}
		f, err := os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			continue
		}
		st, err := f.Stat()
		var b []byte
		if err == nil && st.Mode().IsRegular() {
			b, err = io.ReadAll(io.LimitReader(f, readLimit+1))
		}
		f.Close()
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		text := strings.ToValidUTF8(string(b), "�")
		if len(b) > readLimit && cutUnsafe(e.Name()) {
			text = ""
		}
		out = append(out, agentFile{Name: e.Name(), Text: sliceUTF16(redactSecrets(e.Name(), text), fileLimit)})
	}
	return out, nil
}

// sliceUTF16 is String.prototype.slice(0, n): the first n UTF-16 code units, without a half pair at the end.
func sliceUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		w := len(utf16.Encode([]rune{r}))
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// secretKey is a JSON key whose value is a secret.
var secretKey = regexp.MustCompile(`(?i)token|secret|password|passwd|authorization|api[-_]?key|bearer|cookie|credential`)

// bearerText is a bearer or basic credential in plain text.
var bearerText = regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`)

const redacted = "[redacted]"

// shellAssign is a shell variable assignment and its value: one word made of single-quoted parts (as tmux.shellQuote
// writes them), double-quoted parts and bare text. A quote left open runs to the end of the text, so it is all redacted.
var shellAssign = regexp.MustCompile(`(^|[\s;&|])([A-Za-z_][A-Za-z0-9_]*)=((?:'(?:[^']|'\\'')*(?:'|$)|"(?:[^"\\]|\\.)*(?:"|$)|[^\s'";&|]+)+)`)

// redactSecrets hides the secrets a generated file may hold. In a JSON file every value under an `env` or `headers`
// object, or under a key that names a secret, is replaced. In a shell script (codex-launch.sh puts MCP env and header
// values in the app-server's environment as KEY='value') every assigned value is, but those of the script's own
// variables (launchVars). Any file's bearer credentials are too.
func redactSecrets(name, text string) string {
	switch {
	case strings.HasSuffix(name, ".json"):
		v, err := jsjson.Parse([]byte(text))
		if err != nil {
			// What doesn't parse can't be redacted by key.
			return ""
		}
		text = jsjson.Stringify(redactValue(v, false), "  ")
	case strings.HasSuffix(name, ".sh"):
		text = shellAssign.ReplaceAllStringFunc(text, func(m string) string {
			sub := shellAssign.FindStringSubmatch(m)
			if name, v := sub[2], sub[3]; launchVars[name] && (strings.HasPrefix(v, "$") || name == "i" && v == "0") {
				return m
			}
			return sub[1] + sub[2] + "='" + redacted + "'"
		})
	}
	return bearerText.ReplaceAllString(text, "$1 "+redacted)
}

// launchVars is the variables codex-launch.sh sets for itself (src/adapters/codex.ts): SERVER=$!, THREAD=$(cat ...),
// i=0 and i=$((i+1)). Their values are kept only in those shapes, since an MCP server's env key may use the same name,
// and its value, quoted by tmux.shellQuote, never starts with `$`.
var launchVars = map[string]bool{"SERVER": true, "i": true, "THREAD": true}

func redactValue(v jsjson.Value, secret bool) jsjson.Value {
	switch x := v.(type) {
	case *jsjson.Object:
		out := jsjson.NewObject()
		for _, k := range x.Keys() {
			val, _ := x.Get(k)
			out.Set(k, redactValue(val, secret || k == "env" || k == "headers" || secretKey.MatchString(k)))
		}
		return out
	case []jsjson.Value:
		out := make([]jsjson.Value, len(x))
		for i, e := range x {
			out[i] = redactValue(e, secret)
		}
		return out
	case nil, bool:
		return v
	}
	if secret {
		return redacted
	}
	return v
}

// usageTotals is src/usage.ts UsageTotals: a counter the harness doesn't report, or every counter when the agent has
// no rows, is null.
type usageTotals struct {
	CostUSD          *float64 `json:"cost_usd"`
	TokensIn         *float64 `json:"tokens_in"`
	TokensOut        *float64 `json:"tokens_out"`
	TokensCacheRead  *float64 `json:"tokens_cache_read"`
	TokensCacheWrite *float64 `json:"tokens_cache_write"`
}

type agentUsageReply struct {
	AgentID  string      `json:"agent_id"`
	Harness  string      `json:"harness"`
	Model    *string     `json:"model"`
	Lifetime usageTotals `json:"lifetime"`
	Today    usageTotals `json:"today"`
}

// harnessCounters is src/usage.ts HARNESS_COUNTERS: Codex reports no cost; an unknown harness is taken to report all.
var harnessCounters = map[string]map[string]bool{
	"codex": {"tokens_in": true, "tokens_out": true, "tokens_cache_read": true, "tokens_cache_write": true},
}

func totalsFor(harness string, row db.UsageSums) usageTotals {
	var out usageTotals
	if row.N == 0 {
		return out
	}
	fields := []**float64{&out.CostUSD, &out.TokensIn, &out.TokensOut, &out.TokensCacheRead, &out.TokensCacheWrite}
	reports := harnessCounters[harness]
	for i, k := range db.UsageCounters {
		if reports == nil || reports[k] {
			v := row.Sums[i]
			*fields[i] = &v
		}
	}
	return out
}

// agentUsage is one agent's own usage (S-95): its harness and model, and its token and cost totals for today and its
// whole life. An agent's token reads only the agents of its own tree and its ancestors' trees.
func (s *Server) agentUsage(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	viewer, scoped := s.usageViewer(ctx, c, r.URL.Query().Get("as"))
	a, err := s.mustAgent(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	if scoped {
		visible, err := s.visibleAgents(ctx, viewer)
		if err != nil {
			return nil, err
		}
		if !visible[a.ID] {
			return nil, Errorf(http.StatusForbidden, "an agent reads the usage of agents in its own tree and its ancestors' trees only, not %s's", a.Name)
		}
	}
	life, today, last, err := s.db.AgentUsage(ctx, a.ID, time.Now().UTC().Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	model := a.Model
	if model == nil && last != "" {
		model = &last
	}
	return agentUsageReply{AgentID: a.ID, Harness: a.Harness, Model: model, Lifetime: totalsFor(a.Harness, life), Today: totalsFor(a.Harness, today)}, nil
}

// visibleAgents is src/usage-scope.ts visibleAgents: me, its ancestors, and everything below any of them.
func (s *Server) visibleAgents(ctx context.Context, me string) (map[string]bool, error) {
	out := map[string]bool{me: true}
	a, err := s.db.GetAgent(ctx, me)
	if err != nil {
		return out, nil
	}
	out[a.ID] = true
	seen := map[string]bool{}
	var up func(a db.Agent) error
	up = func(a db.Agent) error {
		parents, err := s.db.ParentsOf(ctx, a)
		if err != nil {
			return err
		}
		for _, p := range parents {
			if seen[p] {
				continue
			}
			seen[p] = true
			out[p] = true
			if pa, err := s.db.GetAgent(ctx, p); err == nil {
				if err := up(pa); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := up(a); err != nil {
		return nil, err
	}
	roots := make([]string, 0, len(out))
	for id := range out {
		roots = append(roots, id)
	}
	for _, id := range roots {
		kids, err := s.descendants(ctx, id)
		if err != nil {
			return nil, err
		}
		for k := range kids {
			out[k] = true
		}
	}
	return out, nil
}
