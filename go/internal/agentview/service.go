package agentview

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sync"
	"time"
	"unicode/utf16"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// Source is src/agent-view.ts ViewSource: what a harness plugs in. Follow calls live.Update when it changes the store,
// and live.Resync when the harness's stored messages are worth reading again; it returns the stop.
type Source interface {
	Caps() Caps
	// Unavailable is why this agent has no view right now, "" when it has one.
	Unavailable(a db.Agent) string
	Page(ctx context.Context, a db.Agent, limit int, before string) (Page, error)
	Status(ctx context.Context, a db.Agent) (running bool, permissions []*Permission, err error)
	Follow(a db.Agent, live Sink) (stop func())
	Prompt(ctx context.Context, a db.Agent, text, delivery string) error
	Stop(ctx context.Context, a db.Agent) (bool, error)
}

// Sink is a live view as its source sees it. Update runs fn on the store under the view's lock; when fn reports a
// change, the change goes out to the clients.
type Sink interface {
	Update(fn func(s *Store) (changed bool))
	Resync()
	// Moved empties the window: the agent has moved to another session, and what was read of the old one is no longer its
	// view. A read of the old session still in flight is dropped when it finishes, and the next state frame carries the
	// new session's messages and its paging.
	Moved()
}

const (
	pageSize = 50
	// flushEvery: changes go out at most this often, so a burst of deltas costs one write per message.
	flushEvery  = 50 * time.Millisecond
	resyncAfter = 100 * time.Millisecond
	pingEvery   = 25 * time.Second
	toolPage    = 50
	toolPages   = 40
)

// maxBuffered: a client that reads slower than the agent writes would buffer whole messages without bound; past this
// it's dropped, and reconnecting gets it a fresh state. A variable for the tests.
var maxBuffered = 4 << 20

// Service is the daemon's agent views: the sources by harness, and one live window per agent with a view open.
type Service struct {
	DB *db.DB
	// Done ends every view stream: the daemon stops.
	Done <-chan struct{}

	sources map[string]Source
	mu      sync.Mutex
	lives   map[string]*live
}

// Register plugs in a harness's source.
func (s *Service) Register(harness string, src Source) {
	if s.sources == nil {
		s.sources = map[string]Source{}
	}
	s.sources[harness] = src
}

func (s *Service) sourceFor(a db.Agent) (Source, error) {
	src := s.sources[a.Harness]
	if src == nil {
		return nil, refuse(409, "stam's own view doesn't support "+a.Harness+" yet; use the terminal")
	}
	if why := src.Unavailable(a); why != "" {
		return nil, refuse(409, why)
	}
	return src, nil
}

// live is one agent's view open in any browser; dropped when the last one closes.
type live struct {
	svc    *Service
	agent  db.Agent
	source Source
	ready  chan struct{}
	// readyErr is the first read's failure, set before ready closes.
	readyErr error
	stop     func()
	quit     chan struct{}

	mu      sync.Mutex // guards the fields below
	store   Store
	clients map[*client]bool
	joining int // clients still waiting for the first read
	flushT  *time.Timer
	rereadT *time.Timer
	dropped bool
	// moves counts the window's moves to another session, bumped under mu with the store emptied: a first or later read
	// that began before one is of the session the agent left, and is dropped when it finishes (reread, first).
	moves int
	// emptied is set by a move and cleared when a read of the new session lands: that read's paging and messages go out as
	// one whole state, whatever frames came between (events applied to the empty window).
	emptied bool
}

func (l *live) Update(fn func(s *Store) bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if fn(&l.store) {
		l.changed()
	}
}

func (l *live) Moved() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.moves++
	l.emptied = true
	l.store = Store{Replaced: true, StatusDirty: true}
	l.changed()
}

// changed sends what changed within flushEvery; l.mu is held.
func (l *live) changed() {
	if l.flushT == nil && !l.dropped {
		l.flushT = time.AfterFunc(flushEvery, l.flush)
	}
}

func (l *live) flush() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.flushT = nil
	if l.dropped {
		return
	}
	if l.store.Replaced {
		l.store.Replaced = false
		l.store.Flush()
		l.sendAll(Event{Type: "state", State: l.state()})
		return
	}
	for _, ev := range l.store.Flush() {
		l.sendAll(ev)
	}
}

