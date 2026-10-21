package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// The mail tools of src/mcp.ts (S-2824): list_inbox, read_mail and read_thread. Their text is built as the TS template
// literals build it.

func init() {
	tools = append(tools,
		tool{name: "list_inbox", listing: mailListings["list_inbox"], run: listInbox},
		tool{name: "read_mail", listing: mailListings["read_mail"], run: readMail},
		tool{name: "read_thread", listing: mailListings["read_thread"], run: readThread},
		tool{name: "send_mail", listing: mailListings["send_mail"], run: sendMail},
	)
}

// normalizeMailInput is src/mail-input.ts: the text may be `body`, `message` or `content`, one recipient a string; a mail
// with no text and no attachments is refused. The result is {...rest, to, body} with rest the input minus message and
// content, so a key keeps its place.
func normalizeMailInput(in jsfmt.Value) (jsfmt.Value, error) {
	found, text := false, ""
	for _, k := range []string{"body", "message", "content"} {
		if v, ok := in.Get(k); ok && v.Kind == jsfmt.String && strings.TrimSpace(v.Str) != "" {
			found, text = true, v.Str
			break
		}
	}
	if at, ok := in.Get("attachments"); !found && !(ok && at.Kind == jsfmt.Array && len(at.Items) > 0) {
		return jsfmt.Value{}, errors.New("body is required: the mail's text")
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range in.Keys {
		if k != "message" && k != "content" {
			out.Set(k, in.Items[i])
		}
	}
	if to, ok := in.Get("to"); ok {
		if to.Kind == jsfmt.String {
			to = jsfmt.ArrayValue([]jsfmt.Value{to})
		}
		out.Set("to", to)
	}
	out.Set("body", jsfmt.StringValue(text))
	return out, nil
}

// writeID is src/client.ts writeId: a stable id for a write, so a retried call is the same send (S-1663).
func writeID(parts ...jsfmt.Value) string {
	sum := sha256.Sum256([]byte(jsfmt.Compact(jsfmt.ArrayValue(parts))))
	return hex.EncodeToString(sum[:])[:32]
}

func sendMail(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	input, err := normalizeMailInput(args)
	if err != nil {
		return "", err
	}
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	get := func(k string) jsfmt.Value {
		if v, ok := input.Get(k); ok {
			return v
		}
		return jsfmt.NullValue()
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	for i, k := range input.Keys {
		if k != "self" {
			body.Set(k, input.Items[i])
		}
	}
	body.Set("from", jsfmt.StringValue(me))
	body.Set("client_id", jsfmt.StringValue(writeID(jsfmt.StringValue("mail"), jsfmt.StringValue(me), get("to"), get("subject"), get("body"),
		get("reply_to"), get("itsa"), get("new_thread"), get("supersedes"), get("attachments"))))
	reply, err := s.api.Do(ctx, "POST", "/api/mail", raw(body), client.WriteTimeout)
	if err != nil {
		return "", err
	}
	m, err := jsfmt.Parse(reply)
	if err != nil {
		return "", fmt.Errorf("the daemon's reply isn't JSON")
	}
	stopped, missed := "", ""
	if nr, ok := m.Get("not_running"); ok && nr.Kind == jsfmt.Array && len(nr.Items) > 0 {
		var names []string
		for _, n := range nr.Items {
			names = append(names, str(n, true))
		}
		stopped = " Not running: " + strings.Join(names, ", ") + "; the mail waits unread until resumed, so ask their parent or the chief of staff to resume them if it can't wait."
	}
	if truthyMember(m, "misses_human") {
		missed = " This answers your user's mail but doesn't reach them; add `human` to `to` if they should read it."
	}
	if truthyMember(m, "queued") {
		return fmt.Sprintf("Queued %s in thread %s: storage is unreachable; it is delivered when storage answers.%s%s", member(m, "id"), member(m, "thread_id"), stopped, missed), nil
	}
	sent := fmt.Sprintf("Sent %s in thread %s.", member(m, "id"), member(m, "thread_id"))
	if truthyMember(m, "reply_to") && !truthyMember(args, "reply_to") {
		sent = fmt.Sprintf("Sent %s as a reply in the thread \"%s\" (%s), since it answers %s. For a new topic, send with new_thread: true.", member(m, "id"), member(m, "subject"), member(m, "thread_id"), member(m, "reply_to"))
	}
	return sent + stopped + missed, nil
}

// str is how a JS template literal prints a JSON value: a string as is, null as "null", a number as JS prints it, a missing member as "undefined".
func str(v jsfmt.Value, ok bool) string {
	if !ok {
		return "undefined"
	}
	switch v.Kind {
	case jsfmt.String:
		return v.Str
	case jsfmt.Null:
		return "null"
	}
	return jsfmt.Compact(v)
}

func member(m jsfmt.Value, key string) string {
	v, ok := m.Get(key)
	return str(v, ok)
}

// truthyMember is a member's JS truthiness.
func truthyMember(m jsfmt.Value, key string) bool {
	v, ok := m.Get(key)
	return ok && v.Truthy()
}

func listInbox(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	id, err := s.me(args)
	if err != nil {
		return "", err
	}
	unread := "1"
	if u, ok := args.Get("unread_only"); ok && u.Kind == jsfmt.Bool && !u.Bool {
		unread = "0"
	}
	limit := "20"
	if l, ok := args.Get("limit"); ok && l.Kind != jsfmt.Null {
		limit = str(l, true)
	}
	raw, err := s.api.Do(ctx, "GET", "/api/agents/"+url.PathEscape(id)+"/inbox?unread="+unread+"&limit="+limit, nil, 0)
	if err != nil {
		return "", err
	}
	rows, err := jsfmt.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("the daemon's reply isn't JSON")
	}
	// A row's linked ITSAs are their keys here, not the full records the web UI reads (S-986).
	for i, m := range rows.Items {
		if it, ok := m.Get("itsas"); ok && it.Truthy() {
			keys := make([]jsfmt.Value, 0, len(it.Items))
			for _, l := range it.Items {
				k, _ := l.Get("key")
				keys = append(keys, k)
			}
			rows.Items[i].Set("itsas", jsfmt.ArrayValue(keys))
		}
	}
	return jsfmt.Stringify(rows), nil
}

// uuid is crypto.randomUUID: a version 4 UUID.
func uuid() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func readMail(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	id, err := s.me(args)
	if err != nil {
		return "", err
	}
	batch := uuid()
	body := jsfmt.Value{Kind: jsfmt.Object}
	if ids, ok := args.Get("ids"); ok && ids.Kind != jsfmt.Null {
		body.Set("ids", ids)
	}
	body.Set("batch", jsfmt.StringValue(batch))
	if ack := s.readAck(id); ack != "" {
		body.Set("ack", jsfmt.StringValue(ack))
	}
	raw, err := s.api.Do(ctx, "POST", "/api/agents/"+url.PathEscape(id)+"/read", raw(body), 0)
	if err != nil {
		return "", err
	}
	mails, err := jsfmt.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("the daemon's reply isn't JSON")
	}
	s.setReadAck(id, batch)
	// A cited id that isn't addressed to this agent, such as one in its brief, reads through read_thread (S-448).
	var other []string
	if ids, ok := args.Get("ids"); ok {
		for _, x := range ids.Items {
			found := false
			for _, m := range mails.Items {
				if m.Text("id") == str(x, true) {
					found = true
				}
			}
			if !found {
				other = append(other, str(x, true))
			}
		}
	}
	hint := ""
	if len(other) > 0 {
		hint = "Not addressed to you: " + strings.Join(other, ", ") + ". read_thread with that id shows it if you may read its thread."
	}
	if len(mails.Items) == 0 {
		if hint != "" {
			return hint, nil
		}
		return "No unread mail.", nil
	}
	parts := make([]string, 0, len(mails.Items))
	for _, m := range mails.Items {
		var files []string
		if at, ok := m.Get("attachments"); ok {
			for _, f := range at.Items {
				files = append(files, fmt.Sprintf("  - %s (%s bytes): %s", member(f, "name"), member(f, "size"), member(f, "path")))
			}
		}
		thread := ""
		if truthyMember(m, "thread_id") && member(m, "thread_id") != member(m, "id") {
			reply := "an earlier mail"
			if truthyMember(m, "reply_to") {
				reply = member(m, "reply_to")
			}
			thread = fmt.Sprintf(" · thread %s, in reply to %s", member(m, "thread_id"), reply)
		}
		title := ""
		if truthyMember(m, "title") {
			title = " [" + member(m, "title") + "]"
		}
		out := fmt.Sprintf("## %s: %s%s\nFrom: %s (%s) · %s%s\n\n%s", member(m, "id"), member(m, "subject"), title, member(m, "from_name"), member(m, "from_id"), member(m, "created_at"), thread, member(m, "body"))
		if truthyMember(m, "note") {
			out += "\n\n[stam] " + member(m, "note")
		}
		if len(files) > 0 {
			out += "\n\nAttachments:\n" + strings.Join(files, "\n")
		}
		parts = append(parts, out)
	}
	head := ""
	if hint != "" {
		head = hint + "\n\n"
	}
	return head + strings.Join(parts, "\n\n---\n\n") + "\n\nTo answer one, use send_mail with reply_to set to its id. read_thread shows a thread's earlier messages.", nil
}

