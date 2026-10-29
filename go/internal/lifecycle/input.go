package lifecycle

import (
	"context"
	"encoding/hex"
	"strings"
	"time"
	"unicode/utf16"

	"stam/internal/adapters/claude"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// Typing a suggestion the human approved into an agent's input box (S-2848 B3b, src/adapters/claude.ts
// typeLiteralInput and inputText, S-422).

// leftoverText is stam's own unfinished typing (S-534): when an attempt stops short and the erase leaves part of the
// text in the box, that remainder (what the screen showed after the erase, and a start of the text stam typed) is kept
// with the harness session it was typed in. The next attempt in the same session may clear it, and only when the box
// holds exactly it. Anything else in the box is a draft.
type leftoverText struct{ text, session string }

// The events' data keeps TS's key order.
type inputScreenEvent struct {
	What   string   `json:"what"`
	Before []string `json:"before"`
	Now    []string `json:"now"`
}

type inputClearedEvent struct {
	Text string `json:"text"`
}

// InputText is src/adapters/claude.ts inputText: what the input box holds right now, as typed (a bash-mode box starts
// with !), for telling the agent what blocks an approved line (S-524). False when the screen doesn't show a box whose
// text can be read.
func (l *Lifecycle) InputText(ctx context.Context, a db.Agent) (string, bool) {
	if a.Harness != "claude" || !l.tmux.HasSession(ctx, a.ID) {
		return "", false
	}
	screen, err := l.tmux.CapturePane(ctx, a.ID)
	if err != nil {
		return "", false
	}
	width, _ := l.tmux.PaneWidth(ctx, a.ID)
	box, ok := claude.InputBox(strings.Split(screen, "\n"), width)
	if !ok || !box.HasText {
		return "", false
	}
	if box.Mark == "!" {
		return "!" + box.Text, true
	}
	return box.Text, true
}

// TypeLiteralInput is src/adapters/claude.ts typeLiteralInput: a suggestion the human approved, typed exactly as
// written into this agent's own session. The text goes in as its UTF-8 bytes (send-keys -H), so tmux parses none of it.
// Enter follows only once the box shows exactly the text in the right mode, the screen around it is as before, and
// proceed (nil for yes) says yes right before it. A completion menu gets one Esc, and if the screen isn't back as it
// was, nothing is sent. With vim keys the box must be in insert mode first. Someone's draft in the box is never
// touched: that is "draft", as a busy agent or a dialog on screen is "busy", and the caller holds the approval. When it
// doesn't send, it erases what it typed: "failed" when the screen was wrong, "cancelled" when proceed said no, and
// "unsent" when proceed said yes but Enter couldn't be sent (the pane changed, or tmux failed), so the caller, whose
// claim already went through, can undo it.
//
// Unlike TS, every read and key goes to the pane resolved once by its id, and a key only while that pane is still the
// agent's session's (a resume meanwhile isn't held off here, as TS's synchronous calls were).
func (l *Lifecycle) TypeLiteralInput(ctx context.Context, a db.Agent, text string, proceed func(stillTyped func() bool) bool) string {
	if a.Harness != "claude" || (a.Activity != "idle" && a.Activity != "waiting") {
		return "busy"
	}
	pane, owner, ok, err := l.tmux.Pane(ctx, a.ID)
	if err != nil || !ok {
		return "busy"
	}
	width, _ := l.tmux.PaneWidth(ctx, a.ID)
	if proceed == nil {
		proceed = func(func() bool) bool { return true }
	}
	t := &typist{l: l, ctx: ctx, a: a, pane: pane, owner: owner, width: width}
	return t.typeText(text, proceed)
}

// typist is one attempt at typing into one pane.
type typist struct {
	l           *Lifecycle
	ctx         context.Context
	a           db.Agent
	pane, owner string
	width       int
	vim         bool
}

// ours is whether the pane is still the agent's session's.
func (t *typist) ours() bool {
	now, ok := t.l.tmux.PaneOwner(t.ctx, t.pane)
	return ok && now == t.owner
}

func (t *typist) screen() []string {
	s, err := t.l.tmux.CapturePaneByID(t.ctx, t.pane)
	if err != nil {
		return nil
	}
	return strings.Split(s, "\n")
}

// send sends keys while the pane is still ours; false when it isn't, or tmux failed.
func (t *typist) send(keys ...string) bool {
	return t.ours() && t.l.tmux.SendKeysToPane(t.ctx, t.pane, keys...) == nil
}

// pause waits; false when the daemon stops meanwhile.
func (t *typist) pause(ms int) bool { return sleep(t.ctx, time.Duration(ms)*time.Millisecond) == nil }

func (t *typist) insert(lines []string) bool { return claude.InsertMode(lines) }

func (t *typist) shows(lines []string, text string) bool {
	return claude.InputShows(lines, text, t.width)
}

func (t *typist) empty(lines []string) bool { return claude.EmptyBox(lines, t.width) }

func (t *typist) typeText(text string, proceed func(stillTyped func() bool) bool) string {
	lines := t.screen()
	if lines == nil || claude.TurnRunning(lines) {
		return "busy"
	}
	if _, ok := claude.InputBox(lines, t.width); !ok {
		return "busy"
	}
	t.vim = t.insert(lines) || claude.NormalMode(lines) || claude.VimKeys(t.l.claude.ConfigDir, t.l.claude.UserHome)
	if t.empty(lines) {
		t.l.forgetLeftover(t.a.ID)
	} else {
		// Only stam's own unfinished typing from an earlier attempt, exactly, is taken back (S-534).
		if !t.clearOwnLeftover(lines, t.vim && !t.insert(lines)) {
			return "draft"
		}
		if lines = t.screen(); !t.empty(lines) {
			return "draft"
		}
	}
	// The footer may be mid-redraw: look again before taking it for normal mode.
	for i := 0; i < 3 && t.vim && !t.insert(lines); i++ {
		if !t.pause(300) {
			return "busy"
		}
		lines = t.screen()
	}
	if t.vim && !t.insert(lines) {
		if !t.empty(lines) {
			return "draft"
		}
		if !t.send("i") || !t.pause(200) {
			return "busy"
		}
		lines = t.screen()
		// It was in insert mode after all, and the i went into the box: take it back, and try later.
		if b, ok := claude.InputBox(lines, t.width); ok && b.HasText && b.Text == "i" {
			t.send("BSpace")
			return "busy"
		}
		if !t.insert(lines) {
			return "busy"
		}
		if !t.empty(lines) {
			return "draft"
		}
	}
	around := claude.AroundBox(lines)
	graphemes := claude.Graphemes(text)
	b := []byte(text)
	keys := make([]string, 0, len(b)+1)
	keys = append(keys, "-H")
	for _, c := range b {
		keys = append(keys, hex.EncodeToString([]byte{c}))
	}
	if !t.send(keys...) {
		return t.erase(graphemes, t.failed("the keys", around))
	}
	state := t.settled(text, around)
	if state == "no" {
		if !t.ours() || !t.shows(t.screen(), text) {
			return t.erase(graphemes, t.failed("the box", around))
		}
		// The text is there but something drew around it, such as a completion menu: one Esc closes it, never while a
		// turn runs, where it would interrupt the turn.
		if claude.TurnRunning(t.screen()) {
			return t.erase(graphemes, "busy")
		}
		if !t.send("Escape") {
			return t.erase(graphemes, t.failed("the Esc", around))
		}
		if state = t.settled(text, around); state == "no" {
			return t.erase(graphemes, t.failed("the screen around the box, after one Esc", around))
		}
	}
	if state == "busy" {
		return t.erase(graphemes, "busy")
	}
	// proceed gets stillTyped, which reads the box once more: proceed claims the approval only if the box still shows
	// exactly the text, so a key typed since the check above is never sent with it. Such a change is "failed" (S-3830).
	changed := false
	stillTyped := func() bool {
		now := t.screen()
		if now == nil || !t.shows(now, text) || !claude.SameAround(around, claude.AroundBox(now)) || claude.MenuUnderBox(now) {
			changed = true
		}
		return !changed
	}
	if !proceed(stillTyped) {
		if changed {
			return t.erase(graphemes, "failed")
		}
		return t.erase(graphemes, "cancelled")
	}
	if !t.send("Enter") {
		t.erase(graphemes, "")
		return "unsent"
	}
	return "typed"
}

// settled is "ok" once the box shows the text with the screen around it as before, "busy" when a turn started
// meanwhile (the approval stays held and is typed again at the next idle), and "no" otherwise.
func (t *typist) settled(text string, around claude.Around) string {
	for i := 0; i < 10; i++ {
		if !t.pause(150) || !t.ours() {
			return "no"
		}
		now := t.screen()
		if claude.TurnRunning(now) {
			return "busy"
		}
		if t.shows(now, text) && claude.SameAround(around, claude.AroundBox(now)) && !claude.MenuUnderBox(now) && (!t.vim || t.insert(now)) {
			return "ok"
		}
	}
	return "no"
}

// failed records why it failed, and the screen then, as an event for whoever looks into it.
func (t *typist) failed(what string, before claude.Around) string {
	var now []string
	if t.ours() {
		for _, l := range t.screen() {
			if jsjson.Trim(l) != "" {
				now = append(now, l)
			}
		}
	}
	t.l.event(t.ctx, t.a.ID, "input:screen", inputScreenEvent{What: what, Before: lastN(before.Above, 8), Now: lastN(now, 14)})
	return "failed"
}

func lastN(l []string, n int) []string {
	if l == nil {
		return []string{}
	}
	if len(l) > n {
		return l[len(l)-n:]
	}
	return l
}

// erase takes back only what stam typed: the box must show the text, or a start of it, and no dialog, else nothing is
// sent. Claude Code deletes a grapheme per backspace; it leaves bash mode on a backspace in an empty box, which the
// leading ! started. An Esc may have left vim's insert mode, so A goes back to it at the end of the text first.
func (t *typist) erase(graphemes []string, outcome string) string {
	if !t.ours() {
		return outcome
	}
	now := t.screen()
	if t.vim && !t.insert(now) {
		if !t.send("A") || !t.pause(150) {
			return "failed"
		}
		now = t.screen()
	}
	if claude.ShowsDialog(now) || (t.vim && !t.insert(now)) {
		return "failed"
	}
	n := len(graphemes)
	for n > 0 && !t.shows(now, strings.Join(graphemes[:n], "")) {
		n--
	}
	if n == 0 && !t.empty(now) {
		return "failed"
	}
	if n > 0 && !t.send(repeat("BSpace", n)...) {
		return "failed"
	}
	// Whatever the box still shows of it afterwards is stam's own, noted for the next attempt.
	if !t.pause(250) {
		return outcome
	}
	t.rememberLeftover(graphemes, t.screen())
	return outcome
}

func repeat(key string, n int) []string {
	keys := make([]string, n)
	for i := range keys {
		keys[i] = key
	}
	return keys
}

// rememberLeftover keeps the start of the text the box still shows, with the session it was typed in.
func (t *typist) rememberLeftover(graphemes, now []string) {
	session := deref(t.a.SessionID)
	if fresh, err := t.l.db.GetAgent(t.ctx, t.a.ID); err == nil {
		session = deref(fresh.SessionID)
	}
	n := len(graphemes)
	for n > 0 && !t.shows(now, strings.Join(graphemes[:n], "")) {
		n--
	}
	t.l.mu.Lock()
	defer t.l.mu.Unlock()
	if n > 0 && session != "" {
		if t.l.leftover == nil {
			t.l.leftover = map[string]leftoverText{}
		}
		t.l.leftover[t.a.ID] = leftoverText{text: strings.Join(graphemes[:n], ""), session: session}
	} else {
		delete(t.l.leftover, t.a.ID)
	}
}

func (l *Lifecycle) forgetLeftover(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.leftover, id)
}

