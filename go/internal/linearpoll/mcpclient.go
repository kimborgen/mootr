package linearpoll

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"stam/internal/jsjson"
	"stam/internal/mcpauth"
)

// The MCP client the Linear poller calls a remote server's tools with (src/sources/mcp-client.ts, S-56): the
// streamable-HTTP transport, `initialize`, `notifications/initialized` and `tools/call`. The bearer comes from the
// daemon's own login store (mcpauth), so no harness and no command line ever holds it. Redirects are never followed, and
// one 401 asks for a refreshed token and retries. The only caller is the Linear poller (the TS client had no other).
//
// A trust boundary: the bearer is sent in the one header of each request, and no error this client returns, and no log
// line, carries it: every error text is scrubbed of the token that call used, including text a server echoed back.

// requestTimeout is how long one request to the server may take, the answer's body included.
const requestTimeout = 20 * time.Second

// Bearers is what the client asks for a server's bearer and url (mcpauth.Auth.TokenFor). force asks for a refreshed token.
type Bearers interface {
	TokenFor(ctx context.Context, name string, force bool) (mcpauth.Bearer, error)
}

// Client is an MCP client. It is safe for concurrent use; a server's session is made once.
type Client struct {
	auth Bearers
	http *http.Client

	// mu guards sessions, and is held across a server's initialize so two calls don't both make a session.
	mu sync.Mutex
	// sessions is the Mcp-Session-Id each server gave, by name; "" is a server that runs sessionless. Absent until initialized.
	sessions map[string]string
	nextID   atomic.Int64
}

// NewClient is a client on auth. hc is the HTTP client to copy (nil for a default one); the copy follows no redirect and
// times out a request at 20 s.
func NewClient(auth Bearers, hc *http.Client) *Client {
	var c http.Client
	if hc != nil {
		c = *hc
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if c.Timeout == 0 {
		c.Timeout = requestTimeout
	}
	cl := &Client{auth: auth, http: &c, sessions: map[string]string{}}
	cl.nextID.Store(1)
	return cl
}

// ResetSessions forgets every session, so the next call initializes again (tests).
func (c *Client) ResetSessions() {
	c.mu.Lock()
	c.sessions = map[string]string{}
	c.mu.Unlock()
}

// scrub is msg without token, wherever a server or the transport put it.
func scrub(msg, token string) string {
	if token == "" {
		return msg
	}
	return strings.ReplaceAll(msg, token, "[redacted]")
}

func (c *Client) post(ctx context.Context, url, token string, body any, sid string) (*http.Response, error) {
	raw := jsjson.Stringify(body, "")
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader([]byte(raw)))
	if err != nil {
		return nil, errors.New(scrub(errText(err), token))
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")
	req.Header.Set("authorization", "Bearer "+token)
	if sid != "" {
		req.Header.Set("mcp-session-id", sid)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, errors.New(scrub(errText(err), token))
	}
	return res, nil
}

// errText is a transport error's text without the request url, which a *url.Error repeats.
func errText(err error) string {
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) && ue.Unwrap() != nil {
		return ue.Unwrap().Error()
	}
	return err.Error()
}

// answer is the JSON-RPC message for id: a JSON body, or the SSE data block that carries it.
func answer(res *http.Response, id int64) (*jsjson.Object, error) {
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, errors.New(errText(err))
	}
	if strings.Contains(res.Header.Get("content-type"), "text/event-stream") {
		for _, block := range regexp.MustCompile(`\r?\n\r?\n`).Split(string(text), -1) {
			var data []string
			for _, l := range regexp.MustCompile(`\r?\n`).Split(block, -1) {
				if strings.HasPrefix(l, "data:") {
					data = append(data, jsjson.Trim(l[5:]))
				}
			}
			joined := strings.Join(data, "\n")
			if joined == "" {
				continue
			}
			v, err := jsjson.Parse([]byte(joined))
			if err != nil {
				continue
			}
			if o, ok := v.(*jsjson.Object); ok {
				if mid, _ := o.Get("id"); mid == float64(id) {
					return o, nil
				}
			}
		}
		return nil, errors.New("no answer in the event stream")
	}
	v, err := jsjson.Parse(text)
	if err != nil {
		return nil, errors.New("the answer is not JSON")
	}
	o, ok := v.(*jsjson.Object)
	if !ok {
		return nil, errors.New("the answer is not a JSON object")
	}
	return o, nil
}

func rpcMessage(o *jsjson.Object, def string) string {
	e, ok := o.Get("error")
	if !ok || e == nil {
		return def
	}
	if eo, ok := e.(*jsjson.Object); ok {
		if m, ok := eo.Get("message"); ok && m != nil {
			return jsjson.ToString(m)
		}
	}
	return def
}

func hasError(o *jsjson.Object) bool {
	e, _ := o.Get("error")
	return jsjson.Truthy(e)
}

