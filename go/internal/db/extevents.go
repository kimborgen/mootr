package db

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The external-event store (src/watch.ts, S-4317): ext_events, event_subscriptions, and the delivery queue.
//
// The TS daemon folds a burst of events in memory, so a restart inside the fold window loses them. This one keeps the
// fold in the kv table, which the schema already has, so no table is added and a rollback to TS finds nothing it reads
// changed: `evq:SUBID` holds one subscription's folded lines, and `evw:WAITID` the notice of an event wait the event
// cleared. Both are written in the transaction that stores the event, and removed once the delivery they hold is made.

// ExtEvent is one stored external event as the routes show it, in its column order.
type ExtEvent struct {
	ID       int64    `json:"id"`
	Source   string   `json:"source"`
	Type     string   `json:"type"`
	Subjects []string `json:"subjects"`
	Actor    *string  `json:"actor"`
	URL      *string  `json:"url"`
	Summary  string   `json:"summary"`
	// Payload is the stored JSON text; nil is left out of the answer (an ingest of an event with no payload), "null" is
	// the listing's null.
	Payload   json.RawMessage `json:"payload,omitempty"`
	DedupeKey string          `json:"dedupe_key"`
	CreatedAt string          `json:"created_at"`
}

// Subscription is one event_subscriptions row. Filter is its JSON text.
type Subscription struct {
	ID             string
	SubscriberKind string
	SubscriberID   string
	Filter         string
	CreatedBy      string
	Note           *string
	ExpiresAt      *int64
	LastMailID     *string
	CreatedAt      string
}

const subColumns = "id, subscriber_kind, subscriber_id, filter, created_by, note, expires_at, last_mail_id, created_at"

func scanSub(stmt *sqlite.Stmt) Subscription {
	s := Subscription{ID: stmt.ColumnText(0), SubscriberKind: stmt.ColumnText(1), SubscriberID: stmt.ColumnText(2), Filter: stmt.ColumnText(3), CreatedBy: stmt.ColumnText(4)}
	if stmt.ColumnType(5) != sqlite.TypeNull {
		n := stmt.ColumnText(5)
		s.Note = &n
	}
	if stmt.ColumnType(6) != sqlite.TypeNull {
		e := stmt.ColumnInt64(6)
		s.ExpiresAt = &e
	}
	if stmt.ColumnType(7) != sqlite.TypeNull {
		m := stmt.ColumnText(7)
		s.LastMailID = &m
	}
	s.CreatedAt = stmt.ColumnText(8)
	return s
}

func querySubs(conn *sqlite.Conn, where string, args ...any) ([]Subscription, error) {
	var out []Subscription
	err := sqlitex.Execute(conn, "SELECT "+subColumns+" FROM event_subscriptions "+where, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
		out = append(out, scanSub(stmt))
		return nil
	}})
	return out, err
}

// ErrNoSubscription is returned for a subscription id nothing has.
var ErrNoSubscription = errors.New("db: no subscription")

// InsertSubscription stores one subscription row (src/watch.ts insertSubscription).
func (d *DB) InsertSubscription(ctx context.Context, s Subscription) error {
	return wrap("insert subscription", d.Write(ctx, func(conn *sqlite.Conn) error {
		return insertSub(conn, s)
	}))
}

// SubVerdict is how InsertSubscriptionBy ended.
type SubVerdict int

const (
	// SubStored: the subscription is stored.
	SubStored SubVerdict = iota
	// SubForbidden: `by` may not subscribe that, or is no longer live; nothing is stored.
	SubForbidden
	// SubNoTarget: the agent or ITSA the subscription names is gone or archived; nothing is stored.
	SubNoTarget
)

// TestHookSubCheck is for tests only: it runs inside InsertSubscriptionBy's and RemoveSubscriptionBy's transaction right
// after the check and before the write.
var TestHookSubCheck func()

// InsertSubscriptionBy checks the subscription and stores it in one write transaction, so a reparent, an ITSA
// participant removal or an archive can't commit between the check and the insert (an archive's ForgetAgentEvents would
// miss a row that lands after it). The target must exist and not be archived; `by` must be the human or a live agent,
// and may subscribe it by src/watch.ts maySubscribe and src/cost-auth.ts mayManageTree over local agents only.
// chiefName is the settings' chief of staff (an id or a name).
func (d *DB) InsertSubscriptionBy(ctx context.Context, s Subscription, by, chiefName string) (verdict SubVerdict, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		verdict = SubForbidden
		live, err := subTargetLive(conn, s.SubscriberKind, s.SubscriberID)
		if err != nil {
			return err
		}
		if !live {
			verdict = SubNoTarget
			return nil
		}
		if by != "human" {
			actor, found, err := agentConn(conn, by)
			if err != nil || !found || actor.Lifecycle == "archived" {
				return err
			}
		}
		ok, err := maySubscribeConn(conn, by, s.SubscriberKind, s.SubscriberID, chiefName)
		if err != nil || !ok {
			return err
		}
		if TestHookSubCheck != nil {
			TestHookSubCheck()
		}
		verdict = SubStored
		return insertSub(conn, s)
	})
	return verdict, wrap("insert subscription", err)
}

