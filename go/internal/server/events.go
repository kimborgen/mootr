package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/events"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// External events and their subscriptions (src/daemon.ts "External events", src/watch.ts, S-4317). Sources POST
// normalized events to /api/events; the daemon stores, matches and delivers them. A subscription names an agent, an ITSA
// or the human, with a filter; who may make one is checked here, on the route, whoever calls it (the MCP tool, the CLI, a
// peer, the web UI).
//
// Not ported yet, each a seam for the changes that follow: the Linear poller that calls ingest, the
// process start-node subscriptions (onProcessStart: a matching subscription of that kind is counted and nothing more),
// process-derived watchedSubjects, the requirement check of a stored event (checkRequirementsOn), and the reviewer's join of the ITSAs a
// watched PR is linked to (joinPrReviewer).

func (s *Server) eventsRoutes() {
	s.handle("POST /api/events", s.postEvent)
	s.handle("GET /api/events", s.getEvents)
	s.handle("GET /api/subscriptions", s.getSubscriptions)
	s.handle("POST /api/subscriptions", s.postSubscription)
	s.handle("DELETE /api/subscriptions/{id}", s.deleteSubscription)
}

var reSubID = regexp.MustCompile(`^[\w-]+$`)

// eventFold is STAM_EVENT_FOLD_MS: the fold window, 0 to deliver each event at once, 20 s when it is not a number of
// milliseconds of 0 or more (src/watch.ts foldMs).
func eventFold() time.Duration {
	raw := getenvStam("EVENT_FOLD_MS")
	n := jsjson.ToNumber(raw)
	if raw == "" || n != n || n < 0 || n > 1e12 {
		return events.DefaultFold
	}
	return time.Duration(n * float64(time.Millisecond))
}

// newEventsService builds the service; New calls it once, and a test may replace s.events before Start.
func (s *Server) newEventsService() *events.Service {
	return events.New(events.Options{DB: s.db, Host: eventsHost{s}, Fold: eventFold})
}

// StartEvents starts the event service (src/daemon.ts at start): every ITSA's link subscriptions are reconciled once, so
// links that predate the service get theirs, and the deliveries a restart found waiting are replayed. It stops with
// ctx, before the database closes.
func (s *Server) StartEvents(ctx context.Context) {
	if err := s.db.SyncAllItsaSubscriptions(ctx, s.isClosedStatus, events.SubjectForURL, newSubscriptionID); err != nil {
		slog.Error("event subscriptions: ITSA link sync", "err", err)
	}
	if err := s.events.Start(ctx); err != nil {
		slog.Error("event service: replay", "err", err)
	}
	s.startGithub(ctx)
	s.startLinear(ctx)
	s.goBg(func() {
		<-ctx.Done()
		// The poller ingests into the service, so it stops first and its tick in flight ends.
		s.github.Close()
		s.linear.Close()
		s.events.Close()
	})
}

// eventsAgentGone is what the lifecycle runs when an agent is archived or forgotten (Lifecycle.SetAgentGone): its event
// subscriptions, queues, timers and wait notices go. It runs on a context the caller's end can't cancel.
func (s *Server) eventsAgentGone(ctx context.Context, id string) {
	s.events.ForgetAgent(context.WithoutCancel(ctx), id)
}

// syncItsaSubscriptions makes an ITSA's link subscriptions match its links after a change to it (src/watch.ts watchItsa).
// The reconcile is idempotent, and the one at start repairs a change whose sync didn't run.
func (s *Server) syncItsaSubscriptions(ctx context.Context, itsaID string) {
	if err := s.db.SyncItsaSubscriptions(context.WithoutCancel(ctx), itsaID, s.isClosedStatus, events.SubjectForURL, newSubscriptionID); err != nil {
		slog.Error("event subscriptions: ITSA link sync", "itsa", itsaID, "err", err)
	}
}

// newSubscriptionID is a subscription's id, `es-` and 10 hex digits as the TS daemon makes.
func newSubscriptionID() string {
	b := make([]byte, 5)
	_, _ = rand.Read(b)
	return "es-" + hex.EncodeToString(b)
}

// eventsHost is how the event service reaches its subscribers.
type eventsHost struct{ s *Server }