// initialize makes a session with a server. A server without a session id runs sessionless. c.mu is held.
func (c *Client) initialize(ctx context.Context, name, url, token string) (string, error) {
	id := c.nextID.Add(1) - 1
	body := jsjson.NewObject("jsonrpc", "2.0", "id", float64(id), "method", "initialize", "params",
		jsjson.NewObject("protocolVersion", "2025-06-18", "capabilities", jsjson.NewObject(), "clientInfo", jsjson.NewObject("name", "stam", "version", "1")))
	res, err := c.post(ctx, url, token, body, "")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", fmt.Errorf("%s: initialize HTTP %d", name, res.StatusCode)
	}
	sid := res.Header.Get("mcp-session-id")
	msg, err := answer(res, id)
	if err != nil {
		return "", err
	}
	if hasError(msg) {
		return "", errors.New(scrub(name+": initialize: "+rpcMessage(msg, "error"), token))
	}
	// The initialized notification has no answer; a 202 is the normal reply. Its failure is not the session's.
	if nr, err := c.post(ctx, url, token, jsjson.NewObject("jsonrpc", "2.0", "method", "notifications/initialized"), sid); err == nil {
		_, _ = io.Copy(io.Discard, nr.Body)
		nr.Body.Close()
	}
	c.sessions[name] = sid
	return sid, nil
}

// session is the server's session id, made if it has none.
func (c *Client) session(ctx context.Context, name, url, token string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if sid, ok := c.sessions[name]; ok {
		return sid, nil
	}
	return c.initialize(ctx, name, url, token)
}

// CallTool calls one tool on the named MCP server and returns its `result` (its content holds the text the tool answered
// with). It returns an error when the server, its login, or the tool fails. ctx bounds the whole call; each request
// also times out at 20 s.
func (c *Client) CallTool(ctx context.Context, name, tool string, args *jsjson.Object) (*jsjson.Object, error) {
	for attempt := 0; ; attempt++ {
		cred, err := c.auth.TokenFor(ctx, name, attempt > 0)
		if err != nil {
			return nil, err
		}
		res, err := c.callOnce(ctx, name, tool, args, cred, attempt)
		var retry errRetry
		if errors.As(err, &retry) {
			continue
		}
		return res, err
	}
}

type errRetry struct{}

func (errRetry) Error() string { return "retry" }

func (c *Client) callOnce(ctx context.Context, name, tool string, args *jsjson.Object, cred mcpauth.Bearer, attempt int) (*jsjson.Object, error) {
	fail := func(format string, a ...any) error {
		return errors.New(scrub(fmt.Sprintf(format, a...), cred.Token))
	}
	sid, err := c.session(ctx, name, cred.URL, cred.Token)
	if err != nil {
		return nil, fail("%s", err.Error())
	}
	id := c.nextID.Add(1) - 1
	body := jsjson.NewObject("jsonrpc", "2.0", "id", float64(id), "method", "tools/call", "params", jsjson.NewObject("name", tool, "arguments", args))
	res, err := c.post(ctx, cred.URL, cred.Token, body, sid)
	if err != nil {
		return nil, fail("%s %s: %s", name, tool, err.Error())
	}
	defer res.Body.Close()
	// A 401 refreshes the token once; a 404 means the session expired, so it starts over once.
	if (res.StatusCode == 401 || res.StatusCode == 404) && attempt == 0 {
		_, _ = io.Copy(io.Discard, res.Body)
		if res.StatusCode == 404 {
			c.mu.Lock()
			delete(c.sessions, name)
			c.mu.Unlock()
		}
		return nil, errRetry{}
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &StatusError{Server: name, Tool: tool, Status: res.StatusCode}
	}
	msg, err := answer(res, id)
	if err != nil {
		return nil, fail("%s %s: %s", name, tool, err.Error())
	}
	if hasError(msg) {
		return nil, fail("%s %s: %s", name, tool, rpcMessage(msg, "error"))
	}
	r, _ := msg.Get("result")
	result, _ := r.(*jsjson.Object)
	if result != nil {
		if ie, _ := result.Get("isError"); jsjson.Truthy(ie) {
			t := TextOf(result)
			if t == "" {
				t = "the tool failed"
			}
			return nil, fail("%s %s: %s", name, tool, t)
		}
	}
	return result, nil
}

// StatusError is a server's HTTP answer that was not a success; its text names the status alone, never a header or a url.
type StatusError struct {
	Server, Tool string
	Status       int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("%s %s: HTTP %d", e.Server, e.Tool, e.Status)
}

// TextOf is the text of a tool result's text content, joined by newlines.
func TextOf(result *jsjson.Object) string {
	if result == nil {
		return ""
	}
	c, _ := result.Get("content")
	list, _ := c.([]jsjson.Value)
	var parts []string
	for _, item := range list {
		o, ok := item.(*jsjson.Object)
		if !ok {
			continue
		}
		t, _ := o.Get("type")
		text, _ := o.Get("text")
		if s, ok := text.(string); t == "text" && ok {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, "\n")
}

// JSONOf is the JSON a tool answered with, nil when its text isn't JSON.
func JSONOf(result *jsjson.Object) jsjson.Value {
	text := jsjson.Trim(TextOf(result))
	if text == "" {
		return nil
	}
	v, err := jsjson.Parse([]byte(text))
	if err != nil {
		return nil
	}
	return v
}
