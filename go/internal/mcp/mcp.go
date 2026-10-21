// Package mcp is `stam mcp` in Go (S-2817): the stdio MCP server every agent talks to, src/mcp.ts's protocol layer. It
// is a thin process; all logic lives in the daemon. Messages are newline-delimited JSON-RPC 2.0, written as
// JSON.stringify writes them, so the harness and the fake Claude Code (test/fake-claude/claude) see the same bytes.
//
// Ported: initialize (with the claude/channel capability), tools/list and tools/call with the decision-steps check
// (POST /api/steps/check, 8 s, a 403 withholds the call), the tools `whoami` and `register`, and the SSE bridge from
// GET /api/agents/ID/stream to notifications/claude/channel. Every other tool answers `unknown tool NAME` until it is
// ported.
//
// Not ported: followDeploys and the exec onto a newer release (a Go release is switched by the deploy, not by the
// process), the requirements-gated tools, and the test-only tools of a home's test-faults.json (S-2596).
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

const (
	// StepsCheckTimeout is the budget of the decision-steps check before a tool call (src/mcp.ts checkStep).
	StepsCheckTimeout = 8 * time.Second
	defaultProtocol   = "2025-06-18"
	reconnectEvery    = 2 * time.Second
	// SessionEnv and CanaryEnv carry a session from the TS process that exec'd into this one (src/mcp.ts reexec): the
	// harness sent `initialize` to that process once and won't again.
	SessionEnv = "STAM_MCP_SESSION"
	CanaryEnv  = "STAM_MCP_CANARY"
)

// Server is one `stam mcp` process.
type Server struct {
	in     io.Reader
	out    io.Writer
	errw   io.Writer
	getenv func(string) string
	cwd    func() (string, error)
	// instructions is the text of the mcp-instructions template, sent with initialize.
	instructions string

	api *client.Client

	outMu sync.Mutex

	mu      sync.Mutex
	agentID string
	// overlay holds what `register` sets (STAM_TOKEN, STAM_AGENT_ID): later calls read it before the real environment.
	overlay map[string]string

	// acks is the read_mail batch each agent last got a reply to, loaded from the environment at first use.
	acks map[string]string

	streamOnce sync.Once
	streamCtx  context.Context
	inflight   sync.WaitGroup
}

// Options are what Run reads from outside.
type Options struct {
	In     io.Reader
	Out    io.Writer
	Err    io.Writer
	Getenv func(string) string
	Cwd    func() (string, error)
	// Instructions overrides the template lookup (tests).
	Instructions *string
	// Exe is this program's path, from which the repo or release root (with templates/) is found.
	Exe string
}

// New makes a server. Run starts it.
func New(o Options) *Server {
	s := &Server{in: o.In, out: o.Out, errw: o.Err, getenv: o.Getenv, cwd: o.Cwd, overlay: map[string]string{}}
	s.agentID = o.Getenv("STAM_AGENT_ID")
	s.api = client.New(s.env)
	s.api.MCP = true
	if o.Instructions != nil {
		s.instructions = *o.Instructions
	} else {
		s.instructions = Template(o.Getenv, o.Exe, "mcp-instructions")
	}
	return s
}

// env is the environment with what `register` set laid over it.
func (s *Server) env(k string) string {
	s.mu.Lock()
	v, ok := s.overlay[k]
	s.mu.Unlock()
	if ok {
		return v
	}
	return s.getenv(k)
}

func (s *Server) id() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.agentID
}

// Template is src/templates.ts template for a whole-file template: STAM_HOME/templates/NAME.md, else the root's
// templates/NAME.md. The root is STAM_ROOT, else the nearest folder above the program that holds templates/NAME.md (a
// checkout's go/bin/stam, a release's bin/stam). A missing template is the empty text.
func Template(getenv func(string) string, exe, name string) string {
	file := name + ".md"
	dirs := []string{filepath.Join(client.Home(getenv), "templates")}
	if root := getenv("STAM_ROOT"); root != "" {
		dirs = append(dirs, filepath.Join(root, "templates"))
	} else if exe != "" {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		for d := filepath.Dir(exe); ; d = filepath.Dir(d) {
			dirs = append(dirs, filepath.Join(d, "templates"))
			if filepath.Dir(d) == d {
				break
			}
		}
	}
	for _, d := range dirs {
		if b, err := os.ReadFile(filepath.Join(d, file)); err == nil {
			return string(b)
		}
	}
	return ""
}

// send writes one message: JSON on a line of its own.
func (s *Server) send(msg string) {
	s.outMu.Lock()
	defer s.outMu.Unlock()
	io.WriteString(s.out, msg+"\n")
}