// QueueNoticeRow queues a notice whose answer notice row the service stored with the delivery. An agent archived since is
// forgotten again, so the notice that landed after the archive's own sweep doesn't stay in memory.
func (h eventsHost) QueueNoticeRow(ctx context.Context, agentID, text string, row int64) {
	h.s.queueAnswerRow(ctx, agentID, text, row)
	if h.s.life == nil {
		return
	}
	if a, err := h.s.db.GetAgent(ctx, agentID); err == nil && a.Lifecycle == "archived" {
		h.s.life.ForgetAgentNotices(ctx, agentID)
	}
}

func (h eventsHost) MailAgent(ctx context.Context, agentID, subject, body string, commit events.Commit) error {
	_, err := h.s.send(ctx, &sendIn{system: "watch", hasSystem: true, to: []string{agentID}, subject: subject, body: body, newThread: true, fromStam: true, inferred: map[string]bool{}, inTx: commit})
	return err
}

func (h eventsHost) MailHuman(ctx context.Context, subject, body, replyTo string, commit events.Commit) (string, error) {
	m, err := h.s.send(ctx, &sendIn{system: "watch", hasSystem: true, to: []string{humanBox}, subject: subject, body: body, replyTo: replyTo, newThread: replyTo == "", fromStam: true, inferred: map[string]bool{}, inTx: commit})
	if err != nil {
		return "", err
	}
	return m.Text("id"), nil
}

