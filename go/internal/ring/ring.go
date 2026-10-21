// Package ring is src/ring.ts: several agents work on one topic together. Formats: rounds (every member submits in parallel, then all
// read all submissions), fire (one at a time, each seeing everything before it) and debate (like fire, arguing a position). An
// optional moderator reads each completed round and either only facilitates or decides.
//
// Every operation is one transaction over the ring tables: the check of a round and the move that follows it are one step, so two
// submissions that complete a round cannot both advance it. The notices and the mail a step produces are returned as effects, for the
// caller to carry out after the commit: they touch memory and other processes, never the write path.
package ring

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// Effect is something a step does once it has committed: a notice queued for an agent (a ring turn, held for the agent's next idle
// push), or the mail stam sends when a ring ends.
type Effect struct {
	// Agent is the notice's recipient; To, Subject and Body the mail's.
	Agent, Text   string
	To            []string
	Subject, Body string
}

// Engine is the ring's logic over a template renderer (name, vars -> text).
type Engine struct {
	Render func(name string, vars map[string]string) (string, error)
	// Entered is called as a submit starts, before its transaction, and Wrote right after the submission is stored inside it. They are
	// test hooks: a test holds one submit between its write and its commit until the other has started.
	Entered, Wrote func(agent string)
}

// Ring is a ring's row.
type Ring struct {
	ID, Name, Format, Topic string
	Members                 []string
	ModeratorID             string
	ModeratorDecides        bool
	CreatedBy               string
	Round, Turn, MaxRounds  int
	Status                  string
	Note                    string
}

// Sub is one member's submission.
type Sub struct {
	Round   int
	Agent   string
	Text    string
	Agree   bool
	Verdict string
}

const (
	approve        = "approve"
	requestChanges = "request_changes"
	human          = "human"
)

var formatHelp = map[string]string{
	"rounds": "Every member answers in parallel. After each round you all see every submission. Build on the others, and say where you disagree.",
	"fire":   "Members answer one at a time. Read everything before you, then improve on it, correct it, or add what is missing.",
	"debate": "Argue a clear position and answer the strongest points of the others. Concede only when convinced.",
}

// Go's \s is ASCII only, so \p{Z} and the byte-order mark add the spaces JS's \s has.
const sp = `[\s\x0B\p{Z}\x{feff}]`

var (
	rePR        = regexp.MustCompile(`(?i)\b(?:PR|pull request)` + sp + `*#?(\d+)\b`)
	reChanges   = regexp.MustCompile(`(?i)\brequest(?:ed|ing|s)?[_ ]changes\b|\bchanges requested\b`)
	reApprove   = regexp.MustCompile(`(?i)^verdict` + sp + `*:` + sp + `*approve$`)
	reManyLines = regexp.MustCompile(`\n{3,}`)
)

// VerdictLine is verdictLine: the instruction a ring that reviews one PR carries, "" when the topic names no PR, or more than one.
func VerdictLine(topic string, moderated bool) string {
	prs := map[string]bool{}
	var first string
	for _, m := range rePR.FindAllStringSubmatch(topic, -1) {
		if len(prs) == 0 {
			first = m[1]
		}
		prs[m[1]] = true
	}
	if len(prs) != 1 {
		return ""
	}
	who := "Members don't post the verdict. When the ring ends on a verdict, its creator runs this"
	if moderated {
		who = "When the moderator ends it on a verdict, the moderator runs this"
	}
	return fmt.Sprintf("This ring reviews PR %s. %s with the pr_review tool (pr %s, approve or request_changes, a one-line summary, and head: the full sha of the PR's head the review checked)", first, who, first)
}

// VerdictOf is verdictOf: a member's PR verdict, the one it passed, else one its text states. Approval is never read from prose, only
// a line that is just `Verdict: approve`. "" when the ring reviews no PR or nothing states one. given is nil when none was passed.
func VerdictOf(topic, text string, given *string) (string, error) {
	if VerdictLine(topic, false) == "" {
		return "", nil
	}
	if given != nil {
		if *given == approve || *given == requestChanges {
			return *given, nil
		}
		if *given != "" {
			return "", errors.New("verdict must be approve or request_changes")
		}
	}
	if reChanges.MatchString(text) {
		return requestChanges, nil
	}
	for _, line := range strings.Split(text, "\n") {
		if reApprove.MatchString(jsjson.Trim(line)) {
			return approve, nil
		}
	}
	return "", nil
}

