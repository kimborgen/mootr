package mcpservers

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"

	"stam/internal/jsjson"
)

// Check is src/mcp-config.ts testServer: connect to one configured server and list its tools.

const protocol = "2025-06-18"

// CheckTimeout bounds a stdio server's answer and each request to a remote one.
var CheckTimeout = 5 * time.Second

func rpc(id int, method string, params jsjson.Value) *jsjson.Object {
	return jsjson.NewObject("jsonrpc", "2.0", "id", id, "method", method, "params", params)
}

func initialize(id int) *jsjson.Object {
	return rpc(id, "initialize", jsjson.NewObject("protocolVersion", protocol, "capabilities", jsjson.NewObject(),
		"clientInfo", jsjson.NewObject("name", "stam", "version", "2")))
}

var initialized = jsjson.NewObject("jsonrpc", "2.0", "method", "notifications/initialized")

// Token is the bearer of an MCP server with an auth (mcp-auth.ts token).
type Token func(ctx context.Context, name string) (string, error)

// Check is testServer: {ok, tools} with the server's tool names, or {ok: false, tools: [], error}. It never fails: the
// failure is the error the UI shows. client reaches a remote server and never follows a redirect, so the bearer only
// reaches the configured server; nil is such a client.
func Check(ctx context.Context, name string, server jsjson.Value, token Token, client *http.Client) *jsjson.Object {
	if client == nil {
		client = noRedirects()
	}
	var tools []any
	var err error
	switch {
	case truthy(prop(server, "url")):
		tools, err = checkRemote(ctx, name, server, token, client)
	case truthy(prop(server, "command")):
		tools, err = checkStdio(ctx, str(prop(server, "command")), server)
	default:
		err = errors.New("The server has no command or url.")
	}
	if err != nil {
		return jsjson.NewObject("ok", false, "tools", []any{}, "error", err.Error())
	}
	return jsjson.NewObject("ok", true, "tools", tools)
}

// rpcFailure is a JSON-RPC error answer as an error: its message, or fallback when it has none.
func rpcFailure(msg jsjson.Value, fallback string) error {
	e := prop(msg, "error")
	if !truthy(e) {
		return nil
	}
	if m := prop(e, "message"); truthy(m) {
		return errors.New(str(m))
	}
	return errors.New(fallback)
}

// toolNames is result.tools' names. TS's map throws on what isn't a list of tools; this says so plainly.
func toolNames(msg jsjson.Value) ([]any, error) {
	list := prop(prop(msg, "result"), "tools")
	if nullish(list) {
		return []any{}, nil
	}
	items, ok := list.([]any)
	if !ok {
		return nil, errors.New("tools/list answered no list of tools")
	}
	out := make([]any, len(items))
	for i, t := range items {
		if t == nil {
			return nil, errors.New("Cannot read properties of null (reading 'name')")
		}
		n, has := prop(t, "name"), false
		if o, ok := obj(t); ok {
			_, has = o.Get("name")
		}
		if !has {
			n = undefined{}
		}
		out[i] = str(n)
	}
	return out, nil
}

// spawnError is the message Node's spawn fails with: "spawn CMD ENOENT" for a missing command.
func spawnError(command string, err error) error {
	switch {
	case errors.Is(err, exec.ErrNotFound), errors.Is(err, fs.ErrNotExist):
		return fmt.Errorf("spawn %s ENOENT", command)
	case errors.Is(err, fs.ErrPermission):
		return fmt.Errorf("spawn %s EACCES", command)
	}
	return err
}

// stderrCap bounds what a stdio server's stderr can make the daemon hold.
const stderrCap = 1 << 20

type cappedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if room := stderrCap - c.buf.Len(); room > 0 {
		c.buf.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

func (c *cappedBuffer) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// checkStdio spawns a stdio server, initializes it and lists its tools. The server runs in its own process group,
// killed whole once the answer arrives or after CheckTimeout, so a grandchild (npx's node) goes too; its stdout is
// closed then, so the reader stops and reaps it even if something still holds the pipe. A server that exits first
// fails with its stderr, or its exit code.
func checkStdio(ctx context.Context, command string, server jsjson.Value) ([]any, error) {
	var args []string
	if list, ok := prop(server, "args").([]any); ok {
		for _, a := range list {
			args = append(args, str(a))
		}
	}
	cmd := exec.Command(command, args...)
	cmd.Env = os.Environ()
	if env, ok := obj(prop(server, "env")); ok {
		for _, k := range env.Keys() {
			v, _ := env.Get(k)
			cmd.Env = append(cmd.Env, k+"="+str(v))
		}
	}
	stderr := &cappedBuffer{}
	cmd.Stderr = stderr
	cmd.WaitDelay = 500 * time.Millisecond
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, spawnError(command, err)
	}
	type answer struct {
		tools []any
		err   error
	}
	done := make(chan answer, 1)
	go func() {
		r := bufio.NewReader(stdout)
		// An answer is sent before the child is reaped: it is killed once the answer is read.
		answered := func(a answer) {
			done <- a
			_ = cmd.Wait()
		}
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				break
			}
			if jsjson.Trim(line) == "" {
				continue
			}
			msg, perr := jsjson.Parse([]byte(line))
			if perr != nil {
				continue
			}
			id, _ := prop(msg, "id").(float64)
			if id == 1 {
				if err := rpcFailure(msg, "initialize failed"); err != nil {
					answered(answer{err: err})
					return
				}
			}
			if id == 2 {
				if err := rpcFailure(msg, "tools/list failed"); err != nil {
					answered(answer{err: err})
					return
				}
				tools, err := toolNames(msg)
				answered(answer{tools, err})
				return
			}
		}
		// stdout closed: the server exited, or will.
		_ = cmd.Wait()
		if msg := jsjson.Trim(stderr.String()); msg != "" {
			done <- answer{err: errors.New(msg)}
			return
		}
		code := "null"
		if st := cmd.ProcessState; st != nil && st.ExitCode() >= 0 {
			code = fmt.Sprint(st.ExitCode())
		}
		done <- answer{err: fmt.Errorf("the server exited (%s)", code)}
	}()
	go func() {
		// A server that exits at once fails these writes; its exit reports the failure.
		for _, m := range []*jsjson.Object{initialize(1), initialized, rpc(2, "tools/list", jsjson.NewObject())} {
			if _, err := io.WriteString(stdin, jsjson.Stringify(m, "")+"\n"); err != nil {
				return
			}
		}
	}()
	timer := time.NewTimer(CheckTimeout)
	defer timer.Stop()
	var a answer
	select {
	case a = <-done:
	case <-timer.C:
		a = answer{err: errors.New("No answer within 5 seconds.")}
	case <-ctx.Done():
		a = answer{err: ctx.Err()}
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	_ = cmd.Process.Kill()
	_ = stdin.Close()
	_ = stdout.Close()
	// The reader reaps the child: after its answer, or once its stdout closes.
	return a.tools, a.err
}

