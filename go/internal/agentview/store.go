package agentview

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
)

// maxWindow is how many harness messages a live window holds; older ones are paged in by /view/history.
const maxWindow = 400

// Store is src/agent-view.ts ViewStore: the live window of one agent's conversation, changed in place by a source, which
// remembers what changed since the last flush. The live view's lock guards it.
type Store struct {
	Messages    []*Message
	Permissions []*Permission
	Running     bool
	// HasOlder is whether the harness has messages older than the window.
	HasOlder bool
	// Replaced is set when the harness's transcript moved: the window was emptied and every client gets the state whole.
	Replaced    bool
	StatusDirty bool

	dirty   []string
	isDirty map[string]bool
	// slots are where a part sits in its message: `text:N` and `reasoning:N` for the message's Nth part of that type
	// (from 0), `tool:ID` and `permission:ID` by id. A source must use these keys, so a merge can rebuild them.
	slots map[string]map[string]int
}

func (s *Store) find(id string) *Message {
	for _, m := range s.Messages {
		if m.ID == id {
			return m
		}
	}
	return nil
}

// Dirty marks message id as changed.
func (s *Store) Dirty(id string) {
	if s.isDirty == nil {
		s.isDirty = map[string]bool{}
	}
	if !s.isDirty[id] {
		s.isDirty[id] = true
		s.dirty = append(s.dirty, id)
	}
}

// DirtyCount is how many messages changed since the last flush.
func (s *Store) DirtyCount() int { return len(s.dirty) }

// Message is message id, made with make the first time (nil: a running assistant message now), and marked changed.
func (s *Store) Message(id string, make func() *Message) *Message {
	m := s.find(id)
	if m == nil {
		if make != nil {
			m = make()
		} else {
			running := true
			m = &Message{ID: id, Role: "assistant", At: nowMs(), Parts: []Part{}, Running: &running}
		}
		s.Messages = append(s.Messages, m)
	}
	s.Dirty(id)
	return m
}

// Part is the index of the part under key in message msgID, made with make the first time.
func (s *Store) Part(msgID, key string, make func() Part) (*Message, int) {
	m := s.Message(msgID, nil)
	if s.slots == nil {
		s.slots = map[string]map[string]int{}
	}
	sl := s.slots[msgID]
	if sl == nil {
		sl = map[string]int{}
		s.slots[msgID] = sl
	}
	i, ok := sl[key]
	if !ok || i >= len(m.Parts) {
		m.Parts = append(m.Parts, make())
		i = len(m.Parts) - 1
		sl[key] = i
	}
	return m, i
}

// SetRunning sets whether a turn is going.
func (s *Store) SetRunning(running bool) {
	if s.Running != running {
		s.StatusDirty = true
	}
	s.Running = running
}

// Ask adds a permission request waiting for an answer, and its part in the message whose tool asked.
func (s *Store) Ask(p *Permission) {
	have := false
	for _, x := range s.Permissions {
		have = have || x.ID == p.ID
	}
	if !have {
		s.Permissions = append(s.Permissions, p)
	}
	s.StatusDirty = true
	if p.Message != "" {
		s.Part(p.Message, "permission:"+p.ID, func() Part {
			return Part{Type: "permission", ID: p.ID, Action: p.Action, Resources: p.Resources, Tool: p.Tool, Status: "asked"}
		})
	}
}

// Answered closes the permission request id: it is no longer waiting, and its part (in the message that holds it) shows
// the decision.
func (s *Store) Answered(id, decision string) {
	var m *Message
	at := -1
	for _, p := range s.Permissions {
		if p.ID == id && p.Message != "" {
			m = s.find(p.Message)
		}
	}
	kept := s.Permissions[:0:0]
	for _, p := range s.Permissions {
		if p.ID != id {
			kept = append(kept, p)
		}
	}
	s.Permissions = kept
	s.StatusDirty = true
	if m == nil {
		for _, x := range s.Messages {
			for i, q := range x.Parts {
				if m == nil && q.Type == "permission" && q.ID == id {
					m, at = x, i
				}
			}
		}
	}
	if m == nil {
		return
	}
	if at < 0 {
		for i, q := range m.Parts {
			if at < 0 && q.Type == "permission" && q.ID == id {
				at = i
			}
		}
	}
	if at >= 0 {
		m.Parts[at].Status = decision
		s.Dirty(m.ID)
	}
}

// Merge is ViewStore.merge: the window's messages replaced with a fresh read of the newest page, keeping what the read
// can't have yet (messages still streaming, and the permission parts of messages the harness doesn't store them in).
// Only messages that changed are marked.
func (s *Store) Merge(fresh []*Message) {
	old := map[string]*Message{}
	for _, m := range s.Messages {
		old[m.ID] = m
	}
	ids := map[string]bool{}
	oldest := math.Inf(1)
	for _, m := range fresh {
		ids[m.ID] = true
		// The page's oldest harness message: mail is the view's own and can be older.
		if m.Kind != "mail" && m.At < oldest {
			oldest = m.At
		}
	}
	var all []*Message
	for _, m := range s.Messages {
		if !ids[m.ID] && ((m.Running != nil && *m.Running) || m.At < oldest) {
			all = append(all, m)
		}
	}
	for _, m := range fresh {
		prev := old[m.ID]
		if prev != nil {
			for _, p := range prev.Parts {
				if p.Type == "permission" && !hasPermission(m, p.ID) {
					m.Parts = append(m.Parts, p)
				}
			}
		}
		if prev == nil || !sameJSON(prev, m) {
			s.Dirty(m.ID)
		}
	}
	all = append(all, fresh...)
	// Only harness messages count against the window; mail comes along for their time span.
	var harness, mail []*Message
	for _, m := range all {
		if m.Kind == "mail" {
			mail = append(mail, m)
		} else {
			harness = append(harness, m)
		}
	}
	sort.SliceStable(harness, func(i, j int) bool { return harness[i].At < harness[j].At })
	if len(harness) > maxWindow {
		harness = harness[len(harness)-maxWindow:]
		kept := mail[:0:0]
		for _, m := range mail {
			if m.At >= harness[0].At {
				kept = append(kept, m)
			}
		}
		mail = kept
		s.HasOlder = true
	}
	s.Messages = Interleave(append(harness, mail...))
	s.slots = map[string]map[string]int{}
	for _, m := range s.Messages {
		s.slots[m.ID] = slotsOf(m)
	}
}