// subTargetLive is whether the agent or ITSA a subscription names exists, and for an agent isn't archived.
func subTargetLive(conn *sqlite.Conn, kind, id string) (bool, error) {
	switch kind {
	case "agent":
		a, found, err := agentConn(conn, id)
		return found && a.Lifecycle != "archived", err
	case "itsa":
		rows, err := column(conn, "SELECT id FROM itsas WHERE id = ? OR key = ? LIMIT 1", id, id)
		return len(rows) > 0, err
	}
	return true, nil
}

// agentConn is getAgent on a connection: by id or name.
func agentConn(conn *sqlite.Conn, ref string) (a Agent, found bool, err error) {
	err = sqlitex.Execute(conn, selectAgents+" WHERE id = ? OR name = ? LIMIT 1", &sqlitex.ExecOptions{Args: []any{ref, ref}, ResultFunc: func(stmt *sqlite.Stmt) error {
		a, found = scanAgent(stmt), true
		return nil
	}})
	return a, found, err
}

// parentsConn is parentsOf on a connection: the spawning parent plus any that adopted the agent.
func parentsConn(conn *sqlite.Conn, a Agent) ([]string, error) {
	var out []string
	if a.ParentID != nil {
		out = append(out, *a.ParentID)
	}
	adopted, err := column(conn, "SELECT parent_id FROM agent_parents WHERE child_id = ?", a.ID)
	for _, p := range adopted {
		dup := false
		for _, have := range out {
			dup = dup || have == p
		}
		if !dup {
			out = append(out, p)
		}
	}
	return out, err
}

// mayManageTreeConn is src/cost-auth.ts mayManageTree: the human, the assistant, the chief of staff, the root itself or
// any ancestor of the root.
func mayManageTreeConn(conn *sqlite.Conn, by string, root Agent, chiefName string) (bool, error) {
	if by == "human" || by == "stam" {
		return true, nil
	}
	a, found, err := agentConn(conn, by)
	if err != nil || !found {
		return false, err
	}
	if a.Kind != nil && *a.Kind == "assistant" || by == root.ID {
		return true, nil
	}
	if chief, ok, err := agentConn(conn, chiefName); chiefName != "" && err == nil && ok && (chief.Lifecycle == "active" || chief.Lifecycle == "paused") && chief.ID == by {
		return true, nil
	} else if err != nil {
		return false, err
	}
	seen := map[string]bool{}
	stack, err := parentsConn(conn, root)
	if err != nil {
		return false, err
	}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		if id == by {
			return true, nil
		}
		if p, ok, err := agentConn(conn, id); err != nil {
			return false, err
		} else if ok {
			ps, err := parentsConn(conn, p)
			if err != nil {
				return false, err
			}
			stack = append(stack, ps...)
		}
	}
	return false, nil
}

// maySubscribeConn is src/watch.ts maySubscribe on a connection.
func maySubscribeConn(conn *sqlite.Conn, by, kind, id, chiefName string) (bool, error) {
	if by == "human" {
		return true, nil
	}
	actor, found, err := agentConn(conn, by)
	if err != nil || !found {
		return false, err
	}
	switch kind {
	case "human":
		if actor.Kind != nil && *actor.Kind == "assistant" {
			return true, nil
		}
		chief, ok, err := agentConn(conn, chiefName)
		return chiefName != "" && ok && (chief.Lifecycle == "active" || chief.Lifecycle == "paused") && chief.ID == actor.ID, err
	case "agent":
		target, ok, err := agentConn(conn, id)
		if err != nil || !ok {
			return false, err
		}
		if target.ID == actor.ID {
			return true, nil
		}
		return mayManageTreeConn(conn, actor.ID, target, chiefName)
	case "itsa":
		var owner string
		var have bool
		err := sqlitex.Execute(conn, "SELECT COALESCE(owner, '') FROM itsas WHERE id = ? OR key = ? LIMIT 1", &sqlitex.ExecOptions{Args: []any{id, id}, ResultFunc: func(stmt *sqlite.Stmt) error {
			owner, have = stmt.ColumnText(0), true
			return nil
		}})
		if err != nil || !have {
			return false, err
		}
		if owner == actor.ID {
			return true, nil
		}
		ps, err := column(conn, "SELECT agent_id FROM itsa_participants WHERE itsa_id = (SELECT id FROM itsas WHERE id = ? OR key = ? LIMIT 1) AND left_at IS NULL", id, id)
		for _, p := range ps {
			if p == actor.ID {
				return true, err
			}
		}
		return false, err
	}
	return false, nil
}