func (l *Lifecycle) leftoverOf(id string) (leftoverText, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	own, ok := l.leftover[id]
	return own, ok
}

// clearOwnLeftover clears the box if it holds exactly stam's own leftover from this session, with the cursor at the end
// of its last row: End first, one backspace per grapheme, then the box is read again and must be empty. True only then;
// on any doubt nothing more is sent and the box stays a draft.
func (t *typist) clearOwnLeftover(lines []string, notInsert bool) bool {
	own, ok := t.l.leftoverOf(t.a.ID)
	if !ok {
		return false
	}
	fresh, err := t.l.db.GetAgent(t.ctx, t.a.ID)
	same := err == nil && deref(fresh.SessionID) == own.session
	_, _, rows := claude.BoxRows(lines)
	shows := t.shows(lines, own.text)
	// A completion menu under the box is the usual reason stam's own leftover stays: one Escape closes it, as the typing
	// does, and the leftover is cleared once the screen is free. A menu that stays keeps the box a draft (S-3830).
	if same && !notInsert && rows && shows && claude.MenuUnderBox(lines) && !claude.ShowsDialog(lines) {
		if !t.send("Escape") || !t.pause(150) {
			return false
		}
		lines = t.screen()
		_, _, rows = claude.BoxRows(lines)
		shows = t.shows(lines, own.text)
	}
	if !same || notInsert || !rows || !shows || claude.ShowsDialog(lines) || claude.MenuUnderBox(lines) {
		// Not its own leftover any more (the human's edit, a new session, a menu): never matched later.
		if !(same && rows && shows) {
			t.l.forgetLeftover(t.a.ID)
		}
		return false
	}
	if !t.send("End") || !t.pause(150) {
		return false
	}
	x, y, cok, err := t.l.tmux.CursorOfPane(t.ctx, t.pane)
	now := t.screen()
	_, end, rows := claude.BoxRows(now)
	if err != nil || !cok || !rows || !t.shows(now, own.text) || y != end-1 || x != claude.Columns(jsjson.TrimEnd(now[end-1])) {
		return false
	}
	graphemes := claude.Graphemes(own.text)
	// A key typed since the capture above would be deleted too: look again right before the backspaces.
	last := t.screen()
	x2, y2, ok2, err := t.l.tmux.CursorOfPane(t.ctx, t.pane)
	if !t.shows(last, own.text) || err != nil || !ok2 || x2 != x || y2 != y {
		return false
	}
	if !t.send(repeat("BSpace", len(graphemes))...) || !t.pause(250) {
		return false
	}
	if t.empty(t.screen()) {
		t.l.forgetLeftover(t.a.ID)
		t.l.event(t.ctx, t.a.ID, "input:cleared", inputClearedEvent{Text: sliceUnits(own.text, 200)})
		return true
	}
	return false
}

// sliceUnits is JS slice(0, n) on a string of UTF-16 units, cut at a character.
func sliceUnits(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n]))
}