// PostItsa is src/watch.ts deliver's ITSA branch: a quiet post into the ITSA's thread, as stam, for its agents only
// (S-511). `by: human` on the routed call only authorizes the peer request; the post itself is stam's.
func (h eventsHost) PostItsa(ctx context.Context, itsaID, body string) (bool, error) {
	x, ok, err := h.s.db.FindItsa(ctx, itsaID)
	if err != nil || !ok {
		return !ok && err == nil, err
	}
	in := jsfmt.Value{Kind: jsfmt.Object}
	in.Set("from_stam", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	in.Set("agents_only", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	in.Set("body", jsfmt.StringValue(body))
	in.Set("kind", jsfmt.StringValue("comment"))
	if h.s.isHome() {
		_, err = h.s.post(ctx, x.Text("id"), in, false)
		return false, err
	}
	in.Set("by", jsfmt.StringValue(humanBox))
	_, err = h.s.toHome(ctx, "POST", "/api/itsas/"+x.Text("id")+"/post", in, 15*time.Second, nil)
	return false, err
}

func (h eventsHost) Render(name string, vars map[string]string) (string, error) {
	return h.s.render(name, vars)
}

func (h eventsHost) WithFailureRetro(text string) string { return h.s.withFailureRetro(text) }

// ---- POST and GET /api/events ----

type eventPosted struct {
	Stored  bool         `json:"stored"`
	Event   *db.ExtEvent `json:"event,omitempty"`
	Matched int          `json:"matched"`
}

// strList is `[...(v ?? [])]` then String() on each and the empty ones dropped: an array's items, a string's characters
// (a spread of a string), nothing for null.
func strList(v jsjson.Value) ([]string, error) {
	switch x := v.(type) {
	case nil:
		return nil, nil
	case []any:
		var out []string
		for _, e := range x {
			if t := jsjson.ToString(e); t != "" {
				out = append(out, t)
			}
		}
		return out, nil
	case string:
		var out []string
		for _, r := range x {
			out = append(out, string(r))
		}
		return out, nil
	}
	return nil, errors.New("the event's subjects are not a list")
}

// storedText is `input.x ?? null`, as the text stored.
func storedText(v jsjson.Value) *string {
	if v == nil {
		return nil
	}
	t := jsjson.ToString(v)
	return &t
}

func (s *Server) postEvent(r *http.Request, c auth.Resolved) (any, error) {
	// Events come from the daemon's sources and the human's scripts. From an agent's token, a forged event would have
	// stam post into the threads of the ITSAs it subscribes (S-480).
	if msg := auth.NotAgentToken(c.Caller, "post external events"); msg != "" {
		return nil, Errorf(http.StatusForbidden, "%s", msg)
	}
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	body := w.body
	if body == nil {
		body = jsjson.NewObject()
	}
	text := func(k string) string { return jsjson.Trim(bodyText(bodyField(body, k))) }
	in := events.Input{Source: text("source"), Type: text("type"), DedupeKey: text("dedupe_key")}
	subjects, err := strList(bodyField(body, "subjects"))
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	if sub := bodyField(body, "subject"); jsjson.Truthy(sub) {
		subjects = append(subjects, jsjson.ToString(sub))
	}
	in.Subjects = subjects
	in.Actor, in.URL = storedText(bodyField(body, "actor")), storedText(bodyField(body, "url"))
	if v := bodyField(body, "summary"); v != nil {
		t := jsjson.ToString(v)
		in.Summary = &t
	}
	if p, ok := body.Get("payload"); ok {
		in.Payload, in.HasPayload = p, true
	}
	res, err := s.events.Ingest(context.WithoutCancel(r.Context()), in)
	var bad *events.ErrInvalid
	if errors.As(err, &bad) {
		return nil, Errorf(http.StatusBadRequest, "%s", bad.Msg)
	}
	if err != nil {
		return nil, err
	}
	if !res.Stored {
		return eventPosted{}, nil
	}
	return eventPosted{Stored: true, Event: &res.Event, Matched: res.Matched}, nil
}

func (s *Server) getEvents(r *http.Request, c auth.Resolved) (any, error) {
	// The event log holds every subject's events, so an agent's token reads none of it (S-587).
	if msg := auth.NotAgentToken(c.Caller, "read the event log"); msg != "" {
		return nil, Errorf(http.StatusForbidden, "%s", msg)
	}
	q := r.URL.Query()
	limit := 50
	if raw := q.Get("limit"); q.Has("limit") {
		n := jsjson.ToNumber(raw)
		if n == n && n != 0 {
			limit = int(max(1, min(500, n)))
		}
	}
	out, err := s.db.ListExtEvents(r.Context(), q.Get("subject"), limit)
	if out == nil {
		out = []db.ExtEvent{}
	}
	return out, err
}

// ---- subscriptions ----

// subscriptionOut is a subscription as the routes show it: its filter an object.
type subscriptionOut struct {
	ID             string        `json:"id"`
	SubscriberKind string        `json:"subscriber_kind"`
	SubscriberID   string        `json:"subscriber_id"`
	Filter         events.Filter `json:"filter"`
	CreatedBy      string        `json:"created_by"`
	Note           *string       `json:"note"`
	ExpiresAt      *int64        `json:"expires_at"`
	LastMailID     *string       `json:"last_mail_id"`
	CreatedAt      string        `json:"created_at"`
}

func subOut(s db.Subscription) subscriptionOut {
	return subscriptionOut{s.ID, s.SubscriberKind, s.SubscriberID, events.ParseFilter(s.Filter), s.CreatedBy, s.Note, s.ExpiresAt, s.LastMailID, s.CreatedAt}
}

// who is how an error names an actor.
func (s *Server) subWho(ctx context.Context, by string) string {
	if by == humanBox {
		return "the human"
	}
	return s.agentLabel(ctx, by)
}

// subscribeBy is the `by` of a subscription write: the body's, else the human's when the request is. A caller that is
// neither names no one, which strict mode refuses (TS reads it as the human).
func (s *Server) subscribeBy(w write, c auth.Resolved, body *jsjson.Object) (string, error) {
	if v := bodyField(body, "by"); v != nil {
		return jsjson.ToString(v), nil
	}
	if !w.human && s.strictRefuses("subscriptions with no by", !(w.local && c.Kind == auth.Shared)) {
		return "", Errorf(http.StatusForbidden, "only the human, or an agent naming itself (by), manages event subscriptions")
	}
	return humanBox, nil
}

func (s *Server) postSubscription(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	body := w.body
	if body == nil {
		body = jsjson.NewObject()
	}
	by, err := s.subscribeBy(w, c, body)
	if err != nil {
		return nil, err
	}
	kind := bodyText(bodyField(body, "subscriber_kind"))
	if kind != "agent" && kind != "itsa" && kind != "human" {
		return nil, Errorf(http.StatusBadRequest, "subscriber_kind must be one of agent, itsa, human")
	}
	id := ""
	if v := bodyField(body, "subscriber_id"); v != nil {
		id = jsjson.Trim(jsjson.ToString(v))
	}
	ref := id
	if strings.EqualFold(id, "the human") {
		id = humanBox
	}
	switch kind {
	case "agent":
		a, err := s.db.GetAgent(ctx, id)
		if errors.Is(err, db.ErrNotFound) {
			return nil, Errorf(http.StatusBadRequest, "no agent %s", id)
		}
		if err != nil {
			return nil, err
		}
		id = a.ID
	case "itsa":
		x, ok, err := s.db.FindItsa(ctx, id)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, Errorf(http.StatusBadRequest, "no ITSA %s", id)
		}
		id = x.Text("id")
	default:
		id = humanBox
	}
	var expires *int64
	if v := bodyField(body, "expires_at"); v != nil {
		if n := jsjson.ToNumber(v); n == n {
			e := int64(n)
			expires = &e
		}
	} else if v := bodyField(body, "expires_in_minutes"); v != nil {
		if n := jsjson.ToNumber(v); n == n {
			e := time.Now().UnixMilli() + int64(n*60_000)
			expires = &e
		}
	}
	filter := events.Sanitize(bodyField(body, "filter"))
	var note *string
	if v := bodyField(body, "note"); v != nil {
		if t := jsjson.Trim(jsjson.ToString(v)); t != "" {
			note = &t
		}
	}
	sub := db.Subscription{ID: newSubscriptionID(), SubscriberKind: kind, SubscriberID: id, Filter: filter.JSON(), CreatedBy: by, Note: note, ExpiresAt: expires,
		CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	// The check is made in the insert's own transaction: a reparent, a participant removal or an archive can't commit
	// between the check and the row.
	verdict, err := s.db.InsertSubscriptionBy(context.WithoutCancel(ctx), sub, by, s.settings.Get().ChiefOfStaff)
	if err != nil {
		return nil, err
	}
	switch verdict {
	case db.SubNoTarget:
		return nil, Errorf(http.StatusBadRequest, "no %s %s", map[string]string{"agent": "agent", "itsa": "ITSA"}[kind], ref)
	case db.SubForbidden:
		return nil, Errorf(http.StatusForbidden, "%s may not subscribe that %s", s.subWho(ctx, by), kind)
	}
	return subOut(sub), nil
}

func (s *Server) getSubscriptions(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	by, err := s.actor(ctx, c.Caller, r.URL.Query().Get("by"))
	if err != nil {
		return nil, err
	}
	if by == "" && s.isHuman(r, c) {
		by = humanBox
	}
	all, err := s.db.ListSubscriptions(ctx)
	if err != nil {
		return nil, err
	}
	out := []subscriptionOut{}
	var me db.Agent
	if by != humanBox {
		if me, err = s.db.GetAgent(ctx, by); err != nil {
			if errors.Is(err, db.ErrNotFound) {
				return out, nil
			}
			return nil, err
		}
	}
	for _, sub := range all {
		if by == humanBox || sub.CreatedBy == me.ID || (sub.SubscriberKind == "agent" && sub.SubscriberID == me.ID) {
			out = append(out, subOut(sub))
		}
	}
	return out, nil
}

type subscriptionRemoved struct {
	Removed string `json:"removed"`
}

func (s *Server) deleteSubscription(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	id := r.PathValue("id")
	if !reSubID.MatchString(id) {
		return nil, Errorf(http.StatusNotFound, "no route %s %s", r.Method, r.URL.Path)
	}
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	body := w.body
	if body == nil {
		body = jsjson.NewObject()
	}
	by := ""
	if v := bodyField(body, "by"); v != nil {
		by = jsjson.ToString(v)
	} else if w.human {
		by = humanBox
	}
	if _, err := s.db.FindSubscription(ctx, id); errors.Is(err, db.ErrNoSubscription) {
		return nil, Errorf(http.StatusNotFound, "no subscription %s", id)
	} else if err != nil {
		return nil, err
	}
	// The authorization is read in the delete's own transaction, like a subscription's insert.
	_, allowed, err := s.events.RemoveSubscriptionBy(context.WithoutCancel(ctx), id, by, s.settings.Get().ChiefOfStaff)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, Errorf(http.StatusForbidden, "%s may not remove that subscription", s.subWho(ctx, by))
	}
	return subscriptionRemoved{id}, nil
}