func insertSub(conn *sqlite.Conn, s Subscription) error {
	var exp any
	if s.ExpiresAt != nil {
		exp = *s.ExpiresAt
	}
	return runSQL(conn, "INSERT INTO event_subscriptions ("+subColumns+") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		s.ID, s.SubscriberKind, s.SubscriberID, s.Filter, s.CreatedBy, sqlValue(s.Note), exp, nil, s.CreatedAt)
}

// FindSubscription is src/watch.ts find: the subscription by id, or ErrNoSubscription.
func (d *DB) FindSubscription(ctx context.Context, id string) (Subscription, error) {
	var subs []Subscription
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		subs, err = querySubs(conn, "WHERE id = ?", id)
		return err
	})
	if err == nil && len(subs) == 0 {
		return Subscription{}, ErrNoSubscription
	}
	if len(subs) == 0 {
		return Subscription{}, wrap("find subscription", err)
	}
	return subs[0], wrap("find subscription", err)
}

// ListSubscriptions is every subscription but a process start row (stam's own, which come back on the next reconcile),
// oldest first (src/watch.ts listSubscriptions before its filter by caller).
func (d *DB) ListSubscriptions(ctx context.Context) (out []Subscription, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = querySubs(conn, "WHERE subscriber_kind != 'process' ORDER BY created_at, rowid")
		return err
	})
	return out, wrap("list subscriptions", err)
}

// ItsaSubscriptions is an ITSA's subscriptions, whatever created them.
func (d *DB) ItsaSubscriptions(ctx context.Context, itsaID string) (out []Subscription, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = querySubs(conn, "WHERE subscriber_kind = 'itsa' AND subscriber_id = ?", itsaID)
		return err
	})
	return out, wrap("ITSA subscriptions", err)
}

// RemoveSubscription deletes the subscription and the delivery it still has folded, in one transaction; false when
// there was none.
func (d *DB) RemoveSubscription(ctx context.Context, id string) (removed bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		removed, err = dropSub(conn, id)
		return err
	})
	return removed, wrap("remove subscription", err)
}

// RemoveSubscriptionBy authorizes `by` and deletes the subscription with its folded delivery in one write transaction,
// like InsertSubscriptionBy. The creator and an agent subscriber may always remove it; anyone else needs the subscribe
// right. allowed is false, and nothing is removed, when `by` has neither; removed is false when there was none.
func (d *DB) RemoveSubscriptionBy(ctx context.Context, id, by, chiefName string) (removed, allowed bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		removed, allowed = false, false
		subs, err := querySubs(conn, "WHERE id = ?", id)
		if err != nil || len(subs) == 0 {
			return err
		}
		sub := subs[0]
		if by != "human" {
			actor, found, err := agentConn(conn, by)
			if err != nil || !found || actor.Lifecycle == "archived" {
				return err
			}
		}
		own := sub.CreatedBy == by || (sub.SubscriberKind == "agent" && sub.SubscriberID == by)
		if !own {
			ok, err := maySubscribeConn(conn, by, sub.SubscriberKind, sub.SubscriberID, chiefName)
			if err != nil || !ok {
				return err
			}
		}
		if TestHookSubCheck != nil {
			TestHookSubCheck()
		}
		allowed = true
		removed, err = dropSub(conn, id)
		return err
	})
	return removed, allowed, wrap("remove subscription", err)
}

func dropSub(conn *sqlite.Conn, id string) (bool, error) {
	if err := runSQL(conn, "DELETE FROM event_subscriptions WHERE id = ?", id); err != nil {
		return false, err
	}
	removed := conn.Changes() > 0
	return removed, runSQL(conn, "DELETE FROM kv WHERE key = ?", queueKey(id))
}

// SetSubscriptionMail records the latest mail of a human subscriber's thread, so later deliveries reply into it. A
// subscription gone by then is left alone.
func (d *DB) SetSubscriptionMail(ctx context.Context, id, mailID string) error {
	return wrap("subscription mail", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "UPDATE event_subscriptions SET last_mail_id = ? WHERE id = ?", mailID, id)
	}))
}

// ForgetAgentEvents drops what an archived or forgotten agent's events hold: the subscriptions that name it as the
// subscriber, the deliveries they have folded, and the notices of its cleared event waits. It returns the ids of the
// subscriptions dropped.
func (d *DB) ForgetAgentEvents(ctx context.Context, agentID string) (dropped []string, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		subs, err := querySubs(conn, "WHERE subscriber_kind = 'agent' AND subscriber_id = ?", agentID)
		if err != nil {
			return err
		}
		seen := map[string]bool{}
		for _, s := range subs {
			if _, err := dropSub(conn, s.ID); err != nil {
				return err
			}
			dropped = append(dropped, s.ID)
			seen[s.ID] = true
		}
		// A queue outlives its subscription (an ending event deletes the subscription and keeps the delivery): it is found
		// through the subscriber it stored.
		orphans, err := column(conn, "SELECT key FROM kv WHERE key LIKE 'evq:%' AND json_extract(value, '$.sub.kind') = 'agent' AND json_extract(value, '$.sub.subscriber_id') = ?", agentID)
		if err != nil {
			return err
		}
		for _, k := range orphans {
			id := strings.TrimPrefix(k, queuePrefix)
			if err := runSQL(conn, "DELETE FROM kv WHERE key = ?", k); err != nil {
				return err
			}
			if !seen[id] {
				dropped = append(dropped, id)
			}
		}
		keys, err := column(conn, "SELECT key FROM kv WHERE key LIKE 'evw:%' AND json_extract(value, '$.agent') = ?", agentID)
		if err != nil {
			return err
		}
		for _, k := range keys {
			if err := runSQL(conn, "DELETE FROM kv WHERE key = ?", k); err != nil {
				return err
			}
		}
		return nil
	})
	return dropped, wrap("forget agent events", err)
}

