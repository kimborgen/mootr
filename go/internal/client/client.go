// Package client is the CLI's HTTP client for the daemon, src/client.ts and src/config.ts readToken in Go (S-2803):
// the URL from STAM_URL or STAM_PORT, the token from STAM_TOKEN or STAM_HOME/token, the 10 s default timeout, the
// {error} envelope, and the x-stam-human header the CLI sends when it speaks for the human.
//
// The token lives in a config.Secret and goes into the Authorization header only: no error, log or String ever shows it.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"stam/internal/config"
	"stam/internal/jsfmt"
)

const (
	// DefaultTimeout is the timeout of a call that names none (src/client.ts api).
	DefaultTimeout = 10 * time.Second
	// WriteTimeout is for writes an agent might retry after a timeout: a mail waits on the daemon's mail check (S-1663).
	WriteTimeout = 60 * time.Second
	defaultPort  = "7878"
	// maxBody bounds what the client reads of a reply: no route answers more than this.
	maxBody = 64 << 20
)

// Client talks to one daemon.
type Client struct {
	// URL is the daemon's base URL without a trailing slash.
	URL string
	// MCP is `stam mcp` alone, whose calls act as the agent, so it sends no x-stam-human.
	MCP bool
	// getenv is read at each call: the token, and STAM_AGENT_ID (an agent's CLI acts as the agent, so it sends no
	// x-stam-human), can change while the process runs, as `register` sets both for an agent that joins late.
	getenv func(string) string
	http   *http.Client
}

// Error is a reply the daemon refused: its {error} text and status.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

// Home is STAM_HOME, or the live home when unset (the CLI reads it, as src/config.ts does).
func Home(getenv func(string) string) string {
	if h := getenv("STAM_HOME"); h != "" {
		return h
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".local", "share", "stam")
	}
	// src/default-home.ts: a real stam folder, else mootr (config.DefaultHome). A folder that can't be inspected is a path that fails to read.
	h, err := config.DefaultHome(userHome)
	if err != nil {
		return filepath.Join(userHome, ".local", "share", "mootr")
	}
	return h
}

// ReadToken is src/config.ts readToken: STAM_TOKEN, else the home's token file trimmed, else empty.
func ReadToken(getenv func(string) string) config.Secret {
	if t := getenv("STAM_TOKEN"); t != "" {
		return config.Secret(t)
	}
	b, err := os.ReadFile(filepath.Join(Home(getenv), "token"))
	if err != nil {
		return ""
	}
	return config.Secret(strings.TrimSpace(string(b)))
}

// BaseURL is STAM_URL, else http://127.0.0.1:STAM_PORT (7878).
func BaseURL(getenv func(string) string) string {
	if u := getenv("STAM_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	port := getenv("STAM_PORT")
	if port == "" {
		port = defaultPort
	}
	return "http://127.0.0.1:" + port
}

// New reads the URL from the environment. The token and the agent's identity are read at each call, so a token a daemon
// writes after the CLI starts, or one `register` sets, is used from then on (S-2817).
func New(getenv func(string) string) *Client {
	return &Client{
		URL:    BaseURL(getenv),
		getenv: getenv,
		http: &http.Client{Transport: &http.Transport{
			// A CLI call is one request to one daemon: no proxy (Node's fetch uses none either), no idle connection to leak.
			Proxy:             nil,
			DisableKeepAlives: true,
		}},
	}
}

// asSystem is src/client.ts asSystem: the calls a script makes as what it is, not as the human (S-601).
func asSystem(method, path string, body any) bool {
	// A body built as an ordered object (jsfmt.Value) names its members the same way.
	if o, ok := body.(jsfmt.Value); ok {
		m := map[string]any{}
		for _, k := range []string{"as_system", "system"} {
			if v, ok := o.Get(k); ok {
				m[k] = truthyValue(v)
			}
		}
		body = m
	}
	if m, ok := body.(map[string]any); ok {
		if v, ok := m["as_system"]; ok && truthy(v) && strings.HasPrefix(path, "/api/itsas") {
			return true
		}
		if v, ok := m["system"]; ok && truthy(v) && method == http.MethodPost && path == "/api/mail" {
			return true
		}
	}
	return method == http.MethodGet && systemRead.MatchString(path)
}

// truthyValue is a member's JS truthiness, as the decoded types truthy reads: true or false.
func truthyValue(v jsfmt.Value) any { return v.Truthy() }

var systemRead = regexp.MustCompile(`^/api/(health|agents|itsas/[\w-]+)(\?|$)`)

func truthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	}
	return true
}