func (l *live) sendAll(ev Event) {
	b, err := json.Marshal(ev)
	if err != nil {
		return
	}
	frame := append(append([]byte("data: "), b...), '\n', '\n')
	for c := range l.clients {
		c.send(frame)
	}
}

func (l *live) state() *State {
	perms := l.store.Permissions
	if perms == nil {
		perms = []*Permission{}
	}
	msgs := l.store.Messages
	if msgs == nil {
		msgs = []*Message{}
	}
	return &State{Agent: l.agent.ID, Harness: l.agent.Harness, Capabilities: l.source.Caps(), Running: l.store.Running, Messages: msgs,
		Permissions: perms, Older: l.store.Older()}
}

// Resync reads the harness's stored messages again, which are the truth: the read replaces what the deltas built.
func (l *live) Resync() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.dropped {
		return
	}
	if l.rereadT != nil {
		l.rereadT.Stop()
	}
	l.rereadT = time.AfterFunc(resyncAfter, l.reread)
}

func (l *live) reread() {
	ctx := context.Background()
	l.mu.Lock()
	moves := l.moves
	l.mu.Unlock()
	p, err := l.source.Page(ctx, l.agent, pageSize, "")
	if err != nil {
		return
	}
	run, perms, err := l.source.Status(ctx, l.agent)
	if err != nil {
		return
	}
	msgs, err := l.svc.withMail(ctx, l.agent, p.Messages, p.Older != nil, math.Inf(1))
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.dropped || l.moves != moves {
		// The agent moved to another session while this read was made: what it read is the old session's. The move asked
		// for its own read (Resync), which is not this one.
		return
	}
	l.store.Merge(msgs)
	if l.emptied {
		// A window emptied by a move: the new session's paging is this page's, and every client gets the state whole.
		l.emptied = false
		l.store.HasOlder = p.Older != nil
		l.store.Replaced = true
	}
	l.store.SetRunning(run)
	waiting := map[string]bool{}
	for _, x := range perms {
		waiting[x.ID] = true
	}
	kept := l.store.Permissions[:0:0]
	for _, x := range l.store.Permissions {
		if waiting[x.ID] {
			kept = append(kept, x)
		}
	}
	l.store.Permissions = kept
	for _, x := range perms {
		l.store.Ask(x)
	}
	l.store.StatusDirty = true
	l.changed()
}

// first is the first read: the newest page with its mail, and the status.
func (l *live) first() {
	defer close(l.ready)
	ctx := context.Background()
	l.mu.Lock()
	moves := l.moves
	l.mu.Unlock()
	// A failure is the first read's only while the window is still on the session it read: one that fails after a move is of
	// the session the agent left, and the move's own read fills the window (a joiner must not get a 502 for it).
	fail := func(err error) {
		l.mu.Lock()
		defer l.mu.Unlock()
		if l.moves == moves {
			l.readyErr = err
		}
	}
	p, err := l.source.Page(ctx, l.agent, pageSize, "")
	if err != nil {
		fail(err)
		return
	}
	run, perms, err := l.source.Status(ctx, l.agent)
	if err != nil {
		fail(err)
		return
	}
	msgs, err := l.svc.withMail(ctx, l.agent, p.Messages, p.Older != nil, math.Inf(1))
	if err != nil {
		fail(err)
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.moves != moves {
		// Moved to another session during the first read: the window starts empty, and the move's own read fills it.
		return
	}
	l.store.Merge(msgs)
	l.store.HasOlder = p.Older != nil
	l.store.SetRunning(run)
	for _, x := range perms {
		l.store.Ask(x)
	}
	l.store.Flush()
}

// watchMail reads the view again when the agent gets, sends or reads mail, or its mail is read: TS's db.onAgentMail,
// here a poll of the agent's mail mark at the follow's pace.
func (l *live) watchMail() {
	ctx := context.Background()
	last, _ := l.svc.DB.MailMark(ctx, l.agent.ID)
	tk := time.NewTicker(pollEvery)
	defer tk.Stop()
	for {
		select {
		case <-l.quit:
			return
		case <-tk.C:
			if mark, err := l.svc.DB.MailMark(ctx, l.agent.ID); err == nil && mark != last {
				last = mark
				l.Resync()
			}
		}
	}
}

// client is one browser's stream: frames queue for its handler, which writes them.
type client struct {
	mu      sync.Mutex
	queue   [][]byte
	size    int
	dropped bool
	wake    chan struct{}
	gone    chan struct{}
}

func (c *client) send(frame []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.dropped {
		return
	}
	if c.size > maxBuffered {
		c.dropped = true
		close(c.gone)
		return
	}
	c.queue = append(c.queue, frame)
	c.size += len(frame)
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *client) take() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	q := c.queue
	c.queue, c.size = nil, 0
	return q
}