// ListExtEvents is src/watch.ts events: the events stored, newest first, optionally only those carrying one subject
// key. The subject filter runs in SQL, before the limit, so an old event that matches isn't crowded out by newer ones.
func (d *DB) ListExtEvents(ctx context.Context, subject string, limit int) (out []ExtEvent, err error) {
	q := "SELECT id, source, type, subjects, actor, url, summary, payload, dedupe_key, created_at FROM ext_events "
	args := []any{}
	if subject != "" {
		q += "WHERE EXISTS (SELECT 1 FROM json_each(ext_events.subjects) WHERE value = ?) "
		args = append(args, subject)
	}
	q += "ORDER BY id DESC LIMIT ?"
	args = append(args, limit)
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, q, &sqlitex.ExecOptions{Args: args, ResultFunc: func(stmt *sqlite.Stmt) error {
			ev := ExtEvent{ID: stmt.ColumnInt64(0), Source: stmt.ColumnText(1), Type: stmt.ColumnText(2), Summary: stmt.ColumnText(6), DedupeKey: stmt.ColumnText(8), CreatedAt: stmt.ColumnText(9)}
			if json.Unmarshal([]byte(stmt.ColumnText(3)), &ev.Subjects) != nil || ev.Subjects == nil {
				ev.Subjects = []string{}
			}
			if stmt.ColumnType(4) != sqlite.TypeNull {
				a := stmt.ColumnText(4)
				ev.Actor = &a
			}
			if stmt.ColumnType(5) != sqlite.TypeNull {
				u := stmt.ColumnText(5)
				ev.URL = &u
			}
			// `r.payload ? JSON.parse(r.payload) : null`: an empty text is null too.
			if p := stmt.ColumnText(7); p != "" {
				ev.Payload = json.RawMessage(p)
			} else {
				ev.Payload = json.RawMessage("null")
			}
			out = append(out, ev)
			return nil
		}})
	})
	return out, wrap("list events", err)
}

// ---- the delivery queue ----

// QueueSub is the subscription a queue row delivers for. It is kept in the row, since an ending event deletes the
// subscription before its delivery is made.
type QueueSub struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	SubscriberID string  `json:"subscriber_id"`
	Note         *string `json:"note"`
	// Source is the filter's source, which names the delivery's subject when the subscription has no note.
	Source string `json:"source,omitempty"`
}

// QueueLine is one event's line in a folded delivery. Ended marks the line of an event that ended the subscription;
// Failed one that reports a failure (S-726).
type QueueLine struct {
	Text   string `json:"text"`
	Ended  bool   `json:"ended,omitempty"`
	Failed bool   `json:"failed,omitempty"`
}

// Queue is one subscription's folded delivery.
type Queue struct {
	Sub   QueueSub    `json:"sub"`
	Lines []QueueLine `json:"lines"`
	// Attempts is how many deliveries of the front of the queue failed since it last moved.
	Attempts int `json:"attempts,omitempty"`
}

const (
	queuePrefix = "evq:"
	waitPrefix  = "evw:"
)

func queueKey(subID string) string { return queuePrefix + subID }

func kvGet(conn *sqlite.Conn, key string) (string, bool, error) {
	var v string
	var ok bool
	err := sqlitex.Execute(conn, "SELECT value FROM kv WHERE key = ?", &sqlitex.ExecOptions{Args: []any{key}, ResultFunc: func(stmt *sqlite.Stmt) error {
		v, ok = stmt.ColumnText(0), true
		return nil
	}})
	return v, ok, err
}

func kvPut(conn *sqlite.Conn, key, value string) error {
	return runSQL(conn, "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value)
}

func readQueue(conn *sqlite.Conn, subID string) (Queue, bool, error) {
	v, ok, err := kvGet(conn, queueKey(subID))
	if err != nil || !ok {
		return Queue{}, false, err
	}
	var q Queue
	if err := json.Unmarshal([]byte(v), &q); err != nil {
		return Queue{}, false, fmt.Errorf("queue %s: %w", subID, err)
	}
	return q, true, nil
}

func writeQueue(conn *sqlite.Conn, q Queue) error {
	b, err := json.Marshal(q)
	if err != nil {
		return err
	}
	return kvPut(conn, queueKey(q.Sub.ID), string(b))
}

// ReadQueue is a subscription's folded delivery; ok is false when it has none.
func (d *DB) ReadQueue(ctx context.Context, subID string) (q Queue, ok bool, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		q, ok, err = readQueue(conn, subID)
		return err
	})
	return q, ok, wrap("read event queue", err)
}

