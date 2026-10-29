package agentview

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"time"

	"stam/internal/db"
)

// Claude is src/adapters/claude-view.ts: Claude Code's part of the view, read-mostly. The agent's transcript is the
// history and the live feed: each row is a block when Claude Code writes it, so text shows when it ends, not as it's
// written (can_stream false). Activity comes from the hooks (the agent's row); permissions are the recorded requests,
// shown read-only, since stam has no blocking permission hook (S-81). Prompts go into the terminal's input box and Esc
// interrupts, as the human's do.
type Claude struct {
	DB *db.DB
	// Type is lifecycle's TypeHumanInput: the text typed into an idle agent's empty input box, false when it isn't free.
	Type func(ctx context.Context, a db.Agent, text string) bool
	// Interrupt is lifecycle's Interrupt: Esc into a running turn, true once Claude Code shows it interrupted.
	Interrupt func(ctx context.Context, a db.Agent) (bool, error)
	// Restore puts an archived agent's gzipped transcript back at its path; nil does nothing.
	Restore func(path *string) error

	mu     sync.Mutex
	cache  []*Transcript // parsed transcripts, most recently used last
	queues map[string]*promptQueue
}

// running are the activities that mean a turn is going: a permission or question dialog holds the turn open.
var running = map[string]bool{"starting": true, "working": true, "blocked": true}

// pollEvery is the follow poll: a transcript row lands within this of being written. A variable for the tests.
var pollEvery = 300 * time.Millisecond

// maxFiles is how many transcripts stay parsed at once; one nobody follows is dropped first, and parsed again from its
// start on its next read.
const maxFiles = 8

// ClaudeCaps are Claude Code's view capabilities.
var ClaudeCaps = Caps{CanStream: false, CanSend: true, CanInterrupt: true, CanApprove: false}

func (c *Claude) Caps() Caps { return ClaudeCaps }

func (c *Claude) Unavailable(a db.Agent) string {
	if a.TranscriptPath == nil || *a.TranscriptPath == "" {
		return a.Name + " has no Claude Code transcript yet"
	}
	return ""
}

// transcript is the parsed transcript of file, marked most recently used.
func (c *Claude) transcript(file string) *Transcript {
	c.mu.Lock()
	defer c.mu.Unlock()
	var t *Transcript
	for i, x := range c.cache {
		if x.File == file {
			t = x
			c.cache = append(c.cache[:i], c.cache[i+1:]...)
			break
		}
	}
	if t == nil {
		t = NewTranscript(file)
	}
	c.cache = append(c.cache, t)
	for i := 0; len(c.cache) > maxFiles && i < len(c.cache); {
		old := c.cache[i]
		old.Lock()
		watched := old.Watchers > 0
		old.Unlock()
		if watched || old == t {
			i++
			continue
		}
		c.cache = append(c.cache[:i], c.cache[i+1:]...)
	}
	return t
}

// Cached is how many transcripts are parsed now, for tests.
func (c *Claude) Cached() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.cache)
}

func (c *Claude) current(ctx context.Context, a db.Agent) db.Agent {
	if cur, err := c.DB.GetAgent(ctx, a.ID); err == nil {
		return cur
	}
	return a
}

// Page is the newest limit messages before `before`, oldest first, from the agent's current transcript, copied out so a
// caller can't change what the cache holds. A gzipped transcript (an archived agent's) is restored first.
func (c *Claude) Page(ctx context.Context, a db.Agent, limit int, before string) (Page, error) {
	cur := c.current(ctx, a)
	path := cur.TranscriptPath
	if path == nil || *path == "" {
		path = a.TranscriptPath
	}
	if c.Restore != nil {
		if err := c.Restore(path); err != nil {
			return Page{}, err
		}
	}
	t := c.transcript(*path)
	t.Lock()
	defer t.Unlock()
	t.Read()
	all := t.Messages
	end := len(all)
	if before != "" {
		end = 0
		for i, m := range all {
			if m.ID == before {
				end = i
				break
			}
		}
	}
	start := max(0, end-limit)
	out := Page{Messages: make([]*Message, 0, end-start)}
	for _, m := range all[start:end] {
		out.Messages = append(out.Messages, m.clone())
	}
	if start > 0 {
		id := all[start].ID
		out.Older = &id
	}
	return out, nil
}