// Stream is GET /api/agents/:id/view: server-sent events, the state first, then each change. An error is returned
// before anything is written.
func (s *Service) Stream(w http.ResponseWriter, r *http.Request, a db.Agent) error {
	src, err := s.sourceFor(a)
	if err != nil {
		return err
	}
	c := &client{wake: make(chan struct{}, 1), gone: make(chan struct{})}
	var l *live
	for {
		l = s.join(a, src)
		left := false
		select {
		case <-l.ready:
		case <-r.Context().Done():
			left = true
		case <-s.Done:
			left = true
		}
		if joinGap != nil {
			joinGap()
		}
		// The join ends, and the client is added, in one section: the live can't be dropped between them.
		l.mu.Lock()
		l.joining--
		ok := !left && l.readyErr == nil
		retry := ok && l.dropped
		if ok && !l.dropped {
			l.clients[c] = true
			// The state is queued in the same section, so it is the client's first frame: no change flushed after the
			// add can come before it, or fill the client's buffer before it has its snapshot.
			b, _ := json.Marshal(Event{Type: "state", State: l.state()})
			c.send(append(append([]byte("data: "), b...), '\n', '\n'))
		}
		l.mu.Unlock()
		if left {
			s.release(l)
			return nil
		}
		if l.readyErr != nil {
			s.release(l)
			return refuse(502, "can't read "+a.Name+"'s conversation: "+l.readyErr.Error())
		}
		// Dropped under the joiner (it can't be while it joins, but a joiner never lands on a dropped live): start over
		// on a fresh one.
		if retry {
			continue
		}
		break
	}
	if joinedGap != nil {
		joinedGap(l)
	}
	defer func() {
		l.mu.Lock()
		delete(l.clients, c)
		l.mu.Unlock()
		s.release(l)
	}()
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// Every write has a deadline, and a drop (c.gone), the daemon's stop or the client going cuts a write already
	// blocked short, as TS destroys a slow socket: a client that stops reading never holds the live window or a shutdown.
	out := &streamOut{w: w, rc: http.NewResponseController(w), timeout: writeTimeout}
	finished, watched := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(watched)
		select {
		case <-finished:
			return
		case <-c.gone:
		case <-s.Done:
		case <-r.Context().Done():
		}
		out.cut()
	}()
	defer func() {
		close(finished)
		out.release()
		<-watched
	}()
	ping := time.NewTicker(pingEvery)
	defer ping.Stop()
	for {
		select {
		case <-c.wake:
			for _, f := range c.take() {
				if out.write(f) != nil {
					return nil
				}
			}
		case <-ping.C:
			if out.write([]byte(": ping\n\n")) != nil {
				return nil
			}
		case <-c.gone:
			return nil
		case <-r.Context().Done():
			return nil
		case <-s.Done:
			return nil
		}
	}
}

// joinGap is a test's seam: it runs after a joiner's wait for the first read, before it joins the live.
var joinGap func()

// joinedGap is a test's seam: it runs once the client has joined the live, before its stream is written.
var joinedGap func(*live)

// join is the agent's live window, opened when none is, with one more joiner. Live changes are followed before the
// first read, so nothing between the two is lost; the read merges under them.
func (s *Service) join(a db.Agent, src Source) *live {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lives == nil {
		s.lives = map[string]*live{}
	}
	l := s.lives[a.ID]
	if l == nil {
		l = &live{svc: s, agent: a, source: src, ready: make(chan struct{}), quit: make(chan struct{}), clients: map[*client]bool{}}
		s.lives[a.ID] = l
		l.stop = src.Follow(a, l)
		go l.watchMail()
		go l.first()
	}
	l.mu.Lock()
	l.joining++
	l.mu.Unlock()
	return l
}

// writeTimeout is the longest one write to a client may take before it is dropped, as the SSE hub's.
var writeTimeout = 10 * time.Second