func readThread(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	id, err := s.me(args)
	if err != nil {
		return "", err
	}
	tid := member(args, "thread_id")
	raw, err := s.api.Do(ctx, "GET", "/api/threads/"+tid+"?box="+url.QueryEscape(id), nil, 0)
	if err != nil {
		return "", err
	}
	mails, err := jsfmt.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("the daemon's reply isn't JSON")
	}
	if len(mails.Items) == 0 {
		return "No mail of yours in thread " + tid + ".", nil
	}
	parts := make([]string, 0, len(mails.Items))
	for _, m := range mails.Items {
		var to []string
		if rc, ok := m.Get("recipients"); ok {
			for _, r := range rc.Items {
				to = append(to, member(r, "id"))
			}
		}
		out := fmt.Sprintf("## %s: %s\nFrom: %s (%s) to %s · %s\n\n%s", member(m, "id"), member(m, "subject"), member(m, "from_name"), member(m, "from_id"), strings.Join(to, ", "), member(m, "created_at"), member(m, "body"))
		if truthyMember(m, "note") {
			out += "\n\n[stam] " + member(m, "note")
		}
		parts = append(parts, out)
	}
	return strings.Join(parts, "\n\n---\n\n"), nil
}

// readAck is the read_mail batch each agent last got a reply to (S-357), kept per agent. A TS process that exec'd into
// this one hands its map over in STAM_MCP_READ_ACK.
func (s *Server) readAck(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.acks == nil {
		s.acks = map[string]string{}
		if v, err := jsfmt.Parse([]byte(s.getenv("STAM_MCP_READ_ACK"))); err == nil {
			for i, k := range v.Keys {
				s.acks[k] = str(v.Items[i], true)
			}
		}
	}
	return s.acks[id]
}

func (s *Server) setReadAck(id, batch string) {
	s.readAck(id)
	s.mu.Lock()
	s.acks[id] = batch
	s.mu.Unlock()
}