// permissionsOf is what the view shows for an agent's permissions: its recorded requests, and a dialog the hooks saw
// (activity blocked) that no request records. Read-only either way.
func (c *Claude) permissionsOf(ctx context.Context, a db.Agent) []*Permission {
	out := []*Permission{}
	reqs, _ := c.DB.ListPermissionRequests(ctx, "pending")
	for _, p := range reqs {
		if p.AgentID != a.ID {
			continue
		}
		res := []string{}
		if p.Details != "" {
			res = []string{p.Details}
		}
		out = append(out, &Permission{ID: p.ID, Action: p.Action, Resources: res})
	}
	if a.Activity == "blocked" && len(out) == 0 {
		detail := ""
		if a.ActivityDetail != nil {
			detail = *a.ActivityDetail
		}
		action, res := "permission", []string{}
		if detail == "question" {
			action = "question"
		}
		if detail != "" {
			res = []string{detail}
		}
		return []*Permission{{ID: "blocked:" + a.ID, Action: action, Resources: res}}
	}
	return out
}

func (c *Claude) Status(ctx context.Context, a db.Agent) (bool, []*Permission, error) {
	cur := c.current(ctx, a)
	return running[string(cur.Activity)], c.permissionsOf(ctx, cur), nil
}

// apply puts one transcript message into the store, its parts by the store's slots, keeping what the store has beyond
// the transcript's.
func apply(s *Store, m *Message) {
	cur := s.Message(m.ID, func() *Message { return &Message{ID: m.ID, Role: m.Role, At: m.At, Parts: []Part{}} })
	if m.Marks != nil {
		cur.Marks = append([]int64{}, m.Marks...)
	}
	nth := map[string]int{}
	for _, p := range m.clone().Parts {
		key := "tool:" + p.ID
		if p.Type != "tool" {
			key = p.Type + ":" + strconv.Itoa(nth[p.Type])
			nth[p.Type]++
		}
		msg, i := s.Part(m.ID, key, func() Part { return p })
		msg.Parts[i] = merged(msg.Parts[i], p)
	}
}

// merged is Object.assign(part, p): p's fields over the part's, the part's own kept where p has none.
func merged(old, p Part) Part {
	if old.Type != p.Type {
		return p
	}
	if p.Output == nil {
		p.Output = old.Output
	}
	if !p.HasInput && old.HasInput {
		p.Input, p.HasInput = old.Input, true
	}
	return p
}