// streamOut is a stream's writes and its connection's write deadline (internal/layout's shape). One lock guards the end
// and every deadline change, so a write never starts, or moves the deadline, once the stream has ended; the lock is
// never held across the blocking write itself.
type streamOut struct {
	w       http.ResponseWriter
	rc      *http.ResponseController
	timeout time.Duration

	mu    sync.Mutex
	ended bool
}

var errEnded = errors.New("agentview: the stream has ended")

// write sends b with a fresh deadline, or refuses once the stream has ended.
func (o *streamOut) write(b []byte) error {
	o.mu.Lock()
	if o.ended {
		o.mu.Unlock()
		return errEnded
	}
	// A deadline the writer doesn't support (a test recorder) is no error: the write just has none.
	_ = o.rc.SetWriteDeadline(time.Now().Add(o.timeout))
	o.mu.Unlock()
	if _, err := o.w.Write(b); err != nil {
		return err
	}
	return o.rc.Flush()
}

// cut ends the stream and moves the deadline to now, so a write blocked on the client returns.
func (o *streamOut) cut() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.ended {
		o.ended = true
		_ = o.rc.SetWriteDeadline(time.Now())
	}
}

// release ends the stream as its loop stops. One that ended on its own clears its deadline, since the connection may
// serve another request; one that was cut keeps the past deadline.
func (o *streamOut) release() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.ended {
		o.ended = true
		_ = o.rc.SetWriteDeadline(time.Time{})
	}
}

// release drops the live window once no client has it open or is joining: its follow and mail watch stop.
func (s *Service) release(l *live) {
	s.mu.Lock()
	l.mu.Lock()
	drop := len(l.clients) == 0 && l.joining == 0 && s.lives[l.agent.ID] == l
	if drop {
		delete(s.lives, l.agent.ID)
		l.dropped = true
		if l.flushT != nil {
			l.flushT.Stop()
		}
		if l.rereadT != nil {
			l.rereadT.Stop()
		}
	}
	l.mu.Unlock()
	s.mu.Unlock()
	if drop {
		close(l.quit)
		l.stop()
	}
}

// OpenViews is how many agents have a view open, for tests.
func (s *Service) OpenViews() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.lives)
}

// HasViewers is whether a web client has the agent's view open now.
func (s *Service) HasViewers(id string) bool {
	s.mu.Lock()
	l := s.lives[id]
	s.mu.Unlock()
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.clients) > 0
}

// History is GET /view/history: the newest limit messages before `before`, with their mail. The page's mail ends where
// the newer page starts; when the view isn't open here that time is unknown, and the client drops the mail it has.
func (s *Service) History(ctx context.Context, a db.Agent, before string, limit float64) (Page, error) {
	src, err := s.sourceFor(a)
	if err != nil {
		return Page{}, err
	}
	n := pageSize
	if f := math.Floor(limit); f == f && f != 0 {
		n = int(math.Min(math.Max(f, 1), 200))
	}
	p, err := src.Page(ctx, a, n, before)
	if err != nil {
		return Page{}, err
	}
	until := math.Inf(1)
	if before != "" {
		s.mu.Lock()
		l := s.lives[a.ID]
		s.mu.Unlock()
		if l != nil {
			l.mu.Lock()
			if m := l.store.find(before); m != nil {
				until = m.At
			}
			l.mu.Unlock()
		}
	}
	msgs, err := s.withMail(ctx, a, p.Messages, p.Older != nil, until)
	if err != nil {
		return Page{}, err
	}
	return Page{Messages: msgs, Older: p.Older}, nil
}

// withMail is src/agent-view.ts withMail: mail to and from the agent joins its conversation as user messages of kind
// mail, at the time it was sent. A page carries the mail from its first message (from the start when nothing is older)
// up to until, where the next newer page starts.
func (s *Service) withMail(ctx context.Context, a db.Agent, msgs []*Message, older bool, until float64) ([]*Message, error) {
	from := 0.0
	if older && len(msgs) > 0 {
		from = msgs[0].At
	}
	end := "9999"
	if !math.IsInf(until, 0) {
		end = iso(until)
	}
	to, err := s.DB.MailTo(ctx, a.ID, iso(from), end, 200)
	if err != nil {
		return nil, err
	}
	by, err := s.DB.MailBy(ctx, a.ID, iso(from), end, 200)
	if err != nil {
		return nil, err
	}
	if len(to)+len(by) == 0 {
		if msgs == nil {
			msgs = []*Message{}
		}
		return msgs, nil
	}
	all := append([]*Message{}, msgs...)
	for _, m := range to {
		all = append(all, s.mailMessage(ctx, m))
	}
	for _, m := range by {
		all = append(all, s.sentMessage(ctx, m))
	}
	return Interleave(all), nil
}

