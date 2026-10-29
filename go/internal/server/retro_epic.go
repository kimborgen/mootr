package server

import (
	"context"
	"errors"
	"math"
	"strconv"
	"strings"
	"time"

	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
	"stam/internal/lifecycle"
	"stam/internal/mcp"
)

// The epic retro offer (src/retro-digest.ts epicRetroOffer and src/retro.ts epicOffer, S-163): a project or initiative
// closed with retro items from several reporters On its subtree gets one offer, a one-round ring over those items when
// its owner's tree has room in the 5-hour window, else a solo retro.

const (
	epicRingStep = "Offer one ring: `ring_create` with format `rounds`, `max_rounds` 1, only members still alive (no spawns), and a topic that lists these items, each answer under about 300 words. Then file the result as retro items (search and +1 first) whose `On:` names {epic}."
	epicSoloStep = "Write the epic retro yourself from these items, then file it as a retro item (search and +1 first) whose `On:` names {epic}."
)

// epicItem is a retro item or report as the offer reads it.
type epicItem struct{ key, body string }

// epicOffer is src/retro.ts epicOffer: the offer, or "" when the ITSA isn't an epic, has fewer than minReporters
// distinct reporters, or no item On its subtree. A share under maxWindowShare gives the ring; an unknown share (nil)
// gives the solo retro.
func epicOffer(key, kind string, subtree map[string]bool, items []epicItem, share *float64, minReporters int, maxShare float64, render func(map[string]string) (string, error)) (string, error) {
	if !epicKinds[kind] {
		return "", nil
	}
	var hits []string
	reporters := map[string]bool{}
	for _, x := range items {
		h := mcp.Header(x.body)
		// .split(/\s+/)[0] of the trimmed value: its first word.
		on := ""
		if f := strings.FieldsFunc(h["On"], mcp.IsJSSpace); len(f) > 0 {
			on = f[0]
		}
		if !subtree[on] {
			continue
		}
		hits = append(hits, x.key)
		// .replace(/ \(.*$/, '').trim(): the name before its `(model, type)`.
		r := h["Reporter"]
		if i := strings.Index(r, " ("); i >= 0 {
			r = r[:i]
		}
		if r = strings.TrimFunc(r, mcp.IsJSSpace); r != "" {
			reporters[r] = true
		}
	}
	if len(reporters) < minReporters {
		return "", nil
	}
	step := epicSoloStep
	if share != nil && *share < maxShare {
		step = epicRingStep
	}
	return render(map[string]string{
		"epic":  key,
		"count": strconv.Itoa(len(hits)),
		"keys":  strings.Join(hits, ", "),
		"step":  strings.ReplaceAll(step, "{epic}", key),
	})
}

// epicSettings is settings.retro.epic as TS normalises it: minReporters a whole number from 1 (default 3), and
// maxWindowShare a number from 0 to 100 (default 50).
func (s *Server) epicSettings() (minReporters int, maxShare float64) {
	minReporters, maxShare = 3, 50
	retro, _, _ := s.retroSettings()
	e, ok := retro.Get("epic")
	o, isObj := e.(*jsjson.Object)
	if !ok || !isObj {
		return
	}
	if v, ok := o.Get("minReporters"); ok {
		if n, ok := v.(float64); ok && n == math.Trunc(n) && n >= 1 && n <= math.MaxInt32 {
			minReporters = int(n)
		}
	}
	if v, ok := o.Get("maxWindowShare"); ok {
		if n, ok := v.(float64); ok && n >= 0 && n <= 100 {
			maxShare = n
		}
	}
	return
}

// epicRetroOffer is src/retro-digest.ts epicRetroOffer for an ITSA that just closed: the retro items and reports On its
// subtree, and its owner's share of the 5-hour window (the largest account's; nil when none is known).
func (s *Server) epicRetroOffer(ctx context.Context, epic jsfmt.Value) (string, error) {
	if !epicKinds[epic.Text("kind")] {
		return "", nil
	}
	tree, err := s.db.ListItsas(ctx, db.ItsaFilter{Subtree: epic.Text("id")})
	if err != nil {
		return "", err
	}
	subtree := map[string]bool{}
	for _, x := range tree {
		subtree[x.Text("key")] = true
	}
	var items []epicItem
	for _, kind := range []string{retroKind, reportKind} {
		list, err := s.itsasOfKind(ctx, kind)
		if err != nil {
			return "", err
		}
		for _, x := range list {
			items = append(items, epicItem{x.Text("key"), x.Text("body")})
		}
	}
	var share *float64
	if owner := epic.Text("owner"); owner != "" {
		if share, err = s.treeShare(ctx, owner); err != nil {
			return "", err
		}
	}
	minReporters, maxShare := s.epicSettings()
	return epicOffer(epic.Text("key"), epic.Text("kind"), subtree, items, share, minReporters, maxShare,
		func(vars map[string]string) (string, error) { return s.render("retro-epic", vars) })
}

// treeShare is the largest five_hour percent in usage.summary(7, owner)'s tree accounts; nil when none is known.
func (s *Server) treeShare(ctx context.Context, owner string) (*float64, error) {
	if s.life == nil {
		return nil, nil
	}
	root := db.Agent{ID: owner}
	if a, err := s.db.GetAgent(ctx, owner); err == nil {
		root = a
	} else if !errors.Is(err, db.ErrNotFound) {
		return nil, err
	}
	reg, err := s.agentRegistry()
	if err != nil {
		return nil, err
	}
	cos := s.settings.Get().ChiefOfStaff
	summary, err := s.life.UsageSummary(ctx, lifecycle.SummaryOptions{Days: 7, TypeOf: func(a db.Agent) string { return reg.typeOf(a, cos) }, Now: float64(time.Now().UnixMilli()), Tree: &root})
	if err != nil {
		return nil, err
	}
	var best *float64
	t, _ := summary.Get("tree")
	to, _ := t.(*jsjson.Object)
	if to == nil {
		return nil, nil
	}
	acc, _ := to.Get("accounts")
	accounts, _ := acc.(*jsjson.Object)
	if accounts == nil {
		return nil, nil
	}
	for _, name := range accounts.Keys() {
		w, _ := accounts.Get(name)
		wo, _ := w.(*jsjson.Object)
		if wo == nil {
			continue
		}
		fh, _ := wo.Get("five_hour")
		fo, _ := fh.(*jsjson.Object)
		if fo == nil {
			continue
		}
		if p, ok := fo.Get("percent"); ok {
			if n, ok := p.(float64); ok && (best == nil || n > *best) {
				best = &n
			}
		}
	}
	return best, nil
}