// SplitLine is splitLine: each member's verdict in a PR ring's round whose verdicts don't all match, "" when they do.
func SplitLine(topic string, subs []Sub, name func(string) string) string {
	if VerdictLine(topic, false) == "" || len(subs) == 0 {
		return ""
	}
	same := true
	for _, s := range subs {
		if s.Verdict == "" || s.Verdict != subs[0].Verdict {
			same = false
		}
	}
	if same {
		return ""
	}
	parts := make([]string, len(subs))
	for i, s := range subs {
		v := s.Verdict
		if v == "" {
			v = "no verdict"
		}
		parts[i] = name(s.Agent) + ": " + v
	}
	return strings.Join(parts, ", ")
}

// finishBody is the mail when a ring ends.
func (e Engine) finishBody(r Ring, reason, outcome string) (string, error) {
	return e.Render("ring-finished", map[string]string{"ring": r.Name, "format": r.Format, "round": strconv.Itoa(r.Round), "reason": reason,
		"topic": r.Topic, "outcome": outcome, "pr": VerdictLine(r.Topic, r.ModeratorID != "")})
}

func num(v jsfmt.Value, key string) int {
	x, _ := v.Get(key)
	n, _ := strconv.Atoi(x.Num)
	return n
}

func ringOf(v jsfmt.Value) Ring {
	r := Ring{ID: v.Text("id"), Name: v.Text("name"), Format: v.Text("format"), Topic: v.Text("topic"), ModeratorID: v.Text("moderator_id"),
		CreatedBy: v.Text("created_by"), Round: num(v, "round"), Turn: num(v, "turn"), MaxRounds: num(v, "max_rounds"), Status: v.Text("status"), Note: v.Text("note")}
	r.ModeratorDecides = num(v, "moderator_decides") != 0
	if m, err := jsfmt.Parse([]byte(v.Text("members"))); err == nil && m.Kind == jsfmt.Array {
		for _, it := range m.Items {
			r.Members = append(r.Members, it.Str)
		}
	}
	return r
}

func subOf(v jsfmt.Value) Sub {
	return Sub{Round: num(v, "round"), Agent: v.Text("agent_id"), Text: v.Text("text"), Agree: num(v, "agree") != 0, Verdict: v.Text("verdict")}
}

// session is one transaction's view: names and forwarding are read once.
type session struct {
	e       Engine
	tx      db.RingTx
	effects []Effect
	names   map[string]string
}

func (s *session) get(ref string) (Ring, bool, error) {
	v, ok, err := s.tx.Ring(ref)
	if err != nil || !ok {
		return Ring{}, false, err
	}
	return ringOf(v), true, nil
}

func (s *session) subs(r Ring, round int) ([]Sub, error) {
	found, err := s.tx.Subs(r.ID, round)
	out := make([]Sub, len(found))
	for i, v := range found {
		out[i] = subOf(v)
	}
	return out, err
}

func (s *session) name(id string) string {
	if id == human {
		return "the human"
	}
	if n, ok := s.names[id]; ok {
		return n
	}
	_, n, _, _, ok, _ := s.tx.Agent(id)
	if !ok {
		n = id
	}
	s.names[id] = n
	return n
}

// standsFor is whether agentID holds the seat of member id: itself, or the successor its cost_switch takeover records.
func (s *session) standsFor(id, agentID string) (bool, error) {
	if id == "" {
		return false, nil
	}
	if id == agentID {
		return true, nil
	}
	t, err := s.tx.ForwardTarget(id)
	return t == agentID, err
}

func (s *session) history(r Ring) (string, error) {
	all, err := s.subs(r, 0)
	if err != nil {
		return "", err
	}
	if len(all) == 0 && r.Note == "" {
		return "No submissions yet.", nil
	}
	var lines []string
	for _, x := range all {
		var tags []string
		if x.Verdict != "" {
			tags = append(tags, x.Verdict)
		}
		if x.Agree {
			tags = append(tags, "agrees to end")
		}
		tag := ""
		if len(tags) > 0 {
			tag = " (" + strings.Join(tags, ", ") + ")"
		}
		lines = append(lines, fmt.Sprintf("### Round %d, %s%s\n%s", x.Round, s.name(x.Agent), tag, x.Text))
	}
	if r.Round > 1 {
		prev, err := s.subs(r, r.Round-1)
		if err != nil {
			return "", err
		}
		if split := SplitLine(r.Topic, prev, s.name); split != "" {
			lines = append(lines, fmt.Sprintf("### The verdicts don't all match in round %d\n%s. Read each other's findings: the ring ends early only when every member gives the same verdict.", r.Round-1, split))
		}
	}
	if r.Note != "" {
		lines = append(lines, "### Moderator's note\n"+r.Note)
	}
	return "Submissions so far:\n\n" + strings.Join(lines, "\n\n"), nil
}