// QueueIDs is the ids of the subscriptions that have a folded delivery waiting, as a restart finds them.
func (d *DB) QueueIDs(ctx context.Context) ([]string, error) {
	var keys []string
	err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		keys, err = column(conn, "SELECT key FROM kv WHERE key LIKE 'evq:%' ORDER BY key")
		return err
	})
	for i, k := range keys {
		keys[i] = strings.TrimPrefix(k, queuePrefix)
	}
	return keys, wrap("event queues", err)
}

// AckQueue removes the first n lines of a subscription's queue, which a delivery has made, and returns how many lines
// are left (later events may have joined the queue while it was delivered). A queue with none left is deleted.
func (d *DB) AckQueue(ctx context.Context, subID string, n int) (left int, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		q, ok, err := readQueue(conn, subID)
		if err != nil || !ok {
			return err
		}
		if n > len(q.Lines) {
			n = len(q.Lines)
		}
		q.Lines = q.Lines[n:]
		q.Attempts = 0
		if left = len(q.Lines); left == 0 {
			return runSQL(conn, "DELETE FROM kv WHERE key = ?", queueKey(subID))
		}
		return writeQueue(conn, q)
	})
	return left, wrap("ack event queue", err)
}

// FailQueue counts one failed delivery of a subscription's queue and returns how many have failed in a row.
func (d *DB) FailQueue(ctx context.Context, subID string) (attempts int, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		q, ok, err := readQueue(conn, subID)
		if err != nil || !ok {
			return err
		}
		q.Attempts++
		attempts = q.Attempts
		return writeQueue(conn, q)
	})
	return attempts, wrap("fail event queue", err)
}

// ErrDeliveryStale is a delivery whose subscriber or queue is not as it was read: the transaction that was to make it
// rolled back, and the caller reads again. ErrAgentGone is one whose agent is archived or gone.
var (
	ErrDeliveryStale = errors.New("the delivery's subscriber or queue changed")
	ErrAgentGone     = errors.New("the agent is archived or gone")
)

// AckQueueConn is AckQueue inside a transaction that also makes the delivery, so the two commit together: the first n
// lines go and the count left comes back. A queue that is gone, or shorter than n, is ErrDeliveryStale.
func AckQueueConn(conn *sqlite.Conn, subID string, n int) (left int, err error) {
	q, ok, err := readQueue(conn, subID)
	if err != nil {
		return 0, err
	}
	if !ok || n > len(q.Lines) {
		return 0, ErrDeliveryStale
	}
	q.Lines = q.Lines[n:]
	q.Attempts = 0
	if left = len(q.Lines); left == 0 {
		return 0, runSQL(conn, "DELETE FROM kv WHERE key = ?", queueKey(subID))
	}
	return left, writeQueue(conn, q)
}

// MailCommit is what a mail to a subscriber's mailbox commits with it, in the mail's own transaction: the agent is not
// archived (agentID "" for the human), the first n lines of the queue are removed, and the human's thread pointer moves to
// the mail. Any failure rolls the mail back too, so a delivery is stored with its removal from the queue or not at all.
// left is set to the lines still queued.
func MailCommit(subID string, n int, agentID string, left *int) func(conn *sqlite.Conn, mailID string) error {
	return func(conn *sqlite.Conn, mailID string) error {
		if agentID != "" {
			ok, err := agentLive(conn, agentID)
			if err != nil {
				return err
			}
			if !ok {
				return ErrAgentGone
			}
		}
		l, err := AckQueueConn(conn, subID, n)
		if err != nil {
			return err
		}
		*left = l
		if agentID == "" {
			return runSQL(conn, "UPDATE event_subscriptions SET last_mail_id = ? WHERE id = ?", mailID, subID)
		}
		return nil
	}
}

func agentLive(conn *sqlite.Conn, id string) (bool, error) {
	live := false
	err := sqlitex.Execute(conn, "SELECT 1 FROM agents WHERE id = ? AND lifecycle != 'archived'", &sqlitex.ExecOptions{Args: []any{id}, ResultFunc: func(*sqlite.Stmt) error {
		live = true
		return nil
	}})
	return live, err
}

