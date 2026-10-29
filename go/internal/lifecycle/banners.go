package lifecycle

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"sort"
	"sync"
	"time"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/tmux"
)

// Dismissing known harness menus over idle agents (src/daemon.ts dismissBanners, settings.banners; S-2848 B3b), since a
// menu captures input and can hold back pushed mail. One shared tmux snapshot per tick finds the agents' terminals,
// and a menu only shows with new output or another pane coming to the front, so a pane is captured when its window had
// output since the last look, its active pane changed, or bannerRelook passed. Output in the second of a look counts as
// new, as #{window_activity} is in seconds. A look counts only once the agent's screen was checked against the banners
// while it could show one, and is forgotten when the agent can't (it works, or stops) or the banners settings change.
// Keys go to the captured pane only while it is still in the agent's session on the same server, under the same harness
// and banners.
//
// A match is a Go regular expression (RE2): a pattern only JavaScript's RegExp reads, such as a lookahead, matches
// nothing here and is logged.

// BannersEvery is how often the banners loop runs (src/daemon.ts runDaemon: every 3 s).
const BannersEvery = 3 * time.Second

// bannerRelook is src/daemon.ts BANNER_RELOOK_MS.
const bannerRelook = 2 * time.Minute

// bannerCapturesPerTick is src/banner-stagger.ts BANNER_CAPTURES_PER_TICK: a tick captures at most this many panes, so
// the captures spread over the relook period instead of landing together on one tick.
const bannerCapturesPerTick = 8

type bannerLook struct {
	pane     string
	activity int64
	at       time.Time
}

type bannerState struct {
	mu        sync.Mutex
	looks     map[string]bannerLook
	capturing map[string]bool
	rules     string
}

type bannerDue struct {
	a        db.Agent
	pane     string
	activity int64
	at       time.Time
}

type bannerEvent struct {
	Match string `json:"match"`
}

func canShowBanner(a db.Agent) bool {
	return (a.Lifecycle == "active" || a.Lifecycle == "paused") && (a.Activity == "idle" || a.Activity == "waiting")
}

// bannerRules is the banners settings as one string, to tell when they changed.
func bannerRules(bs []config.Banner) string {
	b, _ := json.Marshal(bs)
	return string(b)
}

// pickLooks is src/banner-stagger.ts pickLooks: the due panes to capture this tick, the oldest looks first, never
// looked (the zero time) first of all.
func pickLooks(due []bannerDue, limit int) []bannerDue {
	out := append([]bannerDue(nil), due...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].at.Before(out[j].at) })
	if len(out) > limit {
		out = out[:limit]
	}
	return out
}

// StartBanners runs DismissBanners every BannersEvery over the shared snapshot until the daemon's context ends.
func (l *Lifecycle) StartBanners() {
	l.goBG(func(ctx context.Context) {
		t := time.NewTicker(BannersEvery)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			tctx, cancel := context.WithTimeout(ctx, reconcileTimeout)
			l.DismissBanners(tctx, l.tmux.SharedSnapshot(tctx))
			cancel()
		}
	})
}

// DismissBanners is one tick of src/daemon.ts dismissBanners: the panes due a look are captured in the background, and
// a banner on one gets its keys, a banner:dismissed event and a push.
func (l *Lifecycle) DismissBanners(ctx context.Context, snap *tmux.Snapshot) {
	banners := l.settings.Get().Banners
	rules := bannerRules(banners)
	agents, err := l.db.ListLiveAgents(ctx)
	if err != nil {
		slog.Error("banners", "err", err)
		return
	}
	var eligible []db.Agent
	ids := map[string]bool{}
	for _, a := range agents {
		if !canShowBanner(a) {
			continue
		}
		for _, b := range banners {
			if b.Harness == a.Harness {
				eligible = append(eligible, a)
				ids[a.ID] = true
				break
			}
		}
	}
	st := &l.banners
	st.mu.Lock()
	defer st.mu.Unlock()
	if rules != st.rules || st.looks == nil {
		st.rules, st.looks = rules, map[string]bannerLook{}
	}
	for id := range st.looks {
		if !ids[id] {
			delete(st.looks, id)
		}
	}
	if len(eligible) == 0 || snap == nil {
		return
	}
	now := time.Now()
	var due []bannerDue
	for _, a := range eligible {
		pane := snap.Pane[a.ID]
		if dead, ok := snap.Dead[a.ID]; !ok || dead || pane == "" || st.capturing[a.ID] {
			continue
		}
		activity := snap.Activity[a.ID]
		last, seen := st.looks[a.ID]
		if seen && last.pane == pane && activity == last.activity && activity < last.at.Unix() && now.Sub(last.at) < bannerRelook {
			continue
		}
		due = append(due, bannerDue{a: a, pane: pane, activity: activity, at: last.at})
	}
	if st.capturing == nil {
		st.capturing = map[string]bool{}
	}
	for _, d := range pickLooks(due, bannerCapturesPerTick) {
		st.capturing[d.a.ID] = true
		d, owner := d, snap.Server+"\t"+d.a.ID
		l.goBG(func(bctx context.Context) {
			defer func() {
				st.mu.Lock()
				delete(st.capturing, d.a.ID)
				st.mu.Unlock()
			}()
			l.lookForBanner(bctx, d, owner, banners, rules)
		})
	}
}

// lookForBanner captures one pane and dismisses each banner on it, re-checking the agent and the pane's owner before
// each key.
func (l *Lifecycle) lookForBanner(ctx context.Context, d bannerDue, owner string, banners []config.Banner, rules string) {
	at := time.Now()
	screen, err := l.tmux.CapturePaneByID(ctx, d.pane)
	if err != nil {
		return
	}
	// The agent as it is now, if it can still show a banner under the same harness and rules.
	current := func() bool {
		cur, err := l.db.GetAgent(ctx, d.a.ID)
		return err == nil && canShowBanner(cur) && cur.Harness == d.a.Harness && bannerRules(l.settings.Get().Banners) == rules
	}
	if !current() {
		return
	}
	l.banners.mu.Lock()
	if l.banners.rules == rules && l.banners.looks != nil {
		l.banners.looks[d.a.ID] = bannerLook{pane: d.pane, activity: d.activity, at: at}
	}
	l.banners.mu.Unlock()
	for _, b := range banners {
		if b.Harness != d.a.Harness {
			continue
		}
		re, err := regexp.Compile(b.Match)
		if err != nil {
			slog.Warn("banners: a match Go can't read", "match", b.Match, "err", err)
			continue
		}
		if !re.MatchString(screen) {
			continue
		}
		if now, ok := l.tmux.PaneOwner(ctx, d.pane); !ok || now != owner {
			return
		}
		if !current() {
			return
		}
		if err := l.tmux.SendKeysToPane(ctx, d.pane, b.Keys...); err != nil {
			return
		}
		l.event(ctx, d.a.ID, "banner:dismissed", bannerEvent{Match: b.Match})
		l.SchedulePush(d.a.ID)
	}
}
