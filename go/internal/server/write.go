package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	neturl "net/url"
	"regexp"
	"strings"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// What src/daemon.ts handler does to a write before its route (S-2820): it reads the JSON body, refuses an agent's
// body that isn't an object, resolves the identity fields (resolveActors), and tells whether the request is the
// human's. resolveBody does the first three once, in ServeHTTP, for every route (S-3795).

// humanName is mail.HUMAN, the human's address.
const humanName = "human"

// maxBody bounds a request body: no route takes more.
const maxBody = 64 << 20

// write is a write request after those checks.
type write struct {
	body  *jsjson.Object
	human bool
	local bool
	// onCreated, on the daemon's own spawns (a ring's members), hears the new agent's id once its row exists, so a spawn
	// that fails after that is discarded by the id it made, never by a name lookup.
	onCreated func(id string)
	// queue: a developer spawn at the cap waits in the slot queue (slotqueue.go) instead of a 409; only POST /api/agents
	// asks for it. granted: the queue already reserved this spawn's slot, so the cap isn't checked again.
	queue, granted bool
}

// readWrite reads the body of a POST, PUT, PATCH or DELETE, as resolveBody left it.
func (s *Server) readWrite(r *http.Request, c auth.Resolved) (write, error) {
	raw, err := readBody(r)
	if err != nil {
		return write{}, err
	}
	return s.parseWrite(r, c, raw)
}

// writeMethod is whether a request's method carries a body src/daemon.ts reads.
func writeMethod(method string) bool {
	return method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch || method == http.MethodDelete
}

// resolveBody is src/daemon.ts handler's body step, before any relay or route: it reads a write's body once, refuses
// one that isn't JSON, and an agent's or the OpenCode server's that isn't an object, then resolves its identity fields
// (resolveActors) and puts the resolved body back for the route to read. A peer's own call is trusted as it is unless
// it carries an agent's token (`if (!local || caller.kind === 'agent') resolveActors`), and its body is left unread.
//
// Only the top level is written back: each member once, as JSON.parse keeps a repeated key (its first place, its last
// value), with by, from and self resolved and every other value as sent, so a route reads what TS's route reads and a
// number such as 1e400 reaches it as it was sent.
func (s *Server) resolveBody(r *http.Request, c auth.Resolved) error {
	// A voice clip is binary: its route reads the request itself (src/voice.ts).
	if !writeMethod(r.Method) || r.URL.Path == "/api/voice/transcribe" {
		return nil
	}
	resolve := !c.Local || c.Kind == auth.Agent
	if !resolve && !c.IsAgent() {
		return nil
	}
	raw, err := readBody(r)
	if err != nil {
		return err
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	// A fixed message: a parse error may quote the input, which may hold a secret (S-2114).
	if len(raw) > 0 && !json.Valid(raw) {
		return Errorf(http.StatusBadRequest, "the request body is not valid JSON")
	}
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	isObj := len(raw) == 0 || trimmed[0] == '{'
	// A write from an agent or the OpenCode server is a JSON object: any other JSON has no identity to check.
	if c.IsAgent() && !isObj {
		return Errorf(http.StatusBadRequest, "the request body must be a JSON object")
	}
	if !isObj || !resolve {
		return nil
	}
	var ms []bodyMember
	if len(raw) > 0 {
		if ms, err = members(raw); err != nil {
			return Errorf(http.StatusBadRequest, "the request body is not valid JSON")
		}
	}
	ids := jsjson.NewObject()
	for _, m := range ms {
		if actorKey(m.key) {
			v, err := jsjson.Parse(m.val)
			if err != nil {
				return Errorf(http.StatusBadRequest, "the request body is not valid JSON")
			}
			ids.Set(m.key, v)
		}
	}
	if err := s.resolveActors(r, c, ids); err != nil {
		return err
	}
	var out bytes.Buffer
	var key strings.Builder
	put := func(k string, v []byte) {
		if out.Len() > 0 {
			out.WriteByte(',')
		} else {
			out.WriteByte('{')
		}
		key.Reset()
		jsjson.Quote(&key, k)
		out.WriteString(key.String())
		out.WriteByte(':')
		out.Write(v)
	}
	seen := map[string]bool{}
	for _, m := range ms {
		seen[m.key] = true
		if actorKey(m.key) {
			v, _ := ids.Get(m.key)
			put(m.key, []byte(jsjson.Stringify(v, "")))
			continue
		}
		put(m.key, m.val)
	}
	// The identity fields resolveActors added go last, as `body[k] = v` adds them.
	for _, k := range ids.Keys() {
		if !seen[k] {
			v, _ := ids.Get(k)
			put(k, []byte(jsjson.Stringify(v, "")))
		}
	}
	if out.Len() == 0 {
		out.WriteByte('{')
	}
	out.WriteByte('}')
	r.Body = io.NopCloser(bytes.NewReader(out.Bytes()))
	r.ContentLength = int64(out.Len())
	return nil
}

// actorKey is whether a body member is an identity field resolveActors resolves.
func actorKey(k string) bool { return k == "by" || k == "from" || k == "self" }

// bodyMember is one top-level member of a JSON object, its value as sent.
type bodyMember struct {
	key string
	val json.RawMessage
}

// members is a valid JSON object's top-level members as JSON.parse keeps them: a repeated key keeps its first place
// and takes its last value.
func members(raw []byte) ([]bodyMember, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	var out []bodyMember
	at := map[string]int{}
	for dec.More() {
		t, err := dec.Token()
		if err != nil {
			return nil, err
		}
		k, _ := t.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		if i, ok := at[k]; ok {
			out[i].val = v
			continue
		}
		at[k] = len(out)
		out = append(out, bodyMember{k, v})
	}
	return out, nil
}

// readBody reads a request's body, bounded.
func readBody(r *http.Request) ([]byte, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, maxBody))
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		return nil, Errorf(http.StatusRequestEntityTooLarge, "the request body is too large")
	}
	return raw, err
}

