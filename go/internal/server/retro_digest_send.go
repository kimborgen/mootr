package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/mcp"
)

// The stores behind the retro digest and the Retros view (src/retro-digest.ts gather, retros, retrosOfType,
// sendDigest), and their routes. The digest's timer, early start and steward stay in TS for now.

const retrosDays = 30

// digestDays are src/settings.ts DIGEST_CADENCES: daily, or one weekday.
var digestDays = []string{"daily", "sun", "mon", "tue", "wed", "thu", "fri", "sat"}

func (s *Server) retroDigestRoutes() {
	s.handle("GET /api/retros", s.retrosRoute)
	s.handle("POST /api/retros/digest", s.retroDigestRoute)
}

var reTypeName = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

// retrosRoute is GET /api/retros (S-162): the open retro items, the effort split and coverage since a time (the last
// 30 days by default), or with `type=NAME` the memory of an agent type (S-888), all time, open and done.
func (s *Server) retrosRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	ctx := context.WithoutCancel(r.Context())
	q := r.URL.Query()
	since := q.Get("since")
	at, ok := retrosSince(since)
	if since != "" && !ok {
		return nil, Errorf(http.StatusBadRequest, "since must be an ISO time")
	}
	typ := q.Get("type")
	if typ != "" && !reTypeName.MatchString(typ) {
		return nil, Errorf(http.StatusBadRequest, "type must be an agent type name")
	}
	if typ != "" {
		return s.retrosOfType(ctx, typ)
	}
	if since == "" {
		at = time.Now().Add(-retrosDays * 24 * time.Hour)
	}
	rows, err := s.gatherRetros(ctx, isoMS(at), false)
	if err != nil {
		return nil, err
	}
	return buildRetros(rows), nil
}

// retrosSince is new Date(since) for an ISO date-time with its zone, or a date alone (midnight UTC). TS's Date.parse
// also takes forms that aren't ISO; those are a 400 here.
func retrosSince(since string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339Nano, since); err == nil {
		return t, true
	}
	t, err := time.Parse("2006-01-02", since)
	return t, err == nil
}