// DeliverNotice makes a working agent's notice durable and takes the delivery off its queue in one transaction: the text
// is stored as an answer notice (the lifecycle hands it over, a restart puts it back, and the agent's acknowledgement
// removes it) while the first n lines go. The agent must still be working: one that went idle since the caller read it is
// ErrDeliveryStale, one archived or gone ErrAgentGone, and nothing is written for either. row is the notice's row.
func (d *DB) DeliverNotice(ctx context.Context, subID string, n int, agentID, text string) (row int64, left int, err error) {
	err = d.answerWrite(ctx, "deliver notice", func(conn *sqlite.Conn) error {
		row, left = 0, 0
		working := false
		if err := sqlitex.Execute(conn, "SELECT 1 FROM agents WHERE id = ? AND lifecycle = 'active' AND activity = 'working'", &sqlitex.ExecOptions{Args: []any{agentID}, ResultFunc: func(*sqlite.Stmt) error {
			working = true
			return nil
		}}); err != nil {
			return err
		}
		if !working {
			live, err := agentLive(conn, agentID)
			if err != nil {
				return err
			}
			if !live {
				return ErrAgentGone
			}
			return ErrDeliveryStale
		}
		var err error
		if row, err = insertAnswerNotice(conn, agentID, text); err != nil {
			return err
		}
		left, err = AckQueueConn(conn, subID, n)
		return err
	})
	return row, left, err
}

// DeliverWaitNotice makes a cleared event wait's notice durable and removes its stored copy in one transaction, as
// DeliverNotice does for a queue. An agent archived or gone gets none (row 0) and the stored copy goes.
func (d *DB) DeliverWaitNotice(ctx context.Context, waitID, agentID, text string) (row int64, err error) {
	err = d.answerWrite(ctx, "deliver wait notice", func(conn *sqlite.Conn) error {
		var err error
		row = 0
		if text != "" {
			if row, err = insertAnswerNotice(conn, agentID, text); err != nil {
				return err
			}
		}
		return runSQL(conn, "DELETE FROM kv WHERE key = ?", waitPrefix+waitID)
	})
	return row, err
}

// DropQueue deletes a subscription's queue without delivering it.
func (d *DB) DropQueue(ctx context.Context, subID string) error {
	return wrap("drop event queue", d.Write(ctx, func(conn *sqlite.Conn) error {
		return runSQL(conn, "DELETE FROM kv WHERE key = ?", queueKey(subID))
	}))
}

// WaitNotice is the notice of an event wait an event cleared, kept until it is queued for its agent.
type WaitNotice struct {
	WaitID string `json:"-"`
	Agent  string `json:"agent"`
	Text   string `json:"text"`
}

// WaitNotices is the cleared event waits' notices not yet handed to their agents, oldest key first.
func (d *DB) WaitNotices(ctx context.Context) (out []WaitNotice, err error) {
	err = d.Read(ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, "SELECT key, value FROM kv WHERE key LIKE 'evw:%' ORDER BY key", &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			n := WaitNotice{WaitID: strings.TrimPrefix(stmt.ColumnText(0), waitPrefix)}
			if json.Unmarshal([]byte(stmt.ColumnText(1)), &n) == nil {
				out = append(out, n)
			}
			return nil
		}})
	})
	return out, wrap("wait notices", err)
}

// AckWaitNotice removes a cleared event wait's notice once it is queued; false when it was gone already, so a second
// path to the same notice sends nothing.
func (d *DB) AckWaitNotice(ctx context.Context, waitID string) (removed bool, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		if err := runSQL(conn, "DELETE FROM kv WHERE key = ?", waitPrefix+waitID); err != nil {
			return err
		}
		removed = conn.Changes() > 0
		return nil
	})
	return removed, wrap("ack wait notice", err)
}

// ---- ingest ----

// IngestIn is an event as the daemon stores it: the checks and defaults are the caller's.
type IngestIn struct {
	Source, Type string
	Subjects     []string
	Actor, URL   *string
	Summary      string
	// Payload is the JSON text to store, nil for none.
	Payload   *string
	DedupeKey string
}

// Decision is what a subscription does with an event.
type Decision struct {
	// Match is whether the event reaches the subscription.
	Match bool
	// Line is the event's line in the delivery; Ends whether the event ends the subscription (it is deleted in the
	// same transaction, and the delivery stays).
	Line QueueLine
	Ends bool
}

// IngestHooks is what Ingest asks of the caller inside the transaction: pure functions of their arguments.
type IngestHooks struct {
	// Fit decides one subscription. A process start subscription is counted as matched and queues nothing.
	Fit func(sub Subscription, ev ExtEvent) Decision
	// Wait is the notice for an open event wait the event clears, ok false when it doesn't fit.
	Wait func(w Wait, ev ExtEvent) (notice string, ok bool)
	// Now is the clock, in milliseconds since the epoch and as the created_at text.
	Now func() (ms int64, iso string)
}

// IngestOut is what one Ingest stored and did.
type IngestOut struct {
	Stored bool
	Event  ExtEvent
	// Matched counts the subscriptions the event fit; Queued lists the ones whose delivery it joined.
	Matched int
	Queued  []string
	Cleared []ClearedWait
}

// ClearedWait is an event wait the event cleared, with the notice stored for it in the same transaction: the caller
// delivers the notice it is handed, and never reads it back.
type ClearedWait struct {
	Wait   Wait
	Notice WaitNotice
}

