package main

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"stam/internal/client"
	"stam/internal/jsjson"
)

// mcpProxy is `stam mcp-proxy NAME` (src/mcp-proxy.ts): a stdio MCP server that bridges to a remote streamable-HTTP MCP
// server, adding the bearer the daemon holds for NAME. Every adapter writes an `auth` server as this command, so one
// login serves every harness and the token never reaches a harness config, the environment or a command line.
//
// Newline-delimited JSON-RPC arrives on stdin; each message is POSTed to the server and its JSON or SSE answer is written
// back as one line per message, one message at a time, so the initialize handshake and its session id land first. The
// server's Mcp-Session-Id is kept once it gives one. A 401 asks the daemon for a refreshed token once and retries.
func mcpProxy(ctx context.Context, args []string, e env) error {
	name := ""
	if len(args) > 0 {
		name = args[0]
	}
	p := &proxy{
		name:   name,
		agent:  e.getenv("STAM_AGENT_ID"),
		daemon: client.New(e.getenv),
		out:    e.stdout,
		// A redirect is never followed: the bearer must reach the configured server itself.
		http: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
	in := bufio.NewReader(e.stdin)
	for {
		// A line ends with its newline, as MCP's stdio framing has it: a last line without one is cut short, and is
		// dropped, as TS drops it.
		line, err := in.ReadString('\n')
		if err == nil && strings.TrimSpace(line) != "" {
			if msg, perr := jsjson.Parse([]byte(line)); perr == nil {
				p.handle(ctx, msg)
			}
		}
		if err != nil {
			return nil
		}
	}
}

type proxy struct {
	name, agent string
	daemon      *client.Client
	http        *http.Client
	out         io.Writer

	cred    *proxyCred
	session string
}

type proxyCred struct {
	url, token string
	expiresAt  *float64
}

func (p *proxy) writeLine(line string) { fmt.Fprintln(p.out, line) }

// credential is the bearer and url, from the daemon when there is none yet, it is within a minute of expiry, or
// refresh is set.
func (p *proxy) credential(ctx context.Context, refresh bool) (*proxyCred, error) {
	if !refresh && p.cred != nil && (p.cred.expiresAt == nil || float64(time.Now().UnixMilli()) < *p.cred.expiresAt-60_000) {
		return p.cred, nil
	}
	q := "agent=" + url.QueryEscape(p.agent)
	if refresh {
		q += "&refresh=1"
	}
	raw, err := p.daemon.Do(ctx, "GET", "/api/mcp/"+url.PathEscape(p.name)+"/token?"+q, nil, 0)
	if err != nil {
		return nil, err
	}
	v, err := jsjson.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("the daemon's reply isn't JSON")
	}
	o, _ := v.(*jsjson.Object)
	u, _ := o.Get("url")
	t, _ := o.Get("token")
	c := &proxyCred{url: jsjson.ToString(u), token: jsjson.ToString(t)}
	if x, _ := o.Get("expires_at"); x != nil {
		if n, ok := x.(float64); ok {
			c.expiresAt = &n
		}
	}
	p.cred = c
	return c, nil
}

func (p *proxy) post(ctx context.Context, msg jsjson.Value, c *proxyCred) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.url, strings.NewReader(jsjson.Stringify(msg, "")))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")
	req.Header.Set("authorization", "Bearer "+c.token)
	if p.session != "" {
		req.Header.Set("mcp-session-id", p.session)
	}
	return p.http.Do(req)
}

// handle forwards one message; an error answers a request (one with an id) as a JSON-RPC error.
func (p *proxy) handle(ctx context.Context, msg jsjson.Value) {
	o, _ := msg.(*jsjson.Object)
	id, hasID := o.Get("id")
	fail := func(text string) {
		if hasID {
			e := jsjson.NewObject("jsonrpc", "2.0", "id", id, "error", jsjson.NewObject("code", float64(-32000), "message", text))
			p.writeLine(jsjson.Stringify(e, ""))
		}
	}
	if err := p.forward(ctx, msg, fail); err != nil {
		fail(err.Error())
	}
}

func (p *proxy) forward(ctx context.Context, msg jsjson.Value, fail func(string)) error {
	c, err := p.credential(ctx, false)
	if err != nil {
		return err
	}
	res, err := p.post(ctx, msg, c)
	if err != nil {
		return err
	}
	if res.StatusCode == http.StatusUnauthorized {
		res.Body.Close()
		if c, err = p.credential(ctx, true); err != nil {
			return err
		}
		if res, err = p.post(ctx, msg, c); err != nil {
			return err
		}
	}
	defer res.Body.Close()
	if sid := res.Header.Get("mcp-session-id"); sid != "" {
		p.session = sid
	}
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		detail := ""
		if len(body) > 0 {
			u := utf16.Encode([]rune(string(body)))
			if len(u) > 200 {
				u = u[:200]
			}
			detail = " " + string(utf16.Decode(u))
		}
		fail(fmt.Sprintf("MCP server %s: HTTP %d%s", p.name, res.StatusCode, detail))
		return nil
	}
	p.emit(res, body)
	return nil
}

var sseBlock = regexp.MustCompile(`\r?\n\r?\n`)
var sseLine = regexp.MustCompile(`\r?\n`)

// emit writes a response body: a JSON message as one line, an SSE stream as one line per data message. A 202 (a
// notification) has nothing to write.
func (p *proxy) emit(res *http.Response, body []byte) {
	if res.StatusCode == http.StatusAccepted || len(bytes.TrimSpace(body)) == 0 {
		return
	}
	text := string(body)
	if strings.Contains(res.Header.Get("content-type"), "text/event-stream") {
		for _, block := range sseBlock.Split(text, -1) {
			var data []string
			for _, l := range sseLine.Split(block, -1) {
				if strings.HasPrefix(l, "data:") {
					data = append(data, jsjson.Trim(l[5:]))
				}
			}
			if d := strings.Join(data, "\n"); d != "" {
				p.writeLine(d)
			}
		}
		return
	}
	t := jsjson.Trim(text)
	if v, err := jsjson.Parse([]byte(t)); err == nil {
		p.writeLine(jsjson.Stringify(v, ""))
		return
	}
	p.writeLine(t)
}
