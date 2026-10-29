// Package agentview is src/agent-view.ts: stam's own view of an agent (S-78), the agent's conversation as structured
// messages, live, beside its tmux terminal, which stays the fallback. Each harness plugs in a Source: it reads stored
// history, follows live changes into a Store, and sends prompts and interrupts where it can. Its Caps tell the web what to
// offer. Claude Code's (claude.go) and OpenCode's (opencode.go) sources are ported; a Codex agent gets TS's 409 for a harness with none.
package agentview

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
	"time"

	"stam/internal/jsjson"
)

// Caps is src/agent-view.ts ViewCapabilities, in its key order.
type Caps struct {
	CanStream    bool `json:"can_stream"`
	CanSend      bool `json:"can_send"`
	CanInterrupt bool `json:"can_interrupt"`
	CanApprove   bool `json:"can_approve"`
}

// Part is one ViewPart: text, reasoning, tool, permission or mail, by Type. Its JSON has only its type's keys, in TS's
// order.
type Part struct {
	Type string
	Text string // text, reasoning

	ID string // tool, permission, mail
	// A tool's name, its input as Claude Code wrote it (HasInput false when the block had none), its output once a
	// result came, and its status: pending, running, done or error.
	Name      string
	Input     jsjson.Value
	HasInput  bool
	Output    *string
	Status    string // tool; permission: asked, once, always or reject
	Action    string // permission
	Resources []string
	Tool      *string

	Mail *MailPart // mail
}

// MailPart is a mail card's fields after its id: a mail to or from the agent (src/agent-view.ts mailMessage).
type MailPart struct {
	FromID  string   `json:"from_id"`
	From    string   `json:"from"`
	Subject string   `json:"subject"`
	Body    string   `json:"body"`
	Thread  string   `json:"thread"`
	ReadAt  *int64   `json:"read_at"`
	To      *[]Recip `json:"to,omitempty"` // a mail the agent sent: its recipients, in place of its own read state
}

// Recip is a recipient of a mail the agent sent, with its read state (MailRecipient).
type Recip struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	ReadAt *int64 `json:"read_at"`
}

func (p Part) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteString(`{"type":`)
	str(&b, p.Type)
	field := func(k string, v any) {
		b.WriteString(`,"` + k + `":`)
		out, _ := json.Marshal(v)
		b.Write(out)
	}
	switch p.Type {
	case "text", "reasoning":
		b.WriteString(`,"text":`)
		str(&b, p.Text)
	case "tool":
		b.WriteString(`,"id":`)
		str(&b, p.ID)
		b.WriteString(`,"name":`)
		str(&b, p.Name)
		if p.HasInput {
			b.WriteString(`,"input":` + jsjson.Stringify(p.Input, ""))
		}
		b.WriteString(`,"status":`)
		str(&b, p.Status)
		if p.Output != nil {
			b.WriteString(`,"output":`)
			str(&b, *p.Output)
		}
	case "permission":
		b.WriteString(`,"id":`)
		str(&b, p.ID)
		b.WriteString(`,"action":`)
		str(&b, p.Action)
		field("resources", nonNil(p.Resources))
		if p.Tool != nil {
			b.WriteString(`,"tool":`)
			str(&b, *p.Tool)
		}
		b.WriteString(`,"status":`)
		str(&b, p.Status)
	case "mail":
		b.WriteString(`,"id":`)
		str(&b, p.ID)
		out, err := json.Marshal(p.Mail)
		if err != nil {
			return nil, err
		}
		b.WriteByte(',')
		b.Write(out[1:])
		return b.Bytes(), nil
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// str writes s as JSON.stringify does: no HTML escapes, and U+2028 and U+2029 kept as they are.
func str(b *bytes.Buffer, s string) {
	var sb strings.Builder
	jsjson.Quote(&sb, s)
	b.WriteString(sb.String())
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// Message is a ViewMessage. Role is user, assistant or system; Kind names a system message (notice) or a mail card
// (mail). Marks are each part's time where the harness says, so the web can split a long turn at the mail that came in
// during it.
type Message struct {
	ID      string  `json:"id"`
	Role    string  `json:"role"`
	Kind    string  `json:"kind,omitempty"`
	At      float64 `json:"at"`
	Parts   []Part  `json:"parts"`
	Marks   []int64 `json:"marks,omitempty"`
	Running *bool   `json:"running,omitempty"`
	Error   string  `json:"error,omitempty"`
}

// clone is a deep copy, as structuredClone gives the page's reader.
func (m *Message) clone() *Message {
	c := *m
	c.Parts = make([]Part, len(m.Parts))
	for i, p := range m.Parts {
		if p.HasInput {
			p.Input = jsjson.Clone(p.Input)
		}
		if p.Output != nil {
			o := *p.Output
			p.Output = &o
		}
		p.Resources = append([]string(nil), p.Resources...)
		if p.Mail != nil {
			mp := *p.Mail
			if mp.To != nil {
				to := append([]Recip{}, *mp.To...)
				mp.To = &to
			}
			p.Mail = &mp
		}
		c.Parts[i] = p
	}
	if m.Marks != nil {
		c.Marks = append([]int64{}, m.Marks...)
	}
	return &c
}

// Permission is a ViewPermission: a request waiting for an answer.
type Permission struct {
	ID        string   `json:"id"`
	Action    string   `json:"action"`
	Resources []string `json:"resources"`
	Message   string   `json:"message,omitempty"`
	Tool      *string  `json:"tool,omitempty"`
}

// State is a ViewState: the stream's first event, the newest page of the conversation.
type State struct {
	Agent        string        `json:"agent"`
	Harness      string        `json:"harness"`
	Capabilities Caps          `json:"capabilities"`
	Running      bool          `json:"running"`
	Messages     []*Message    `json:"messages"`
	Permissions  []*Permission `json:"permissions"`
	Older        *string       `json:"older"`
}

// Page is a ViewPage: messages oldest first, and `before` for the next older page, nil at the start.
type Page struct {
	Messages []*Message `json:"messages"`
	Older    *string    `json:"older"`
}

// Event is a ViewEvent: the whole state, one message created or changed, or the status.
type Event struct {
	Type        string        `json:"type"`
	State       *State        `json:"state,omitempty"`
	Message     *Message      `json:"message,omitempty"`
	Running     *bool         `json:"running,omitempty"`
	Permissions []*Permission `json:"permissions,omitempty"`
}

// MarshalJSON writes a status event's permissions even when there are none.
func (e Event) MarshalJSON() ([]byte, error) {
	if e.Type != "status" {
		type plain Event
		return json.Marshal(plain(e))
	}
	return json.Marshal(struct {
		Type        string        `json:"type"`
		Running     bool          `json:"running"`
		Permissions []*Permission `json:"permissions"`
	}{e.Type, *e.Running, nonNilPerms(e.Permissions)})
}

func nonNilPerms(p []*Permission) []*Permission {
	if p == nil {
		return []*Permission{}
	}
	return p
}

// Error is src/agent-view.ts ViewError: a refusal with its HTTP status.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

func refuse(status int, msg string) error { return &Error{status, msg} }

// dateParse is Date.parse for the ISO times stam and Claude Code write; NaN when it isn't one.
func dateParse(s string) float64 {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return math.NaN()
	}
	return float64(t.UnixMilli())
}

func nowMs() float64 { return float64(time.Now().UnixMilli()) }

// iso is new Date(ms).toISOString().
func iso(ms float64) string {
	return time.UnixMilli(int64(ms)).UTC().Format("2006-01-02T15:04:05.000Z")
}