func (s *session) update(r Ring, fields ...db.RingField) (Ring, error) {
	if err := s.tx.Update(r.ID, fields...); err != nil {
		return r, err
	}
	n, _, err := s.get(r.ID)
	return n, err
}

// turnPrompt is a member's turn prompt: the topic, the format's rules, and everything submitted so far.
func (s *session) turnPrompt(r Ring, agentID string) (string, error) {
	hist, err := s.history(r)
	if err != nil {
		return "", err
	}
	members := make([]string, len(r.Members))
	for i, m := range r.Members {
		members[i] = s.name(m)
	}
	verdict := ""
	if VerdictLine(r.Topic, false) != "" {
		verdict = "Give your verdict on the PR in ring_submit's verdict (approve or request_changes), or as a line of its own in your text: `Verdict: approve` or `Verdict: request_changes`. Your agree is about your own verdict: the ring ends early only when every member's verdict is the same."
	}
	text, err := s.e.Render("ring-turn", map[string]string{"ring": r.Name, "ring_id": r.ID, "format": r.Format, "round": strconv.Itoa(r.Round),
		"max_rounds": strconv.Itoa(r.MaxRounds), "member": s.name(agentID), "members": strings.Join(members, ", "), "topic": r.Topic,
		"instructions": formatHelp[r.Format], "pr": VerdictLine(r.Topic, r.ModeratorID != ""), "verdict": verdict, "history": hist})
	if err != nil {
		return "", err
	}
	return reManyLines.ReplaceAllString(text, "\n\n"), nil
}

// prompt: the turn goes to the member's live successor when it was taken over: a held predecessor runs nothing.
func (s *session) prompt(r Ring, agentID string) error {
	to, err := s.tx.ForwardTarget(agentID)
	if err != nil {
		return err
	}
	text, err := s.turnPrompt(r, agentID)
	if err != nil {
		return err
	}
	s.effects = append(s.effects, Effect{Agent: to, Text: text})
	return nil
}

// advance prompts whoever's turn it is: every member for rounds, the next member otherwise.
func (s *session) advance(r Ring) error {
	if r.Format == "rounds" {
		for _, id := range r.Members {
			if err := s.prompt(r, id); err != nil {
				return err
			}
		}
		return nil
	}
	return s.prompt(r, r.Members[r.Turn%len(r.Members)])
}

// agreement is whether the round's members agree, and the split line when their verdicts don't all match.
func (s *session) agreement(r Ring) (split string, all bool, err error) {
	subs, err := s.subs(r, r.Round)
	if err != nil {
		return "", false, err
	}
	split = SplitLine(r.Topic, subs, s.name)
	all = split == "" && len(subs) >= len(r.Members)
	for _, x := range subs {
		all = all && x.Agree
	}
	return split, all, nil
}

func (s *session) moderatePrompt(r Ring) (string, error) {
	split, all, err := s.agreement(r)
	if err != nil {
		return "", err
	}
	hist, err := s.history(r)
	if err != nil {
		return "", err
	}
	instructions := "Not all members agree yet."
	if split != "" {
		instructions = "The members' verdicts don't all match (" + split + "), so they don't agree yet."
	} else if all {
		instructions = "All members agree to end."
	}
	decide := ", which you should do only when the members agree or the last round is done"
	if r.ModeratorDecides {
		decide = " with your decision"
	}
	return s.e.Render("ring-moderate", map[string]string{"ring": r.Name, "ring_id": r.ID, "format": r.Format, "round": strconv.Itoa(r.Round),
		"max_rounds": strconv.Itoa(r.MaxRounds), "topic": r.Topic, "history": hist, "instructions": instructions, "decide": decide, "pr": VerdictLine(r.Topic, true)})
}