// isoMS is Date.toISOString.
func isoMS(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// retroDigestRoute is POST /api/retros/digest (S-161): the digest now. Only the human, the CLI's shared token or the
// timer: an agent's token would mail the digest's recipients at will (S-587).
func (s *Server) retroDigestRoute(r *http.Request, c auth.Resolved) (any, error) {
	if msg := auth.NotAgentToken(c.Caller, "send the retro digest"); msg != "" {
		return nil, Errorf(http.StatusForbidden, "%s", msg)
	}
	return s.sendDigest(context.WithoutCancel(r.Context()), time.Now())
}

// counted is a thread's +1s: the times of its `+1 from` and `Reported again by` comments.
func (s *Server) counted(ctx context.Context, x jsfmt.Value) ([]string, error) {
	out := []string{}
	tid := x.Text("thread_id")
	if tid == "" {
		return out, nil
	}
	mails, err := s.db.ThreadMail(ctx, tid, "")
	if err != nil {
		return nil, err
	}
	for _, m := range mails {
		if plusOneLine.MatchString(m.Text("body")) {
			out = append(out, m.Text("created_at"))
		}
	}
	return out, nil
}

func (s *Server) itsasOfKind(ctx context.Context, kind string) ([]jsfmt.Value, error) {
	return s.db.ListItsas(ctx, db.ItsaFilter{Kind: &kind})
}

func retroRow(x jsfmt.Value, plusOnes int, report *bool) digestItem {
	f := mcp.HeaderFields(x.Text("body"))
	return digestItem{ID: x.Text("id"), Key: x.Text("key"), Title: x.Text("title"), Status: x.Text("status"), CreatedAt: x.Text("created_at"),
		Kind: f.Kind, Target: f.Target, Evidence: f.Evidence, When: f.When, PlusOnes: plusOnes, Report: report}
}

// gatherRetros is src/retro-digest.ts gather: the open retro items and reports created or +1'd since then, the final
// rounds and archives since then, and the loop rows; live adds the measured split of the agents not archived yet.
func (s *Server) gatherRetros(ctx context.Context, since string, live bool) (digestRows, error) {
	rows := digestRows{Items: []digestItem{}, Rounds: []digestRound{}, Archived: []digestArchived{}, Live: []digestLive{}}
	loop := loopRows{Since: since, Items: []loopItem{}, Answers: []loopAnswer{}}
	for _, kind := range []string{retroKind, reportKind} {
		list, err := s.itsasOfKind(ctx, kind)
		if err != nil {
			return rows, err
		}
		for _, x := range list {
			counted, err := s.counted(ctx, x)
			if err != nil {
				return rows, err
			}
			// Every retro item, open or closed, feeds the loop metrics (S-806).
			if kind == retroKind {
				loop.Items = append(loop.Items, loopItem{Key: x.Text("key"), Target: mcp.HeaderFields(x.Text("body")).Target, CreatedAt: x.Text("created_at"), PlusOnes: counted})
			}
			if x.Text("closed_at") != "" {
				continue
			}
			if x.Text("created_at") < since && countSince(counted, since) == 0 {
				continue
			}
			report := kind == reportKind
			rows.Items = append(rows.Items, retroRow(x, len(counted), &report))
		}
	}

	// The proposals closed as done that answered retro items, and the instruction word delta of those merged in the
	// period, per file.
	proposals, err := s.itsasOfKind(ctx, proposalKind)
	if err != nil {
		return rows, err
	}
	var words []wordDelta
	wi := map[string]int{}
	for _, x := range proposals {
		closed := x.Text("closed_at")
		loop.Answers = append(loop.Answers, answeredTargets(x.Text("key"), x.Text("status"), closed, x.Text("body"))...)
		if x.Text("status") != "done" || closed == "" || closed < since {
			continue
		}
		for _, w := range wordsInDiff(x.Text("body")) {
			i, ok := wi[w.File]
			if !ok {
				i = len(words)
				wi[w.File] = i
				words = append(words, wordDelta{File: w.File})
			}
			words[i].Delta += w.Delta
		}
	}
	loop.Words = nonZero(words)
	rows.Loop = &loop

	agents, err := s.db.ListAgents(ctx)
	if err != nil {
		return rows, err
	}
	byID := map[string]db.Agent{}
	for _, a := range agents {
		byID[a.ID] = a
	}
	nameOf := func(id string) string {
		if a, ok := byID[id]; ok {
			return a.Name
		}
		return id
	}
	finals, err := s.db.EventsSince(ctx, "retro_final", since)
	if err != nil {
		return rows, err
	}
	for _, e := range finals {
		rows.Rounds = append(rows.Rounds, roundOf(nameOf(e.AgentID), e.Data))
	}
	first, err := s.db.FirstEventTime(ctx, "retro_final")
	if err != nil {
		return rows, err
	}
	if from := archiveWindow(since, first); from != nil {
		ids, err := s.db.EventAgents(ctx, "archive", from)
		if err != nil {
			return rows, err
		}
		for _, id := range ids {
			has, err := s.db.HasEvent(ctx, id, "retro_final")
			if err != nil {
				return rows, err
			}
			data, found, err := s.db.LastEventData(ctx, id, "archive:round-skipped")
			if err != nil {
				return rows, err
			}
			a := digestArchived{Name: nameOf(id), HasRound: has}
			if found {
				a.Reason = reasonOf(data)
			}
			rows.Archived = append(rows.Archived, a)
		}
	}
	if !live {
		return rows, nil
	}
	// Agents active in the period and not archived yet: their measured split, live (S-227).
	ever, err := s.db.EventAgents(ctx, "archive", nil)
	if err != nil {
		return rows, err
	}
	archived := map[string]bool{}
	for _, id := range ever {
		archived[id] = true
	}
	windows, err := s.fixWindows(ctx)
	if err != nil {
		return rows, err
	}
	active, err := s.db.ActivityAgentsSince(ctx, since)
	if err != nil {
		return rows, err
	}
	for _, id := range active {
		if archived[id] {
			continue
		}
		m, err := s.measuredBetween(ctx, id, since, db.EffortUntil, windows)
		if err != nil {
			return rows, err
		}
		if m == nil {
			continue
		}
		l := digestLive{Name: nameOf(id), Measured: splitMap(m.Split)}
		if a, ok := byID[id]; ok {
			l.Model, l.Type = a.Model, a.Type
		}
		rows.Live = append(rows.Live, l)
	}
	return rows, nil
}

// archiveWindow is src/retro-digest.ts archiveWindow: archives count from the window's start, or the first final round
// if that is later; with no final round ever, nothing counts.
func archiveWindow(since string, first *string) *string {
	if first == nil {
		return nil
	}
	if *first > since {
		return first
	}
	return &since
}

func splitMap(e effortSplit) map[string]float64 {
	out := map[string]float64{}
	for _, k := range effortKeys {
		out[k] = *e.at(k)
	}
	return out
}

// numbersOf is an object's number members; nil when v is null or absent (`?? null`).
func numbersOf(v json.RawMessage) map[string]float64 {
	var m map[string]any
	if json.Unmarshal(v, &m) != nil || m == nil {
		return nil
	}
	out := map[string]float64{}
	for k, x := range m {
		if n, ok := x.(float64); ok {
			out[k] = n
		}
	}
	return out
}

// roundOf is one retro_final event as a round: its effort (`?? {}`), and its model, type and measured split (`?? null`).
func roundOf(name string, data *string) digestRound {
	var d struct {
		Model    *string         `json:"model"`
		Type     *string         `json:"type"`
		Effort   json.RawMessage `json:"effort"`
		Measured json.RawMessage `json:"measured"`
	}
	if data != nil {
		_ = json.Unmarshal([]byte(*data), &d)
	}
	r := digestRound{Name: name, Model: d.Model, Type: d.Type, Effort: numbersOf(d.Effort), Measured: numbersOf(d.Measured)}
	if r.Effort == nil {
		r.Effort = map[string]float64{}
	}
	return r
}

// reasonOf is an archive:round-skipped event's reason, nil when it has none.
func reasonOf(data *string) *string {
	if data == nil {
		return nil
	}
	var d struct {
		Reason *string `json:"reason"`
	}
	_ = json.Unmarshal([]byte(*data), &d)
	return d.Reason
}

var (
	// reReporter is the `Reporter: name (model, type)` line, in the first paragraph.
	reReporter   = regexp.MustCompile(`(?m)^Reporter: [^\n\r\x{2028}\x{2029}]*\(([^()]*)\)[` + mcp.JSSpace + `]*$`)
	reFirstBlank = regexp.MustCompile(`\n[` + mcp.JSSpace + `]*\n`)
)

// reporterType is the type of the agent that filed an item: its creator's type, or the last part of its Reporter line
// when the creator is gone.
func (s *Server) reporterType(ctx context.Context, x jsfmt.Value) (string, error) {
	a, err := s.db.GetAgent(ctx, x.Text("created_by"))
	if err != nil && !errors.Is(err, db.ErrNotFound) {
		return "", err
	}
	if err == nil && a.Type != nil && *a.Type != "" {
		return *a.Type, nil
	}
	body := x.Text("body")
	if loc := reFirstBlank.FindStringIndex(body); loc != nil {
		body = body[:loc[0]]
	}
	m := reReporter.FindStringSubmatch(body)
	if m == nil {
		return "", nil
	}
	parts := strings.Split(m[1], ",")
	return strings.TrimFunc(parts[len(parts)-1], mcp.IsJSSpace), nil
}

// retrosOfType is src/retro-digest.ts retrosOfType (S-888): the retro items an agent type's agents reported, or aimed
// at its template `type-NAME` or one of its block ids, open or done.
func (s *Server) retrosOfType(ctx context.Context, typ string) (retrosView, error) {
	targets := map[string]bool{"type-" + typ: true}
	blocks, err := s.tpl.BlocksOf("type-" + typ)
	if err != nil {
		return retrosView{}, err
	}
	for _, b := range blocks {
		targets[b.ID] = true
	}
	list, err := s.itsasOfKind(ctx, retroKind)
	if err != nil {
		return retrosView{}, err
	}
	items := []digestItem{}
	for _, x := range list {
		if x.Text("closed_at") != "" && x.Text("status") != "done" {
			continue
		}
		t, err := s.reporterType(ctx, x)
		if err != nil {
			return retrosView{}, err
		}
		if t != typ && !targets[mcp.HeaderFields(x.Text("body")).Target] {
			continue
		}
		counted, err := s.counted(ctx, x)
		if err != nil {
			return retrosView{}, err
		}
		items = append(items, retroRow(x, len(counted), nil))
	}
	return buildRetros(digestRows{Items: items}), nil
}

// digestResult is src/retro-digest.ts DigestResult.
type digestResult struct {
	Sent   bool    `json:"sent"`
	To     *string `json:"to"`
	Reason string  `json:"reason"`
}

// digestRecipients is src/retro-digest.ts digestRecipients (S-1059): the Retros ITSA's owner when live, else the chief
// of staff, then its live participants; never the human, once each.
func digestRecipients(owner string, participants []string, live func(string) bool, cos string) []string {
	var out []string
	add := func(ref string) {
		if ref == "" || ref == "human" {
			return
		}
		for _, x := range out {
			if x == ref {
				return
			}
		}
		out = append(out, ref)
	}
	if owner != "" && live(owner) {
		add(owner)
	} else {
		add(cos)
	}
	for _, p := range participants {
		if live(p) {
			add(p)
		}
	}
	return out
}

// digestLive is src/retro-digest.ts digestLive: a local agent counts by its lifecycle, a peer agent by the lifecycle
// the peer cache last saw, unless that is archived or shut down.
func (s *Server) digestLive(ctx context.Context, ref string) bool {
	if a, err := s.db.GetAgent(ctx, ref); err == nil {
		return a.Lifecycle == "active" || a.Lifecycle == "paused"
	}
	if _, ok, err := s.db.PeerAgentByID(ctx, ref); err != nil || !ok {
		return false
	}
	l, _, err := s.db.PeerAgentLifecycle(ctx, ref)
	return err == nil && l != "archived" && l != "shut_down"
}

// retroSettings is settings.retro as the view reads it: the object, its digest day (daily unless a known one), and
// lastDigest (nil unless a string).
func (s *Server) retroSettings() (retro *jsjson.Object, day string, last *string) {
	retro = jsjson.NewObject()
	if v, ok := s.settings.View().Get("retro"); ok {
		if o, ok := jsjson.Clone(v).(*jsjson.Object); ok {
			retro = o
		}
	}
	day = "daily"
	if d, ok := retro.Get("digest"); ok {
		if o, ok := d.(*jsjson.Object); ok {
			if v, ok := o.Get("day"); ok {
				for _, k := range digestDays {
					if v == k {
						day = k
					}
				}
			}
		}
	}
	if v, ok := retro.Get("lastDigest"); ok {
		if t, ok := v.(string); ok {
			last = &t
		}
	}
	return retro, day, last
}

// sendDigest is src/retro-digest.ts sendDigest: the digest to the Retros ITSA's owner and participants (S-1059) as stam,
// in a new thread, with when it went recorded (or when there was nothing new, so the same window isn't read again).
// Without a recipient nothing is recorded, so the next try reads it again.
func (s *Server) sendDigest(ctx context.Context, now time.Time) (digestResult, error) {
	if s.settings.Get().Itsa.Home != s.cfg.Machine {
		return digestResult{Reason: "not the ITSA home"}, nil
	}
	parents, err := s.itsasOfKind(ctx, retrosParentKind)
	if err != nil {
		return digestResult{}, err
	}
	var owner string
	var participants []string
	for _, x := range parents {
		if x.Text("title") == retrosParentTitle {
			owner = x.Text("owner")
			if p, ok := x.Get("participants"); ok {
				for _, v := range p.Items {
					participants = append(participants, v.Str)
				}
			}
			break
		}
	}
	to := digestRecipients(owner, participants, func(ref string) bool { return s.digestLive(ctx, ref) }, s.settings.Get().ChiefOfStaff)
	if len(to) == 0 {
		return digestResult{Reason: "no Retros owner or chief of staff to send it"}, nil
	}
	// The result names who it went to, so a caller (and the CLI) reads names, not ids.
	names := make([]string, len(to))
	for i, ref := range to {
		names[i] = ref
		if a, err := s.db.GetAgent(ctx, ref); err == nil {
			names[i] = a.Name
		} else if p, ok, _ := s.db.PeerAgentByID(ctx, ref); ok {
			names[i] = p.Name
		}
	}
	who := strings.Join(names, ", ")
	retro, day, last := s.retroSettings()
	if last == nil {
		back := 24 * time.Hour
		if day != "daily" {
			back *= 7
		}
		t := isoMS(now.Add(-back))
		last = &t
	}
	label := digestLabel(now, day)
	rows, err := s.gatherRetros(ctx, *last, true)
	if err != nil {
		return digestResult{}, err
	}
	text, ok := buildDigest(rows, label)
	record := func() error {
		retro.Set("lastDigest", isoMS(now))
		return s.settings.SetShared("retro", retro)
	}
	if !ok {
		if err := record(); err != nil {
			return digestResult{}, err
		}
		return digestResult{To: &who, Reason: "nothing new since the last digest"}, nil
	}
	sent := s.sendFromSystem(ctx, "retro", to, "Retro digest: "+label, text)
	res := digestResult{Sent: sent, To: &who}
	if sent {
		if err := record(); err != nil {
			return digestResult{}, err
		}
	} else {
		res.Reason = "no agent to send it"
	}
	return res, nil
}