// Do sends a JSON request and returns the reply's body. A non-2xx reply is an *Error carrying the envelope's text. A
// nil body sends none; a timeout of 0 is DefaultTimeout.
func (c *Client) Do(ctx context.Context, method, path string, body any, timeout time.Duration) ([]byte, error) {
	var raw []byte
	if body != nil {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(body); err != nil {
			return nil, fmt.Errorf("encode request: %w", err)
		}
		raw = bytes.TrimRight(buf.Bytes(), "\n")
	}
	human := c.getenv("STAM_AGENT_ID") == "" && !c.MCP && !asSystem(method, path, body)
	status, reply, err := c.Raw(ctx, method, path, raw, human, timeout)
	if err != nil {
		return nil, err
	}
	return reply, envelope(status, reply)
}

// envelope turns a refused reply into an *Error, as src/client.ts does: the {error} text, with the hint of a 403 (S-543),
// else "HTTP N".
func envelope(status int, reply []byte) error {
	if status >= 200 && status < 300 {
		return nil
	}
	var e struct {
		Error string `json:"error"`
		Hint  string `json:"hint"`
	}
	msg := fmt.Sprintf("HTTP %d", status)
	if json.Unmarshal(reply, &e) == nil && e.Error != "" {
		msg = e.Error
		if status == http.StatusForbidden && e.Hint != "" {
			msg += "; " + e.Hint
		}
	}
	return &Error{Status: status, Message: msg}
}

// Raw sends body as is (nil sends none) and returns the status and the reply, whatever the status. human adds
// x-stam-human. The hook path uses it, where the payload is the harness's own bytes.
func (c *Client) Raw(ctx context.Context, method, path string, body []byte, human bool, timeout time.Duration) (int, []byte, error) {
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.URL+path, rd)
	if err != nil {
		return 0, nil, errors.New("bad request URL")
	}
	req.Header.Set("Authorization", "Bearer "+ReadToken(c.getenv).Reveal())
	req.Header.Set("Content-Type", "application/json")
	if human {
		req.Header.Set("X-Stam-Human", "1")
	}
	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, transportError(err, timeout)
	}
	defer res.Body.Close()
	reply, err := io.ReadAll(io.LimitReader(res.Body, maxBody))
	if err != nil {
		return 0, nil, transportError(err, timeout)
	}
	return res.StatusCode, reply, nil
}

// ConnRefused is whether err is a refused connection: the daemon is down, so nothing took the request and it may be
// sent again. A timeout may mean the daemon took it, and is not this.
func ConnRefused(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }

// refused wraps a refused connection so errors.Is still finds it after the message is rewritten.
type refused struct{ msg string }

func (e *refused) Error() string        { return e.msg }
func (e *refused) Is(target error) bool { return target == syscall.ECONNREFUSED }

// transportError is err without the request URL or any header: the text is the cause only.
func transportError(err error, timeout time.Duration) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return fmt.Errorf("no answer within %s", timeout)
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return &refused{"connection refused"}
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return fmt.Errorf("no answer within %s", timeout)
	}
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		return errors.New(ue.Err.Error())
	}
	return errors.New("request failed")
}

// Stream opens a GET whose reply is read as it arrives (an event stream): no overall timeout, so the caller ends it
// by cancelling ctx. A non-2xx reply is an *Error. The caller closes the body.
func (c *Client) Stream(ctx context.Context, path string) (io.ReadCloser, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL+path, nil)
	if err != nil {
		return nil, errors.New("bad request URL")
	}
	req.Header.Set("Authorization", "Bearer "+ReadToken(c.getenv).Reveal())
	res, err := c.http.Do(req)
	if err != nil {
		return nil, transportError(err, 0)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		reply, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
		res.Body.Close()
		return nil, envelope(res.StatusCode, reply)
	}
	return res.Body, nil
}