// Follow polls the transcript for appended rows and the agent's activity and permissions. A replaced transcript (a new
// path, or a shorter file) empties the window and is read again.
func (c *Claude) Follow(a db.Agent, live Sink) func() {
	var file string
	var t *Transcript
	seen := 0
	attach := func(f string) {
		file = f
		t = nil
		if f == "" {
			return
		}
		t = c.transcript(f)
		t.Lock()
		t.Watchers++
		t.Read()
		// What's in it already is the page's: read, not emitted.
		t.Take()
		seen = t.Resets
		t.Unlock()
	}
	detach := func() {
		if t != nil {
			t.Lock()
			t.Watchers--
			t.Unlock()
		}
		t = nil
	}
	resetWindow := func() {
		live.Update(func(s *Store) bool {
			s.Messages = nil
			s.HasOlder = false
			s.Replaced = true
			return true
		})
		live.Resync()
	}
	pathOf := func(a db.Agent) string {
		if a.TranscriptPath == nil {
			return ""
		}
		return *a.TranscriptPath
	}
	attach(pathOf(a))
	ctx, cancel := context.WithCancel(context.Background())
	tick := func() {
		cur := c.current(ctx, a)
		if pathOf(cur) != file {
			detach()
			attach(pathOf(cur))
			resetWindow()
			return
		}
		var fresh []*Message
		if t != nil {
			t.Lock()
			t.Read()
			if t.Resets != seen {
				seen = t.Resets
				t.Take()
				t.Unlock()
				resetWindow()
				return
			}
			for _, id := range t.Take() {
				if m := t.ByID[id]; m != nil {
					fresh = append(fresh, m.clone())
				}
			}
			t.Unlock()
		}
		run := running[string(cur.Activity)]
		perms := c.permissionsOf(ctx, cur)
		live.Update(func(s *Store) bool {
			changed := false
			// The newest harness message: a mail in the window can be newer than a turn's start.
			newest := -1e308
			for i := len(s.Messages) - 1; i >= 0; i-- {
				if s.Messages[i].Kind != "mail" {
					newest = s.Messages[i].At
					break
				}
			}
			for _, m := range fresh {
				// A message the window doesn't hold is older than its oldest page, or new: only new ones join.
				if s.find(m.ID) != nil || m.At >= newest {
					apply(s, m)
					changed = true
				}
			}
			if run != s.Running {
				s.SetRunning(run)
			}
			if !samePerms(perms, s.Permissions) {
				s.Permissions = perms
				s.StatusDirty = true
				changed = true
			}
			return changed || s.StatusDirty || s.DirtyCount() > 0
		})
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		tick()
		tk := time.NewTicker(pollEvery)
		defer tk.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tk.C:
				tick()
			}
		}
	}()
	return func() {
		cancel()
		<-done
		detach()
	}
}

func samePerms(a, b []*Permission) bool {
	x, _ := json.Marshal(nonNilPerms(a))
	y, _ := json.Marshal(nonNilPerms(b))
	return string(x) == string(y)
}

// Prompt types text into the terminal's input box, the way the human's own prompt goes in. Prompts to one agent
// queue: each is typed only after the last one is taken (the agent is no longer idle), so two at once can't land in one
// box. Refused while the box holds a draft or a dialog is up: the view doesn't guess. 'steer' has no path of its own in
// Claude Code: it types the same prompt.
func (c *Claude) Prompt(ctx context.Context, a db.Agent, text, _ string) error {
	q := c.queue(a.ID)
	q.Lock()
	if !c.Type(ctx, c.current(ctx, a), text) {
		q.Unlock()
		c.unqueue(a.ID)
		return refuse(409, a.Name+"'s input box isn't free for a prompt now; use the terminal")
	}
	// Enter sends the prompt; the agent turns busy when its UserPromptSubmit hook lands. The next prompt waits for that,
	// or 5 s.
	go func() {
		defer c.unqueue(a.ID)
		defer q.Unlock()
		for i := 0; i < 100; i++ {
			if cur, err := c.DB.GetAgent(context.Background(), a.ID); err == nil && cur.Activity != "idle" {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	}()
	return nil
}

// promptQueue is one agent's prompt queue, and how many prompts hold or wait for it.
type promptQueue struct {
	sync.Mutex
	users int
}

// queue is the agent's prompt queue, made on its first use; unqueue lets it go, and the last user drops it.
func (c *Claude) queue(id string) *promptQueue {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.queues == nil {
		c.queues = map[string]*promptQueue{}
	}
	q := c.queues[id]
	if q == nil {
		q = &promptQueue{}
		c.queues[id] = q
	}
	q.users++
	return q
}

func (c *Claude) unqueue(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if q := c.queues[id]; q != nil {
		if q.users--; q.users == 0 {
			delete(c.queues, id)
		}
	}
}

// Queues is how many agents have a prompt queue now, for tests.
func (c *Claude) Queues() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.queues)
}

func (c *Claude) Stop(ctx context.Context, a db.Agent) (bool, error) {
	return c.Interrupt(ctx, c.current(ctx, a))
}