func (s *session) notifyModerator(r Ring) error {
	to, err := s.tx.ForwardTarget(r.ModeratorID)
	if err != nil {
		return err
	}
	text, err := s.moderatePrompt(r)
	if err != nil {
		return err
	}
	s.effects = append(s.effects, Effect{Agent: to, Text: text})
	return nil
}

func (s *session) roundComplete(r Ring) error {
	if r.ModeratorID != "" {
		r, err := s.update(r, db.RingField{Name: "status", Value: "moderating"})
		if err != nil {
			return err
		}
		return s.notifyModerator(r)
	}
	split, all, err := s.agreement(r)
	if err != nil {
		return err
	}
	if all {
		return s.finish(r, "all members agreed", nil)
	}
	if r.Round >= r.MaxRounds {
		reason := "the last round ended"
		if split != "" {
			reason = "split (" + split + ")"
		}
		return s.finish(r, reason, nil)
	}
	n, err := s.update(r, db.RingField{Name: "round", Value: r.Round + 1}, db.RingField{Name: "note", Value: nil})
	if err != nil {
		return err
	}
	return s.advance(n)
}

func (s *session) finish(r Ring, reason string, decision *string) error {
	var outcome string
	if decision != nil && *decision != "" {
		outcome = "Moderator's decision:\n" + *decision
	} else {
		all, err := s.subs(r, 0)
		if err != nil {
			return err
		}
		var parts []string
		for _, x := range all {
			if x.Round != r.Round {
				continue
			}
			v := ""
			if x.Verdict != "" {
				v = " (" + x.Verdict + ")"
			}
			parts = append(parts, "### "+s.name(x.Agent)+v+"\n"+x.Text)
		}
		outcome = "Final submissions:\n\n" + strings.Join(parts, "\n\n")
	}
	body, err := s.e.finishBody(r, reason, outcome)
	if err != nil {
		return err
	}
	if _, err := s.update(r, db.RingField{Name: "status", Value: "done"}, db.RingField{Name: "result", Value: outcome}); err != nil {
		return err
	}
	to := []string{}
	seen := map[string]bool{}
	for _, id := range append(append([]string{r.CreatedBy}, r.Members...), r.ModeratorID) {
		if id != "" && !seen[id] {
			seen[id] = true
			to = append(to, id)
		}
	}
	s.effects = append(s.effects, Effect{To: to, Subject: "Ring " + r.Name + " ended", Body: body})
	return nil
}

func (e Engine) run(ctx context.Context, d *db.DB, fn func(s *session) (string, error)) (string, []Effect, error) {
	var out string
	var effects []Effect
	err := d.InRing(ctx, func(tx db.RingTx) error {
		s := &session{e: e, tx: tx, names: map[string]string{}}
		var err error
		if out, err = fn(s); err != nil {
			return err
		}
		effects = s.effects
		return nil
	})
	if err != nil {
		var ue userError
		if errors.As(err, &ue) {
			return "", nil, ue
		}
		return "", nil, err
	}
	return out, effects, nil
}

// userError is a refusal the caller reads as it is (the 409 and 400 of the routes), not a database failure.
type userError struct{ error }

func refuse(format string, args ...any) error { return userError{fmt.Errorf(format, args...)} }

// SubmitInput is a ring_submit.
type SubmitInput struct {
	Ring, Agent, Text string
	Agree             bool
	Verdict           *string
	// Round is the round the submitter's turn prompt showed, when it sends one.
	HasRound bool
	Round    float64
	// Seat is the member name the text is for.
	Seat *string
}