// Run reads requests from stdin until it closes, each handled on its own goroutine as the TS server does, and returns
// when stdin ends (the harness is gone).
func (s *Server) Run(ctx context.Context) error {
	canary := s.getenv(CanaryEnv) != ""
	s.streamCtx = ctx
	if raw := s.getenv(SessionEnv); raw != "" && !canary {
		// Taking over a session from the process this one replaced: no initialize will come.
		if _, err := jsfmt.Parse([]byte(raw)); err == nil {
			s.startStream()
			s.send(`{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}`)
		}
	}
	r := bufio.NewReaderSize(s.in, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			if m, perr := jsfmt.Parse(bytes.TrimSpace(line)); perr == nil {
				s.inflight.Add(1)
				go func() {
					defer s.inflight.Done()
					s.handle(ctx, m)
				}()
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

// idJSON is the request id as JSON, or "" for a notification.
func idJSON(m jsfmt.Value) string {
	if id, ok := m.Get("id"); ok {
		return jsfmt.Compact(id)
	}
	return ""
}

// reply answers a request. A request with no id is answered without one, as JSON.stringify leaves out an undefined id.
func (s *Server) reply(id, result string) {
	if id == "" {
		s.send(`{"jsonrpc":"2.0","result":` + result + `}`)
		return
	}
	s.send(`{"jsonrpc":"2.0","id":` + id + `,"result":` + result + `}`)
}

func (s *Server) handle(ctx context.Context, m jsfmt.Value) {
	id := idJSON(m)
	method := m.Text("method")
	switch method {
	case "initialize":
		proto := defaultProtocol
		if p, ok := m.Get("params"); ok {
			if v, ok := p.Get("protocolVersion"); ok && v.Kind == jsfmt.String {
				proto = v.Str
			}
		}
		s.reply(id, `{"protocolVersion":`+jsfmt.Quote(proto)+
			`,"capabilities":{"tools":{"listChanged":true},"experimental":{"claude/channel":{}}},"serverInfo":{"name":"stam","version":"0.1.0"},"instructions":`+
			jsfmt.Quote(s.instructions)+`}`)
		s.startStream()
	case "tools/list":
		s.reply(id, `{"tools":`+toolList()+`}`)
	case "tools/call":
		s.reply(id, s.call(ctx, m))
	default:
		if id != "" && method != "" {
			s.reply(id, `{}`)
		}
	}
}

// textResult is {content:[{type:'text',text}]}, with isError when asked.
func textResult(text string, isError bool) string {
	r := `{"content":[{"type":"text","text":` + jsfmt.Quote(text) + `}]`
	if isError {
		r += `,"isError":true`
	}
	return r + `}`
}

// call runs one tools/call: the tool's result, or an isError result for an unknown tool, a refusal and any failure.
func (s *Server) call(ctx context.Context, m jsfmt.Value) string {
	params, _ := m.Get("params")
	name := params.Text("name")
	tool := findTool(name)
	if tool == nil {
		shown := "undefined"
		if n, ok := params.Get("name"); ok {
			shown = displayName(n)
		}
		return textResult("Error: unknown tool "+shown, true)
	}
	args := jsfmt.Value{Kind: jsfmt.Object}
	if a, ok := params.Get("arguments"); ok && a.Kind != jsfmt.Null {
		args = a
	}
	if args.Kind != jsfmt.Object {
		return textResult("Error: arguments must be an object", true)
	}
	if verdict := s.checkStep(ctx, tool.name, args); verdict != nil && !verdict.allow {
		return textResult(verdict.error, true)
	}
	text, err := tool.run(ctx, s, args)
	if err != nil {
		return textResult("Error: "+err.Error(), true)
	}
	return textResult(text, false)
}

func displayName(v jsfmt.Value) string {
	if v.Kind == jsfmt.String {
		return v.Str
	}
	return jsfmt.Inspect(v)
}

type verdict struct {
	allow bool
	error string
}

// checkStep is the decision steps' check of a tool call, before it runs (src/mcp.ts checkStep). A 403 withholds the
// call: enforcement fails closed. Any other failure (daemon down, timeout, a reply with no verdict, another status) lets
// the tool run and says so on stderr. A caller with no id (before `register`) has none to check against, so its calls
// run unchecked.
func (s *Server) checkStep(ctx context.Context, tool string, args jsfmt.Value) *verdict {
	agent := s.id()
	if agent == "" {
		agent = args.Text("self")
	}
	if agent == "" {
		return nil
	}
	body := jsfmt.Value{Kind: jsfmt.Object, Keys: []string{"agent", "tool", "args"}, Items: []jsfmt.Value{{Kind: jsfmt.String, Str: agent}, {Kind: jsfmt.String, Str: tool}, args}}
	reply, err := s.api.Do(ctx, "POST", "/api/steps/check", raw(body), StepsCheckTimeout)
	if err == nil {
		var v jsfmt.Value
		if v, err = jsfmt.Parse(reply); err == nil {
			allow, ok := v.Get("allow")
			if !ok || allow.Kind != jsfmt.Bool {
				err = errors.New("no verdict in the reply")
			} else {
				out := &verdict{allow: allow.Bool}
				if e := v.Text("error"); e != "" {
					out.error = e
				}
				if !out.allow && out.error == "" {
					out.error = "Denied by a decision step: " + tool
				}
				return out
			}
		}
	}
	var ae *client.Error
	if errors.As(err, &ae) && ae.Status == 403 {
		return &verdict{allow: false, error: fmt.Sprintf("Refused: decision steps can't check %s: %s", tool, err)}
	}
	fmt.Fprintf(s.errw, "stam: decision steps could not check %s, running it anyway: %v\n", tool, err)
	return nil
}

// raw lets a parsed value go into a request body as itself, key order kept.
type raw jsfmt.Value

func (j raw) MarshalJSON() ([]byte, error) { return []byte(jsfmt.Compact(jsfmt.Value(j))), nil }

// Wait returns when the requests in flight have been answered.
func (s *Server) Wait() { s.inflight.Wait() }
