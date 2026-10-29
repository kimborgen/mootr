package lifecycle

import (
	"strings"
	"testing"
	"time"

	"stam/internal/db"
)

// TestPickLooks: the panes never looked at first, then the oldest looks, at most the cap.
func TestPickLooks(t *testing.T) {
	at := func(s int) time.Time { return time.Unix(int64(s), 0) }
	due := []bannerDue{{pane: "%3", at: at(30)}, {pane: "%1", at: at(10)}, {pane: "%0"}, {pane: "%2", at: at(20)}, {pane: "%9"}}
	var got []string
	for _, d := range pickLooks(due, 4) {
		got = append(got, d.pane)
	}
	if strings.Join(got, " ") != "%0 %9 %1 %2" {
		t.Errorf("picked %v", got)
	}
}

func (l *live) bannersDone() {
	l.t.Helper()
	l.until("the banner looks", func() bool {
		l.life.banners.mu.Lock()
		defer l.life.banners.mu.Unlock()
		return len(l.life.banners.capturing) == 0
	})
}

func (l *live) looked(id string) bool {
	l.life.banners.mu.Lock()
	defer l.life.banners.mu.Unlock()
	_, ok := l.life.banners.looks[id]
	return ok
}

// TestDismissBanners: an idle agent whose screen shows a banner of its harness gets its keys, a banner:dismissed event
// and a push; a working agent, another harness's agent, and a screen with no banner get nothing. Changed banners
// settings forget the looks.
func TestDismissBanners(t *testing.T) {
	l := newLive(t)
	banner := []string{"some output", "Teach auto mode about your environment?", "  1. Yes", "  2. Not now"}
	for _, id := range []string{"abn1", "abn2", "abn4"} {
		l.waiter(id)
	}
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "abn3", Name: "n-abn3", Role: "developer", Machine: "test-machine", Harness: "codex", Cwd: l.work}); err != nil {
		t.Fatal(err)
	}
	l.set("abn3", db.Field{Col: "lifecycle", Val: "active"}, db.Field{Col: "activity", Val: "idle"})
	l.set("abn2", db.Field{Col: "activity", Val: "working"})
	l.pane("abn1", banner...)
	l.pane("abn2", banner...)
	l.pane("abn3", banner...)
	l.pane("abn4", "just output", "❯ ")
	l.life.DismissBanners(l.ctx, l.tmux.Snapshot(l.ctx))
	l.bannersDone()
	if e := lastEvent(t, l, "abn1", "banner:dismissed"); e != `{"match":"Teach auto mode about your environment\\?"}` {
		t.Errorf("abn1's event %s", e)
	}
	l.until("the Escape", func() bool { return l.screenHas("abn1", "^[") })
	for _, id := range []string{"abn2", "abn3", "abn4"} {
		if e := lastEvent(t, l, id, "banner:dismissed"); e != "" || l.screenHas(id, "^[") {
			t.Errorf("%s got the keys: %s", id, e)
		}
	}
	if !l.looked("abn1") || !l.looked("abn4") || l.looked("abn2") || l.looked("abn3") {
		t.Errorf("looks %v", l.life.banners.looks)
	}

	// New banners from the settings, one per harness: each agent gets its own harness's keys, and the old looks are
	// forgotten (abn4's, dated ahead so it would not be due, is taken again).
	ahead := time.Now().Add(time.Hour)
	l.life.banners.mu.Lock()
	l.life.banners.looks["abn4"] = bannerLook{pane: l.life.banners.looks["abn4"].pane, activity: l.life.banners.looks["abn4"].activity, at: ahead}
	l.life.banners.mu.Unlock()
	l.setSettings(`{"banners":[{"harness":"codex","match":"Not now","keys":["Enter"]},{"harness":"claude","match":"Not now|just output","keys":["C-a"]}]}`)
	l.life.DismissBanners(l.ctx, l.tmux.Snapshot(l.ctx))
	l.bannersDone()
	if e := lastEvent(t, l, "abn3", "banner:dismissed"); e != `{"match":"Not now"}` {
		t.Errorf("abn3's event %s", e)
	}
	l.until("claude's key on abn1", func() bool { return l.screenHas("abn1", "^A") })
	if l.screenHas("abn3", "^A") {
		t.Error("abn3 got claude's keys")
	}
	l.life.banners.mu.Lock()
	again := l.life.banners.looks["abn4"].at
	l.life.banners.mu.Unlock()
	if again.Equal(ahead) {
		t.Error("abn4's look outlived the settings")
	}
	// A pattern only JavaScript reads matches nothing.
	l.setSettings(`{"banners":[{"harness":"claude","match":"(?=Teach)","keys":["Escape"]}]}`)
	l.set("abn4", db.Field{Col: "activity", Val: "working"})
	before := len(strings.Split(l.screenText("abn1"), "^["))
	l.life.DismissBanners(l.ctx, l.tmux.Snapshot(l.ctx))
	l.bannersDone()
	if after := len(strings.Split(l.screenText("abn1"), "^[")); after != before {
		t.Errorf("a lookahead sent keys: %d escapes, was %d", after-1, before-1)
	}
}

func (l *live) screenText(id string) string {
	s, _ := l.tmux.CapturePane(l.ctx, id)
	return s
}