func (s *Service) nameOf(ctx context.Context, id string) string {
	if id == "human" {
		return "human"
	}
	if a, err := s.DB.GetAgent(ctx, id); err == nil {
		return a.Name
	}
	return id
}

func msOf(iso *string) *int64 {
	if iso == nil || *iso == "" {
		return nil
	}
	ms := dateParse(*iso)
	if ms != ms {
		return nil
	}
	n := int64(ms)
	return &n
}

func (s *Service) mailMessage(ctx context.Context, m db.ViewMail) *Message {
	from := s.nameOf(ctx, m.FromID)
	if m.FromName != nil {
		from = *m.FromName
	}
	thread := m.ID
	if m.ThreadID != nil {
		thread = *m.ThreadID
	}
	at := dateParse(m.CreatedAt)
	if at != at {
		at = 0
	}
	return &Message{ID: "mail:" + m.ID, Role: "user", Kind: "mail", At: at, Parts: []Part{{Type: "mail", ID: m.ID,
		Mail: &MailPart{FromID: m.FromID, From: from, Subject: m.Subject, Body: m.Body, Thread: thread, ReadAt: msOf(m.ReadAt)}}}}
}

// sentMessage is a mail the agent sent: the same card, with its recipients in place of its own read state.
func (s *Service) sentMessage(ctx context.Context, m db.ViewMail) *Message {
	msg := s.mailMessage(ctx, m)
	to := make([]Recip, 0, len(m.To))
	for _, r := range m.To {
		to = append(to, Recip{ID: r.ID, Name: s.nameOf(ctx, r.ID), ReadAt: msOf(r.ReadAt)})
	}
	msg.Parts[0].Mail.To = &to
	return msg
}

// Tools is GET /view/tools's answer.
type Tools struct {
	Tools     []Part `json:"tools"`
	Truncated bool   `json:"truncated"`
}

// MailTools is src/agent-view.ts mailTools: the tool calls an agent made on the way to a mail it sent (S-1643). Pages of
// its view are read newest first until the turn's start is in; each page's mail ends where the page before it starts.
// Truncated says the page cap ran out before the turn's start.
func (s *Service) MailTools(ctx context.Context, a db.Agent, mailID string) (Tools, error) {
	mail, found, err := s.DB.GetMail(ctx, mailID)
	if err != nil {
		return Tools{}, err
	}
	if !found || mail.Text("from_id") != a.ID {
		return Tools{}, refuse(404, a.Name+" sent no mail "+mailID)
	}
	src, err := s.sourceFor(a)
	if err != nil {
		return Tools{}, err
	}
	hi := dateParse(mail.Text("created_at"))
	var order []string
	seen := map[string]*Message{}
	put := func(m *Message) {
		if _, ok := seen[m.ID]; !ok {
			order = append(order, m.ID)
		}
		seen[m.ID] = m
	}
	all := func() []*Message {
		out := make([]*Message, len(order))
		for i, id := range order {
			out[i] = seen[id]
		}
		return out
	}
	before := ""
	until := math.Inf(1)
	for page := 0; ; page++ {
		p, err := src.Page(ctx, a, toolPage, before)
		if err != nil {
			return Tools{}, err
		}
		msgs, err := s.withMail(ctx, a, p.Messages, p.Older != nil, until)
		if err != nil {
			return Tools{}, err
		}
		for _, m := range msgs {
			put(m)
		}
		// A received mail is a boundary at its read_at, which can fall in this page's range though it was created on an
		// older page: the mail read in the range is added, so an early stop can't miss a later boundary. Bounded by the
		// target mail's time, before the row cap: reads at or after it are no boundary.
		from := 0.0
		if p.Older != nil && len(p.Messages) > 0 {
			from = p.Messages[0].At
		}
		read, err := s.DB.MailReadIn(ctx, a.ID, iso(from), iso(math.Min(until, hi)), 200)
		if err != nil {
			return Tools{}, err
		}
		for _, m := range read {
			put(s.mailMessage(ctx, m))
		}
		tools, done := TurnTools(all(), hi)
		if done || p.Older == nil {
			return Tools{Tools: tools}, nil
		}
		if page+1 >= toolPages {
			return Tools{Tools: tools, Truncated: true}, nil
		}
		if len(p.Messages) > 0 {
			until = p.Messages[0].At
		}
		before = *p.Older
	}
}

