package agentview

import (
	"math"
	"strings"
	"time"

	"stam/internal/jsjson"
)

// The pure parts of OpenCode's view (src/adapters/opencode-view.ts): a stored message as a view message, and a server event
// applied to the live window. Shapes as OpenCode v2.0.26 sends them (test/fixtures/opencode-view.json).

func objOf(v jsjson.Value) *jsjson.Object {
	o, _ := v.(*jsjson.Object)
	return o
}

// field is o.key, nil when o is nil or has none; has says whether the key is there (JS: not undefined).
func field(o *jsjson.Object, key string) (v jsjson.Value, has bool) {
	if o == nil {
		return nil, false
	}
	return o.Get(key)
}

func fieldOf(o *jsjson.Object, key string) jsjson.Value {
	v, _ := field(o, key)
	return v
}

// strOr is `String(o.key ?? "")`.
func strOr(o *jsjson.Object, key string) string {
	if v := fieldOf(o, key); v != nil {
		return jsjson.ToString(v)
	}
	return ""
}

// templ is `${o.key}`: a missing key prints as undefined.
func templ(o *jsjson.Object, key string) string {
	v, has := field(o, key)
	switch {
	case !has:
		return "undefined"
	default:
		return jsjson.ToString(v)
	}
}

// ocTextOf is the text of a content list: its parts' strings, or the string itself.
func ocTextOf(content jsjson.Value) string {
	switch c := content.(type) {
	case []any:
		var b strings.Builder
		for _, e := range c {
			if s, ok := fieldOf(objOf(e), "text").(string); ok {
				b.WriteString(s)
			}
		}
		return b.String()
	case string:
		return c
	}
	return ""
}

// errorOf is `e ? String(e.message ?? e.type ?? e) : undefined`; ok false for undefined.
func errorOf(e jsjson.Value) (string, bool) {
	if !jsjson.Truthy(e) {
		return "", false
	}
	if o := objOf(e); o != nil {
		if m := fieldOf(o, "message"); m != nil {
			return jsjson.ToString(m), true
		}
		if t := fieldOf(o, "type"); t != nil {
			return jsjson.ToString(t), true
		}
	}
	return jsjson.ToString(e), true
}

func toolStatus(s jsjson.Value) string {
	switch s {
	case "completed":
		return "done"
	case "error":
		return "error"
	case "running":
		return "running"
	}
	return "pending"
}

func createdAt(o *jsjson.Object) float64 {
	if t, ok := fieldOf(objOf(fieldOf(o, "time")), "created").(float64); ok {
		return t
	}
	return 0
}

// FromOpenCode is one stored OpenCode message as a view message, nil for one the view leaves out.
func FromOpenCode(v jsjson.Value) *Message {
	m := objOf(v)
	if m == nil {
		return nil
	}
	at := createdAt(m)
	id, _ := fieldOf(m, "id").(string)
	sys := func(kind, text string) *Message {
		return &Message{ID: id, Role: "system", Kind: kind, At: at, Parts: []Part{{Type: "text", Text: text}}}
	}
	typ, _ := fieldOf(m, "type").(string)
	switch typ {
	case "user":
		return &Message{ID: id, Role: "user", At: at, Parts: []Part{{Type: "text", Text: strOr(m, "text")}}}
	case "synthetic": // stam's notices and mail, and OpenCode's own reminders
		return sys("notice", strOr(m, "text"))
	case "system":
		return sys("system", strOr(m, "text"))
	case "skill":
		if name := fieldOf(m, "name"); name != nil {
			return sys("skill", "Skill "+jsjson.ToString(name))
		}
		return sys("skill", "Skill "+templ(m, "skill"))
	case "shell": // a command the human ran in the TUI with !
		pid := id
		if s := fieldOf(m, "shellID"); s != nil {
			pid = jsjson.ToString(s)
		}
		status := "error"
		switch {
		case fieldOf(m, "status") == "running":
			status = "running"
		case fieldOf(m, "status") == "exited" && fieldOf(m, "exit") == float64(0):
			status = "done"
		}
		part := Part{Type: "tool", ID: pid, Name: "shell", Status: status, HasInput: true}
		in := jsjson.NewObject()
		if c, has := field(m, "command"); has {
			in.Set("command", c)
		}
		part.Input = in
		if out, ok := fieldOf(objOf(fieldOf(m, "output")), "output").(string); ok {
			part.Output = &out
		}
		return &Message{ID: id, Role: "user", Kind: "shell", At: at, Parts: []Part{part}}
	case "compaction":
		switch fieldOf(m, "status") {
		case "failed":
			e, ok := errorOf(fieldOf(m, "error"))
			if !ok {
				e = "undefined"
			}
			return sys("compaction", "Compaction failed: "+e)
		case "running":
			return sys("compaction", "Compacting")
		}
		return sys("compaction", "Compacted")
	case "idle": // the end of a turn; only one that didn't succeed is worth a line
		outcome, _ := fieldOf(m, "outcome").(string)
		if outcome == "succeeded" {
			return nil
		}
		text := "Turn failed"
		if outcome == "interrupted" {
			text = "Interrupted"
		}
		return sys(outcome, text)
	case "model-switched":
		model := objOf(fieldOf(m, "model"))
		return sys("model", "Model "+templ(model, "providerID")+"/"+templ(model, "id"))
	case "agent-switched":
		return sys("agent", "Agent "+templ(m, "agent"))
	case "assistant":
		// Each part's time where OpenCode stores one (else the part before's), so the web view splits a step at the mail
		// that came during it (S-278).
		parts := []Part{}
		marks := []int64{}
		content, _ := fieldOf(m, "content").([]any)
		for _, e := range content {
			c := objOf(e)
			switch fieldOf(c, "type") {
			case "text", "reasoning":
				parts = append(parts, Part{Type: fieldOf(c, "type").(string), Text: strOr(c, "text")})
			case "tool":
				st := objOf(fieldOf(c, "state"))
				p := Part{Type: "tool", ID: strOf(fieldOf(c, "id")), Name: strOf(fieldOf(c, "name")), Status: toolStatus(fieldOf(st, "status"))}
				if in, has := field(st, "input"); has {
					p.Input, p.HasInput = in, true
				}
				out := ocTextOf(fieldOf(st, "content"))
				if out == "" {
					out, _ = errorOf(fieldOf(st, "error"))
				}
				if out != "" {
					p.Output = &out
				}
				parts = append(parts, p)
			default:
				continue
			}
			last := float64(at)
			if len(marks) > 0 {
				last = float64(marks[len(marks)-1])
			}
			marks = append(marks, int64(math.Max(createdAt(c), last)))
		}
		out := &Message{ID: id, Role: "assistant", At: at, Marks: marks, Parts: parts}
		if !jsjson.Truthy(fieldOf(objOf(fieldOf(m, "time")), "completed")) {
			t := true
			out.Running = &t
		}
		if e, ok := errorOf(fieldOf(m, "error")); ok {
			out.Error = e
		}
		return out
	}
	return nil
}