func jsNum(f float64) string {
	if math.IsNaN(f) {
		return "NaN"
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// Submit is submit: a member's text. A prompt from an earlier round, sent after the ring moved on, writes nothing. The submission, the
// turn and the move to the next turn or round are one transaction.
func (e Engine) Submit(ctx context.Context, d *db.DB, in SubmitInput) (string, []Effect, error) {
	if e.Entered != nil {
		e.Entered(in.Agent)
	}
	return e.run(ctx, d, func(s *session) (string, error) {
		if jsjson.Trim(in.Text) == "" {
			return "", refuse("text is required: your findings for the ring, as a non-empty string")
		}
		r, ok, err := s.get(in.Ring)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", refuse("no ring %s", in.Ring)
		}
		if r.Status != "running" {
			return "", refuse("ring %s is %s", r.Name, r.Status)
		}
		if in.HasRound && in.Round != float64(r.Round) {
			return "", refuse("ring %s is on round %d, not %s: your turn prompt is out of date, so read the current one before you submit", r.Name, r.Round, jsNum(in.Round))
		}
		m := r.Members
		isMember := func(id string) bool {
			for _, x := range m {
				if x == id {
					return true
				}
			}
			return false
		}
		seats := []string{}
		cands := []string{in.Agent}
		for _, id := range m {
			if id != in.Agent {
				if st, err := s.standsFor(id, in.Agent); err != nil {
					return "", err
				} else if st {
					cands = append(cands, id)
				}
			}
		}
		for _, id := range cands {
			if isMember(id) {
				seats = append(seats, id)
			}
		}
		if len(seats) == 0 {
			return "", refuse("you are not a member of this ring")
		}
		cur, err := s.subs(r, r.Round)
		if err != nil {
			return "", err
		}
		filled := map[string]bool{}
		for _, x := range cur {
			filled[x.Agent] = true
		}
		turnOwner := m[r.Turn%len(m)]
		parallel := r.Format == "rounds"
		var open []string
		for _, id := range seats {
			if !filled[id] && (parallel || turnOwner == id) {
				open = append(open, id)
			}
		}
		names := "none"
		if len(open) > 0 {
			ns := make([]string, len(open))
			for i, id := range open {
				ns[i] = s.name(id)
			}
			names = strings.Join(ns, ", ")
		}
		openSeats := fmt.Sprintf("your open seats in %s are %s", r.Name, names)
		var member string
		if in.Seat != nil {
			named := ""
			for _, id := range seats {
				if s.name(id) == *in.Seat {
					named = id
					break
				}
			}
			if named == "" {
				return "", refuse("you do not hold the seat %s: %s", *in.Seat, openSeats)
			}
			if filled[named] {
				return "", refuse("the seat %s is already filled in round %d: %s", *in.Seat, r.Round, openSeats)
			}
			member = named
		} else {
			if len(open) > 1 {
				return "", refuse("you hold %d open seats, so pass seat, the member's name, for whose text this is: %s", len(open), openSeats)
			}
			member = seats[0]
			if len(open) > 0 {
				member = open[0]
			}
		}
		if r.Format != "rounds" && m[r.Turn%len(m)] != member {
			return "", refuse("it is %s's turn", s.name(m[r.Turn%len(m)]))
		}
		v, err := VerdictOf(r.Topic, in.Text, in.Verdict)
		if err != nil {
			return "", refuse("%s", err.Error())
		}
		if err := s.tx.PutSub(r.ID, r.Round, member, in.Text, in.Agree, v); err != nil {
			return "", err
		}
		if e.Wrote != nil {
			e.Wrote(in.Agent)
		}
		if r.Format != "rounds" {
			r, err = s.update(r, db.RingField{Name: "turn", Value: r.Turn + 1})
			if err != nil {
				return "", err
			}
			if r.Turn%len(m) != 0 {
				return "Submitted. The next member has the turn.", s.advance(r)
			}
		} else {
			now, err := s.subs(r, r.Round)
			if err != nil {
				return "", err
			}
			if len(now) < len(m) {
				return "Submitted. Waiting for the other members.", nil
			}
		}
		return "Submitted. The round is complete.", s.roundComplete(r)
	})
}

// Decide is decide: the moderator continues the ring with a note, or ends it.
func (e Engine) Decide(ctx context.Context, d *db.DB, ref, agent string, cont bool, text string) (string, []Effect, error) {
	return e.run(ctx, d, func(s *session) (string, error) {
		r, ok, err := s.get(ref)
		if err != nil {
			return "", err
		}
		if !ok {
			return "", refuse("no ring %s", ref)
		}
		if st, err := s.standsFor(r.ModeratorID, agent); err != nil {
			return "", err
		} else if !st {
			return "", refuse("only the moderator decides")
		}
		if r.Status != "moderating" {
			return "", refuse("ring %s is %s, not waiting for you", r.Name, r.Status)
		}
		if !cont || r.Round >= r.MaxRounds {
			subs, err := s.subs(r, r.Round)
			if err != nil {
				return "", err
			}
			split := SplitLine(r.Topic, subs, s.name)
			reason := "the moderator ended it"
			if cont {
				reason = "the last round ended"
			}
			if split != "" {
				reason = "split (" + split + "); " + reason
			}
			var decision *string
			if r.ModeratorDecides {
				decision = &text
			}
			return "The ring has ended.", s.finish(r, reason, decision)
		}
		n, err := s.update(r, db.RingField{Name: "status", Value: "running"}, db.RingField{Name: "round", Value: r.Round + 1}, db.RingField{Name: "note", Value: text})
		if err != nil {
			return "", err
		}
		return "The next round has started.", s.advance(n)
	})
}

// CreateInput is createRing's input.
type CreateInput struct {
	Name, Format, Topic string
	Members             []string
	Moderator           string
	ModeratorDecides    bool
	MaxRounds           int
	CreatedBy           string
}

// Create is createRing: the row, the members' ring:joined events and the first turn notices land together.
func (e Engine) Create(ctx context.Context, d *db.DB, in CreateInput) (string, []Effect, error) {
	return e.run(ctx, d, func(s *session) (string, error) {
		if in.Format != "rounds" && in.Format != "fire" && in.Format != "debate" {
			return "", refuse("format must be rounds, fire, or debate")
		}
		ids := make([]string, len(in.Members))
		for i, ref := range in.Members {
			id, _, _, _, ok, err := s.tx.Agent(ref)
			if err != nil {
				return "", err
			}
			if !ok {
				return "", refuse("no agent %s", ref)
			}
			ids[i] = id
		}
		if len(ids) < 2 {
			return "", refuse("a ring needs at least two members")
		}
		mod := ""
		if in.Moderator != "" {
			id, _, _, _, ok, err := s.tx.Agent(in.Moderator)
			if err != nil {
				return "", err
			}
			if !ok {
				return "", refuse("no agent %s", in.Moderator)
			}
			mod = id
		}
		raw := make([]byte, 3)
		if _, err := rand.Read(raw); err != nil {
			return "", err
		}
		id := "r" + hex.EncodeToString(raw)
		max := in.MaxRounds
		if max == 0 {
			max = 3
		}
		items := make([]jsfmt.Value, len(ids))
		for i, a := range ids {
			items[i] = jsfmt.StringValue(a)
		}
		if err := s.tx.Insert(db.NewRing{ID: id, Name: in.Name, Format: in.Format, Topic: in.Topic, Members: jsfmt.Compact(jsfmt.ArrayValue(items)),
			Moderator: mod, ModeratorDecides: in.ModeratorDecides, CreatedBy: in.CreatedBy, MaxRounds: max}); err != nil {
			return "", err
		}
		r, _, err := s.get(id)
		if err != nil {
			return "", err
		}
		for _, a := range ids {
			data := jsfmt.Value{Kind: jsfmt.Object}
			data.Set("ring", jsfmt.StringValue(id))
			if err := s.tx.AgentEvent(a, "ring:joined", data); err != nil {
				return "", err
			}
		}
		return id, s.advance(r)
	})
}

// PromptOpenSeats is promptOpenSeats: after a daemon restart the queued turn notices are gone, so each open seat of a running ring is
// prompted again from the durable state: a rounds ring's members who haven't submitted this round, a fire or debate ring's next
// member, a moderated ring's moderator. It returns the notices and how many seats there are.
func (e Engine) PromptOpenSeats(ctx context.Context, d *db.DB) (int, []Effect, error) {
	n := 0
	_, effects, err := e.run(ctx, d, func(s *session) (string, error) {
		open, err := s.tx.OpenRings()
		if err != nil {
			return "", err
		}
		for _, v := range open {
			r := ringOf(v)
			if r.Status == "moderating" {
				if r.ModeratorID != "" {
					if err := s.notifyModerator(r); err != nil {
						return "", err
					}
				}
				n++
				continue
			}
			var seats []string
			if r.Format == "rounds" {
				subs, err := s.subs(r, r.Round)
				if err != nil {
					return "", err
				}
				for _, m := range r.Members {
					had := false
					for _, x := range subs {
						had = had || x.Agent == m
					}
					if !had {
						seats = append(seats, m)
					}
				}
			} else {
				seats = []string{r.Members[r.Turn%len(r.Members)]}
			}
			for _, id := range seats {
				if err := s.prompt(r, id); err != nil {
					return "", err
				}
			}
			n += len(seats)
		}
		return "", nil
	})
	return n, effects, err
}

// IsRefusal is whether err is a ring's own refusal (a bad request or a stale turn), not a failure of the database.
func IsRefusal(err error) bool {
	var ue userError
	return errors.As(err, &ue)
}