// resting is src/lifecycle.ts isResting: paused by the rest alone.
func resting(a db.Agent) bool {
	if a.Lifecycle != "paused" {
		return false
	}
	owners, err := a.PausedByOf()
	return err == nil && len(owners) == 1 && owners[0] == "standing-idle"
}

type promptEvent struct {
	Delivery string `json:"delivery"`
	Chars    int    `json:"chars"`
}

// Prompt is src/view-prompt.ts prompt with src/agent-view.ts prompt: text typed in the web view. A resting agent isn't
// woken here (the wake isn't ported): it's a 409 that says to mail it.
// delivery is the body's, nil when it is missing or null.
func (s *Service) Prompt(ctx context.Context, a db.Agent, text string, delivery jsjson.Value) error {
	if resting(a) {
		if jsjson.Trim(text) == "" {
			return refuse(400, "text is empty")
		}
		return refuse(409, a.Name+" is resting, and a prompt from the view doesn't wake it on this daemon yet; send it mail")
	}
	src, err := s.sourceFor(a)
	if err != nil {
		return err
	}
	if !src.Caps().CanSend {
		return refuse(409, a.Harness+" takes no prompts from the view; use the terminal")
	}
	if jsjson.Trim(text) == "" {
		return refuse(400, "text is empty")
	}
	d := "queue"
	if delivery != nil {
		d, _ = delivery.(string)
	}
	if d != "queue" && d != "steer" {
		return refuse(400, "delivery is 'queue' or 'steer'")
	}
	if err := src.Prompt(ctx, a, text, d); err != nil {
		return err
	}
	return s.DB.AddEvent(ctx, a.ID, "view-prompt", promptEvent{Delivery: d, Chars: len(utf16.Encode([]rune(text)))})
}

// Interrupt is src/agent-view.ts interrupt: Esc into the agent's running turn; whether it stopped.
func (s *Service) Interrupt(ctx context.Context, a db.Agent) (bool, error) {
	src, err := s.sourceFor(a)
	if err != nil {
		return false, err
	}
	if !src.Caps().CanInterrupt {
		return false, refuse(409, a.Harness+" can't be interrupted from the view; use the terminal")
	}
	if err := s.DB.AddEvent(ctx, a.ID, "view-interrupt", struct{}{}); err != nil {
		return false, err
	}
	return src.Stop(ctx, a)
}

// Approver is a source that takes permission replies from the view (OpenCode's).
type Approver interface {
	AnswerPermission(ctx context.Context, a db.Agent, request, decision string) error
}

// AnswerPermission is src/agent-view.ts answerPermission: a reply to one of the agent's waiting permissions, once, always
// or reject. request and decision are the body's, nil when missing or null. A source without the capability is TS's 409
// (Claude Code's permissions are read-only).
func (s *Service) AnswerPermission(ctx context.Context, a db.Agent, request, decision jsjson.Value) error {
	src, err := s.sourceFor(a)
	if err != nil {
		return err
	}
	ap, ok := src.(Approver)
	if !src.Caps().CanApprove || !ok {
		return refuse(409, a.Harness+" takes no permission replies from the view; use the terminal")
	}
	req := ""
	if request != nil {
		req = jsjson.ToString(request)
	}
	if req == "" {
		return refuse(400, "request is missing")
	}
	d, _ := decision.(string)
	if d != "once" && d != "always" && d != "reject" {
		return refuse(400, "decision is 'once', 'always', or 'reject'")
	}
	if err := ap.AnswerPermission(ctx, a, req, d); err != nil {
		return err
	}
	return s.DB.AddEvent(ctx, a.ID, "view-permission", struct {
		Request  string `json:"request"`
		Decision string `json:"decision"`
	}{req, d})
}

// AsError is err as a view refusal, when it is one.
func AsError(err error) (*Error, bool) {
	e, ok := err.(*Error)
	return e, ok
}