// IngestEvent stores an event (a repeat of its dedupe_key is dropped), matches every unexpired subscription and queues
// its line, ends a subscription the event ends, and clears the event waits it fits with their notices kept, all in one
// transaction (src/watch.ts ingest). A restart finds the queue and the notices as the transaction left them.
func (d *DB) IngestEvent(ctx context.Context, in IngestIn, h IngestHooks) (out IngestOut, err error) {
	err = d.Write(ctx, func(conn *sqlite.Conn) (err error) {
		out, err = d.ingestConn(conn, in, h)
		return err
	})
	return out, wrap("ingest event", err)
}

func appendQueue(conn *sqlite.Conn, sub Subscription, line QueueLine) error {
	q, ok, err := readQueue(conn, sub.ID)
	if err != nil {
		return err
	}
	if !ok {
		var f struct {
			Source string `json:"source"`
		}
		_ = json.Unmarshal([]byte(sub.Filter), &f)
		q = Queue{Sub: QueueSub{ID: sub.ID, Kind: sub.SubscriberKind, SubscriberID: sub.SubscriberID, Note: sub.Note, Source: f.Source}}
	}
	q.Lines = append(q.Lines, line)
	return writeQueue(conn, q)
}

// ---- subscriptions stam makes for an ITSA's links ----

// SyncItsaSubscriptions makes an ITSA's link subscriptions match its links (src/watch.ts syncItsa): one on the subject
// each link's URL names (subjectOf, "" for none) while the ITSA is open (closed false), none while it is closed. A
// subscription someone made by hand for the same subject is left alone, and only stam's own are removed. It is one
// transaction and idempotent, so the one pass over every ITSA at daemon start serves too. newID makes a subscription id.
func (d *DB) SyncItsaSubscriptions(ctx context.Context, itsaID string, isClosed func(status string) bool, subjectOf func(url string) string, newID func() string) error {
	return wrap("sync ITSA subscriptions", d.Write(ctx, func(conn *sqlite.Conn) error {
		return syncItsa(conn, itsaID, isClosed, subjectOf, newID)
	}))
}

// SyncAllItsaSubscriptions is SyncItsaSubscriptions for every ITSA, each in its own transaction.
func (d *DB) SyncAllItsaSubscriptions(ctx context.Context, isClosed func(status string) bool, subjectOf func(url string) string, newID func() string) error {
	var ids []string
	if err := d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		ids, err = column(conn, "SELECT id FROM itsas")
		return err
	}); err != nil {
		return wrap("list ITSAs", err)
	}
	for _, id := range ids {
		if err := d.SyncItsaSubscriptions(ctx, id, isClosed, subjectOf, newID); err != nil {
			return err
		}
	}
	return nil
}

// StamSubscriber is created_by for the subscriptions stam makes for itself, such as an ITSA's link ones.
const StamSubscriber = "stam"

func syncItsa(conn *sqlite.Conn, itsaID string, isClosed func(string) bool, subjectOf func(string) string, newID func() string) error {
	status, err := column(conn, "SELECT status FROM itsas WHERE id = ?", itsaID)
	if err != nil || len(status) == 0 {
		return err
	}
	desired := map[string]string{}
	var order []string
	if !isClosed(status[0]) {
		urls, err := column(conn, "SELECT url FROM itsa_links WHERE itsa_id = ? ORDER BY n", itsaID)
		if err != nil {
			return err
		}
		for _, u := range urls {
			if s := subjectOf(u); s != "" {
				if _, ok := desired[s]; !ok {
					desired[s] = "linked " + s
					order = append(order, s)
				}
			}
		}
	}
	existing, err := querySubs(conn, "WHERE subscriber_kind = 'itsa' AND subscriber_id = ?", itsaID)
	if err != nil {
		return err
	}
	present := map[string]bool{}
	for _, sub := range existing {
		s := firstSubject(sub.Filter)
		if sub.CreatedBy == StamSubscriber {
			if _, want := desired[s]; s == "" || !want {
				if _, err := dropSub(conn, sub.ID); err != nil {
					return err
				}
				continue
			}
		}
		if s != "" {
			present[s] = true
		}
	}
	for _, s := range order {
		if present[s] {
			continue
		}
		note := desired[s]
		filter, _ := json.Marshal(struct {
			Subjects []string `json:"subjects"`
		}{[]string{s}})
		if err := insertSub(conn, Subscription{ID: newID(), SubscriberKind: "itsa", SubscriberID: itsaID, Filter: string(filter), CreatedBy: StamSubscriber, Note: &note, CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}); err != nil {
			return err
		}
	}
	return nil
}

// firstSubject is a stored filter's first subject, "" when it has none (src/watch.ts subjectOf).
func firstSubject(filter string) string {
	var f struct {
		Subjects []string `json:"subjects"`
	}
	if json.Unmarshal([]byte(filter), &f) != nil || len(f.Subjects) == 0 {
		return ""
	}
	return f.Subjects[0]
}

// ---- declaring an event wait ----

// EventWaitTx is the reads and writes of declaring an event wait, in one transaction: the check for a wait declared
// already and the insert can't be split by a second declare (src/waits.ts declare).
type EventWaitTx struct {
	d    *DB
	conn *sqlite.Conn
}