// parseWrite parses a body read by readBody, whose identity fields resolveBody has resolved.
func (s *Server) parseWrite(r *http.Request, c auth.Resolved, raw []byte) (write, error) {
	var body jsjson.Value = jsjson.NewObject()
	if len(raw) > 0 {
		// A fixed message: a parse error may quote the input, which may hold a secret (S-2114).
		var err error
		if body, err = jsjson.Parse(raw); err != nil {
			return write{}, Errorf(http.StatusBadRequest, "the request body is not valid JSON")
		}
	}
	obj, isObj := body.(*jsjson.Object)
	// A write from an agent or the OpenCode server is a JSON object: any other JSON has no identity to check.
	if c.IsAgent() && !isObj {
		return write{}, Errorf(http.StatusBadRequest, "the request body must be a JSON object")
	}
	return write{body: obj, human: s.isHuman(r, c), local: c.Local}, nil
}

// opencodeNamed is the routes ported here whose path names the agent for the OpenCode server (src/agent-routes.ts
// opencodeNamesAgent), plus its hook and status-line reports: none of the ported agent routes is an `acting` write.
var opencodeNamed = regexp.MustCompile(`^/api/(hook|statusline)/`)

// bodyNamesAgent is the writes that name their agent in the body as `agent`, checked in their routes.
var bodyNamesAgent = regexp.MustCompile(`^POST /api/(steps/check|permissions)$`)

// resolveActors is src/daemon.ts resolveActors for a body: `by`, `from` and `self` become the identity the caller may
// act as, and an agent's own token names itself in all three. The OpenCode server must name its agent.
func (s *Server) resolveActors(r *http.Request, c auth.Resolved, body *jsjson.Object) error {
	keys := []string{"by", "from", "self"}
	// A route that names its agent in the path, the hook and status-line reports, and a tool check or permission request
	// (which name theirs as `agent`) need no identity in the body.
	if c.Kind == auth.OpenCode && !opencodeNamed.MatchString(r.URL.Path) && !opencodeNamesAgent(r.Method, r.URL.Path) && !bodyNamesAgent.MatchString(r.Method+" "+r.URL.Path) {
		named := false
		for _, k := range keys {
			if _, ok := body.Get(k); ok {
				named = true
			}
		}
		if !named {
			return Errorf(http.StatusForbidden, "the OpenCode server's request must name its agent (by, from, or self)")
		}
	}
	for _, k := range keys {
		v, ok := body.Get(k)
		if !ok && c.Kind != auth.Agent {
			continue
		}
		claim := ""
		if v != nil {
			claim = claude.JSString(v)
		}
		id, err := s.actor(r.Context(), c.Caller, claim)
		if err != nil {
			return err
		}
		if id != "" {
			body.Set(k, id)
		}
	}
	if c.Kind == auth.OpenCode {
		var named jsjson.Value
		for _, k := range keys {
			if v, ok := body.Get(k); ok && v != nil {
				named = v
				break
			}
		}
		if named != nil {
			for _, k := range keys {
				if v, _ := body.Get(k); v == nil {
					body.Set(k, named)
				}
			}
		}
	}
	return nil
}

// mustAgent is src/daemon.ts mustAgent: the agent by id or name, else a 404.
func (s *Server) mustAgent(ctx context.Context, ref string) (db.Agent, error) {
	a, err := s.db.GetAgent(ctx, ref)
	if errors.Is(err, db.ErrNotFound) {
		return db.Agent{}, Errorf(http.StatusNotFound, "no agent %s", ref)
	}
	return a, err
}

// resolveQuery is the end of src/daemon.ts resolveActors: the `as` query names the viewer, and becomes the identity the
// caller may act as (an agent's own token is itself, the OpenCode server must name an OpenCode agent). The other pairs are
// written back as URLSearchParams.set does, in their order, with the first `as` replaced and any other dropped. The `by`
// query is a grouping on some routes, so each route that reads it as an actor checks it.
func (s *Server) resolveQuery(r *http.Request, c auth.Resolved) error {
	if c.Local && c.Kind != auth.Agent {
		return nil
	}
	if r.URL.RawQuery == "" {
		return nil
	}
	type pair struct{ k, v string }
	var pairs []pair
	as, has := "", false
	for _, part := range strings.Split(r.URL.RawQuery, "&") {
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		k, err1 := neturl.QueryUnescape(k)
		v, err2 := neturl.QueryUnescape(v)
		if err1 != nil || err2 != nil {
			// URLSearchParams keeps what it cannot decode as it is.
			k, v, _ = strings.Cut(part, "=")
		}
		if k == "as" {
			if !has {
				as, has = v, true
				pairs = append(pairs, pair{k, ""})
			}
			continue
		}
		pairs = append(pairs, pair{k, v})
	}
	if !has {
		return nil
	}
	id, err := s.actor(r.Context(), c.Caller, as)
	if err != nil {
		return err
	}
	var b strings.Builder
	for i, p := range pairs {
		if i > 0 {
			b.WriteByte('&')
		}
		v := p.v
		if p.k == "as" {
			v = id
		}
		b.WriteString(neturl.QueryEscape(p.k) + "=" + neturl.QueryEscape(v))
	}
	r.URL.RawQuery = b.String()
	return nil
}