// sliceUTF16 is s.slice(0, n): the first n UTF-16 units.
func sliceUTF16(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}

var blankLine = regexp.MustCompile(`\r?\n\r?\n`)

// readMessage is one JSON-RPC message from an answer: the JSON body, or the first message with an id in an SSE stream.
// nil is none. TS's error for a JSON body that doesn't parse is V8's SyntaxError, which quotes the body; this one
// says only that.
func readMessage(text, contentType string) (jsjson.Value, error) {
	if strings.Contains(contentType, "text/event-stream") {
		for _, block := range blankLine.Split(text, -1) {
			var data []string
			for _, l := range lineBreak.Split(block, -1) {
				if rest, ok := strings.CutPrefix(l, "data:"); ok {
					data = append(data, jsjson.Trim(rest))
				}
			}
			joined := strings.Join(data, "\n")
			if joined == "" {
				continue
			}
			m, err := jsjson.Parse([]byte(joined))
			if o, ok := obj(m); err == nil && ok {
				if _, has := o.Get("id"); has {
					return m, nil
				}
			}
		}
		return nil, nil
	}
	t := jsjson.Trim(text)
	if t == "" {
		return nil, nil
	}
	m, err := jsjson.Parse([]byte(t))
	if err != nil {
		return nil, errors.New("the server's answer is not JSON")
	}
	return m, nil
}

// checkRemote initializes and lists tools on a remote server over streamable HTTP, with the stored bearer for a
// server with an auth.
func checkRemote(ctx context.Context, name string, server jsjson.Value, token Token, client *http.Client) ([]any, error) {
	target := str(prop(server, "url"))
	h := http.Header{}
	h.Set("content-type", "application/json")
	h.Set("accept", "application/json, text/event-stream")
	if headers, ok := obj(prop(server, "headers")); ok {
		for _, k := range headers.Keys() {
			v, _ := headers.Get(k)
			h.Set(k, str(v))
		}
	}
	if truthy(prop(server, "auth")) {
		bearer, err := token(ctx, name)
		if err != nil {
			return nil, err
		}
		h.Set("authorization", "Bearer "+bearer)
	}
	post := func(body jsjson.Value) (string, string, http.Header, error) {
		ctx, cancel := context.WithTimeout(ctx, CheckTimeout)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(jsjson.Stringify(body, "")))
		if err != nil {
			return "", "", nil, fetchError(err)
		}
		req.Header = h.Clone()
		res, err := client.Do(req)
		if err != nil {
			return "", "", nil, fetchError(err)
		}
		defer res.Body.Close()
		b, err := io.ReadAll(io.LimitReader(res.Body, maxAnswer))
		if err != nil {
			return "", "", nil, fetchError(err)
		}
		text := string(bytes.ToValidUTF8(b, []byte("�")))
		if res.StatusCode < 200 || res.StatusCode > 299 {
			return "", "", nil, errors.New(jsjson.Trim(fmt.Sprintf("HTTP %d %s", res.StatusCode, sliceUTF16(text, 160))))
		}
		return text, res.Header.Get("content-type"), res.Header, nil
	}
	text, ctype, headers, err := post(initialize(1))
	if err != nil {
		return nil, err
	}
	if session := headers.Get("mcp-session-id"); session != "" {
		h.Set("mcp-session-id", session)
	}
	first, err := readMessage(text, ctype)
	if err != nil {
		return nil, err
	}
	if err := rpcFailure(first, "initialize failed"); err != nil {
		return nil, err
	}
	if _, _, _, err := post(initialized); err != nil {
		return nil, err
	}
	text, ctype, _, err = post(rpc(2, "tools/list", jsjson.NewObject()))
	if err != nil {
		return nil, err
	}
	list, err := readMessage(text, ctype)
	if err != nil {
		return nil, err
	}
	if err := rpcFailure(list, "tools/list failed"); err != nil {
		return nil, err
	}
	return toolNames(list)
}