func strOf(v jsjson.Value) string {
	if v == nil {
		return ""
	}
	return jsjson.ToString(v)
}

// PermissionOf is a permission the server lists or asks for, as a view permission.
func PermissionOf(v jsjson.Value) *Permission {
	p := objOf(v)
	res := []string{}
	if list, ok := fieldOf(p, "resources").([]any); ok {
		for _, r := range list {
			res = append(res, jsjson.ToString(r))
		}
	}
	out := &Permission{ID: strOf(fieldOf(p, "id")), Action: strOr(p, "action"), Resources: res}
	src := objOf(fieldOf(p, "source"))
	if m := fieldOf(src, "messageID"); m != nil {
		out.Message = jsjson.ToString(m)
	}
	if t := fieldOf(src, "id"); t != nil {
		s := jsjson.ToString(t)
		out.Tool = &s
	}
	return out
}

// What an event did to the window.
const (
	evNone   = iota // nothing the view shows
	evChange        // the store changed
	evResync        // the stored messages are worth reading again (a turn or step ended, a prompt arrived)
)

// ApplyEvent applies one server event to the store, for the event's own session.
func ApplyEvent(s *Store, typ string, d *jsjson.Object) int {
	mid := strOf(fieldOf(d, "assistantMessageID"))
	// A part made live takes its start from the daemon's clock until a re-read gives OpenCode's, so the web view splits a
	// running step at the mail that came during it too (S-278).
	timed := func() {
		m := s.Message(mid, nil)
		for len(m.Marks) < len(m.Parts) {
			m.Marks = append(m.Marks, time.Now().UnixMilli())
		}
	}
	ord := func() string {
		if v, has := field(d, "ordinal"); has {
			return jsjson.ToString(v)
		}
		return "undefined"
	}
	idOf := func() string {
		if v, has := field(d, "id"); has {
			return jsjson.ToString(v)
		}
		return "undefined"
	}
	stream := func(kind string) *Part {
		m, i := s.Part(mid, kind+":"+ord(), func() Part { return Part{Type: kind} })
		timed()
		return &m.Parts[i]
	}
	tool := func() *Part {
		m, i := s.Part(mid, "tool:"+idOf(), func() Part {
			name := "tool"
			if n := fieldOf(d, "name"); n != nil {
				name = jsjson.ToString(n)
			}
			return Part{Type: "tool", ID: idOf(), Name: name, Status: "pending"}
		})
		timed()
		return &m.Parts[i]
	}
	kindOf := func() string {
		if strings.Contains(typ, "text") {
			return "text"
		}
		return "reasoning"
	}
	switch typ {
	case "session.text.started", "session.reasoning.started":
		stream(kindOf())
		return evChange
	case "session.text.delta", "session.reasoning.delta":
		p := stream(kindOf())
		if dl := fieldOf(d, "delta"); dl != nil {
			p.Text += jsjson.ToString(dl)
		}
		return evChange
	case "session.text.ended", "session.reasoning.ended":
		p := stream(kindOf())
		if t, ok := fieldOf(d, "text").(string); ok {
			p.Text = t
		}
		return evChange
	case "session.tool.input.started":
		tool()
		return evChange
	case "session.tool.called":
		p := tool()
		if in, has := field(d, "input"); has {
			p.Input, p.HasInput = in, true
		}
		p.Status = "running"
		return evChange
	case "session.tool.success":
		p := tool()
		out := ocTextOf(fieldOf(d, "content"))
		p.Output, p.Status = &out, "done"
		return evChange
	case "session.tool.failed":
		p := tool()
		out, ok := errorOf(fieldOf(d, "error"))
		if !ok {
			out = "failed"
		}
		p.Output, p.Status = &out, "error"
		return evChange
	case "session.step.ended":
		if mid != "" {
			f := false
			s.Message(mid, nil).Running = &f
		}
		return evResync
	case "permission.asked":
		s.Ask(PermissionOf(d))
		return evChange
	case "permission.replied":
		s.Answered(strOf(fieldOf(d, "requestID")), strOf(fieldOf(d, "reply")))
		return evChange
	case "session.execution.started":
		s.SetRunning(true)
		return evChange
	case "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted":
		s.SetRunning(false)
		for _, m := range s.Messages {
			if m.Running != nil && *m.Running {
				f := false
				m.Running = &f
				s.Dirty(m.ID)
			}
		}
		return evResync
	case "session.inbox.delivered", "session.compaction.started", "session.compaction.ended":
		return evResync
	}
	return evNone
}