// InEventWaitTx runs fn in one write transaction.
func (d *DB) InEventWaitTx(ctx context.Context, fn func(tx EventWaitTx) error) error {
	return wrap("event wait", d.Write(ctx, func(conn *sqlite.Conn) error { return fn(EventWaitTx{d, conn}) }))
}

// Waits is the agent's waits in the order they were declared.
func (t EventWaitTx) Waits(agentID string) ([]Wait, error) {
	ws, err := queryWaits(t.conn, "WHERE agent_id = ? ORDER BY since, rowid", agentID)
	byRank(ws)
	return ws, err
}

// Add adds a wait and syncs its agent's activity.
func (t EventWaitTx) Add(w NewWait) (Wait, error) { return t.d.addWait(t.conn, w) }

// SetTiming is src/db.ts setWaitTiming: a wait's until and data, and the agent's activity synced; the wait after.
func (t EventWaitTx) SetTiming(id string, until *string, data string) (Wait, error) {
	ws, err := queryWaits(t.conn, "WHERE id = ?", id)
	if err != nil || len(ws) == 0 {
		return Wait{}, err
	}
	if err := runSQL(t.conn, "UPDATE waits SET until = ?, data = ? WHERE id = ?", sqlValue(until), data, id); err != nil {
		return Wait{}, err
	}
	if err := t.d.syncWaits(t.conn, ws[0].AgentID); err != nil {
		return Wait{}, err
	}
	ws, err = queryWaits(t.conn, "WHERE id = ?", id)
	if err != nil || len(ws) == 0 {
		return Wait{}, err
	}
	return ws[0], nil
}

// AddEvent records an agent event in the transaction.
func (t EventWaitTx) AddEvent(agentID, typ string, data any) error {
	return insertEvent(t.conn, agentID, typ, data)
}

// ingestConn is one event's ingest inside the caller's transaction.
func (d *DB) ingestConn(conn *sqlite.Conn, in IngestIn, h IngestHooks) (out IngestOut, err error) {
	err = func() error {
		ms, iso := h.Now()
		subjects, _ := json.Marshal(in.Subjects)
		if in.Subjects == nil {
			subjects = []byte("[]")
		}
		if err := runSQL(conn, "INSERT OR IGNORE INTO ext_events (source, type, subjects, actor, url, summary, payload, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			in.Source, in.Type, string(subjects), sqlValue(in.Actor), sqlValue(in.URL), in.Summary, sqlValue(in.Payload), in.DedupeKey, iso); err != nil {
			return err
		}
		if conn.Changes() == 0 {
			return nil
		}
		ev := ExtEvent{ID: conn.LastInsertRowID(), Source: in.Source, Type: in.Type, Subjects: in.Subjects, Actor: in.Actor, URL: in.URL, Summary: in.Summary, DedupeKey: in.DedupeKey, CreatedAt: iso}
		if ev.Subjects == nil {
			ev.Subjects = []string{}
		}
		if in.Payload != nil {
			ev.Payload = json.RawMessage(*in.Payload)
		}
		out.Stored, out.Event = true, ev
		// Expired subscriptions go as they are found, as src/watch.ts liveSubscriptions does.
		if err := runSQL(conn, "DELETE FROM event_subscriptions WHERE expires_at IS NOT NULL AND expires_at <= ?", ms); err != nil {
			return err
		}
		subs, err := querySubs(conn, "ORDER BY created_at, rowid")
		if err != nil {
			return err
		}
		for _, sub := range subs {
			dec := h.Fit(sub, ev)
			if !dec.Match {
				continue
			}
			out.Matched++
			if sub.SubscriberKind == "process" {
				continue
			}
			if err := appendQueue(conn, sub, dec.Line); err != nil {
				return err
			}
			out.Queued = append(out.Queued, sub.ID)
			// An ending event is delivered from the queued copy: the row goes now, the delivery stays.
			if dec.Ends {
				if err := runSQL(conn, "DELETE FROM event_subscriptions WHERE id = ?", sub.ID); err != nil {
					return err
				}
			}
		}
		// A declared event wait clears on the first event that fits its filter.
		open, err := queryWaits(conn, "WHERE kind = 'event' AND agent_id IN (SELECT id FROM agents) ORDER BY since, rowid")
		if err != nil {
			return err
		}
		for _, w := range open {
			notice, ok := h.Wait(w, ev)
			if !ok {
				continue
			}
			if _, err := d.clearWait(conn, w.ID); err != nil {
				return err
			}
			n := WaitNotice{WaitID: w.ID, Agent: w.AgentID, Text: notice}
			b, _ := json.Marshal(n)
			if err := kvPut(conn, waitPrefix+w.ID, string(b)); err != nil {
				return err
			}
			out.Cleared = append(out.Cleared, ClearedWait{Wait: w, Notice: n})
		}
		return nil
	}()
	return out, err
}