func hasPermission(m *Message, id string) bool {
	for _, p := range m.Parts {
		if p.Type == "permission" && p.ID == id {
			return true
		}
	}
	return false
}

func sameJSON(a, b *Message) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

// Older is `before` for /view/history: the oldest harness message's id while the harness has older ones (a mail
// message is the view's own, so the harness can't page from it), else nil.
func (s *Store) Older() *string {
	if !s.HasOlder {
		return nil
	}
	for _, m := range s.Messages {
		if m.Kind != "mail" {
			id := m.ID
			return &id
		}
	}
	return nil
}

// Flush is what changed since the last flush, and forgets it.
func (s *Store) Flush() []Event {
	var out []Event
	for _, id := range s.dirty {
		if m := s.find(id); m != nil {
			out = append(out, Event{Type: "message", Message: m})
		}
	}
	if s.StatusDirty {
		running := s.Running
		out = append(out, Event{Type: "status", Running: &running, Permissions: s.Permissions})
	}
	s.dirty, s.isDirty = nil, nil
	s.StatusDirty = false
	return out
}

// slotsOf is the slot keys of a message's parts.
func slotsOf(m *Message) map[string]int {
	out := map[string]int{}
	nth := map[string]int{}
	for i, p := range m.Parts {
		var key string
		if p.Type == "text" || p.Type == "reasoning" {
			key = p.Type + ":" + strconv.Itoa(nth[p.Type])
			nth[p.Type]++
		} else {
			key = p.Type + ":" + p.ID
		}
		if _, ok := out[key]; !ok {
			out[key] = i
		}
	}
	return out
}

// Interleave is src/agent-view.ts interleave: mail among harness messages, which keep their order. A mail goes above
// the first harness message that started after it was sent; a mail and a harness message at the same time keep the
// harness's first.
func Interleave(messages []*Message) []*Message {
	var mail []*Message
	for _, m := range messages {
		if m.Kind == "mail" {
			mail = append(mail, m)
		}
	}
	sort.SliceStable(mail, func(i, j int) bool { return mail[i].At < mail[j].At })
	out := make([]*Message, 0, len(messages))
	i := 0
	for _, h := range messages {
		if h.Kind == "mail" {
			continue
		}
		for i < len(mail) && mail[i].At < h.At {
			out = append(out, mail[i])
			i++
		}
		out = append(out, h)
	}
	return append(out, mail[i:]...)
}

// TurnTools is src/agent-view.ts turnTools: the tool calls an agent made on the way to a mail it sent at hi. Its turn
// starts at the newest boundary before the mail: a mail to the agent when it read it, the human's message, a stam
// notice, or a mail the agent sent. A tool call belongs to the turn when it came after that boundary and at or before
// the mail; its time is its part's mark where the harness gives one, else its message's. Done once the boundary is in.
func TurnTools(messages []*Message, hi float64) (tools []Part, done bool) {
	type event struct {
		at   float64
		tool *Part
	}
	var events []event
	for _, m := range messages {
		switch {
		case m.Kind == "mail":
			// A mail the agent received starts its turn when the agent read it; unread, it started none.
			if len(m.Parts) > 0 && m.Parts[0].Type == "mail" && m.Parts[0].Mail.To == nil {
				if r := m.Parts[0].Mail.ReadAt; r != nil {
					events = append(events, event{at: float64(*r)})
				}
			} else {
				events = append(events, event{at: m.At})
			}
		case m.Role == "user" || (m.Role == "system" && m.Kind == "notice"):
			events = append(events, event{at: m.At})
		default:
			for k := range m.Parts {
				if m.Parts[k].Type == "tool" {
					at := m.At
					if k < len(m.Marks) {
						at = float64(m.Marks[k])
					}
					events = append(events, event{at: at, tool: &m.Parts[k]})
				}
			}
		}
	}
	var newest []event
	for _, e := range events {
		if (e.tool != nil && e.at <= hi) || (e.tool == nil && e.at < hi) {
			newest = append(newest, e)
		}
	}
	// Newest first; at the same time a boundary comes before a call, so a call at the boundary's time is the next turn's.
	sort.SliceStable(newest, func(i, j int) bool {
		a, b := newest[i], newest[j]
		if a.at != b.at {
			return a.at > b.at
		}
		return a.tool == nil && b.tool != nil
	})
	var got []Part
	for _, e := range newest {
		if e.tool == nil {
			done = true
			break
		}
		got = append(got, *e.tool)
	}
	for i, j := 0, len(got)-1; i < j; i, j = i+1, j-1 {
		got[i], got[j] = got[j], got[i]
	}
	if got == nil {
		got = []Part{}
	}
	return got, done
}
