package lifecycle

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"

	"stam/internal/adapters/claude"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// Allocations (src/allocations.ts, docs/cost-policy.md build step 10, S-2848 B5d): the human or a manager says how much
// of an account's window, or how many paid dollars per period, a tree may use. They are stored by tree-root agent id,
// never enforced (no blockers), and checked on each reading: at 80% and 100% of the allocation a cost notice goes to the
// tree's manager and to the tree's root, once per allocation, threshold, and window reset (or period).
//
//	window   "tree T may use about X% of ACCOUNT's five_hour window": use is the tree's estimated share of that window
//	         since its current reset (attribution.go treeShare)
//	usd      "about $Y per day of paid spend": use is the tree's paid spend in the period from stam's ledger (the same
//	         column paidspend.go reads per account)
//
// Who may set what is cost_pause's rule (mayManageTree). When children's allocations add up past their parent tree's,
// the setter is warned but never refused.

// AllocationInput is src/allocations.ts SetInput and ClearInput, as the request body's raw values: they are coerced as
// TS's String() and Number() do.
type AllocationInput struct {
	ID, Tree, Account, Kind, Window, Percent, Amount, Period, Note jsjson.Value
}

// jsText is String(v ?? ""): the empty string for a missing or null value.
func jsText(v jsjson.Value) string {
	if v == nil {
		return ""
	}
	return claude.JSString(v)
}

// allocationScope is src/allocations.ts scopeOf.
func allocationScope(kind, window, period string) (string, string) {
	if kind == "usd" {
		return "", period
	}
	return window, ""
}

// agentRef is db.getAgent: the agent by id or name, false when there is none.
func (l *Lifecycle) agentRef(ctx context.Context, ref string) (db.Agent, bool, error) {
	a, err := l.db.GetAgent(ctx, ref)
	if errors.Is(err, db.ErrNotFound) {
		return db.Agent{}, false, nil
	}
	return a, err == nil, err
}

// Allocations is src/allocations.ts list: every allocation, oldest first, or the tree rooted at rootID's.
func (l *Lifecycle) Allocations(ctx context.Context, rootID string) ([]db.Allocation, error) {
	return l.db.Allocations(ctx, rootID)
}

// FindAllocation is src/allocations.ts find.
func (l *Lifecycle) FindAllocation(ctx context.Context, id string) (db.Allocation, bool, error) {
	return l.db.FindAllocation(ctx, id)
}

// mustTree is src/allocations.ts mustTree.
func (l *Lifecycle) mustTree(ctx context.Context, ref jsjson.Value) (db.Agent, error) {
	if jsjson.Truthy(ref) {
		a, ok, err := l.agentRef(ctx, claude.JSString(ref))
		if err != nil || ok {
			return a, err
		}
	}
	return db.Agent{}, fmt.Errorf("no agent %s to allocate on", jsText(ref))
}

// byName is `db.getAgent(by)?.name ?? by`.
func (l *Lifecycle) byName(ctx context.Context, by string) string {
	if a, ok, _ := l.agentRef(ctx, by); ok {
		return a.Name
	}
	return by
}

// SetAllocation is src/allocations.ts set: it sets (or replaces) one allocation on a tree, and returns the stored row
// and a sentence when this set pushes children past a parent tree's allocation (nil otherwise). It refuses when by may
// not set it on that tree, or the allocation is malformed.
func (l *Lifecycle) SetAllocation(ctx context.Context, in AllocationInput, by string, now time.Time) (db.Allocation, *string, error) {
	root, err := l.mustTree(ctx, in.Tree)
	if err != nil {
		return db.Allocation{}, nil, err
	}
	if !l.mayManageTree(ctx, by, root, nil) {
		return db.Allocation{}, nil, fmt.Errorf("%s may set an allocation only on trees inside its own tree", l.byName(ctx, by))
	}
	account := strings.TrimSpace(jsText(in.Account))
	if account == "" {
		return db.Allocation{}, nil, errors.New("an allocation needs an account")
	}
	kind, _ := in.Kind.(string)
	if kind != "usd" && kind != "window" {
		return db.Allocation{}, nil, errors.New("an allocation kind must be 'window' or 'usd'")
	}
	a := db.Allocation{RootID: root.ID, Account: account, Kind: kind, SetBy: by, SetAt: iso(now)}
	if kind == "window" {
		a.Window = strings.TrimSpace(jsText(in.Window))
		if a.Window == "" {
			return db.Allocation{}, nil, errors.New("a window allocation needs a window name")
		}
		p := jsjson.ToNumber(in.Percent)
		if math.IsNaN(p) || math.IsInf(p, 0) || p <= 0 {
			return db.Allocation{}, nil, errors.New("a window allocation needs a positive percent")
		}
		a.Percent = &p
	} else {
		a.Period = strings.TrimSpace(jsText(in.Period))
		if a.Period != "day" && a.Period != "week" && a.Period != "month" {
			return db.Allocation{}, nil, errors.New("a usd allocation needs a period of 'day', 'week', or 'month'")
		}
		m := jsjson.ToNumber(in.Amount)
		if math.IsNaN(m) || math.IsInf(m, 0) || m <= 0 {
			return db.Allocation{}, nil, errors.New("a usd allocation needs a positive amount")
		}
		a.Amount = &m
	}
	if in.Note != nil && strings.TrimSpace(claude.JSString(in.Note)) != "" {
		n := claude.JSString(in.Note)
		a.Note = &n
	}
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return db.Allocation{}, nil, err
	}
	a.ID = "al-" + hex.EncodeToString(b)
	stored, err := l.db.SetAllocation(ctx, a)
	if err != nil {
		return db.Allocation{}, nil, err
	}
	warning, err := l.overlapWarning(ctx, root.ID, account, kind, a.Window, a.Period)
	return stored, warning, err
}

// ClearAllocation is src/allocations.ts clear: one allocation by id, or every allocation matching tree, account, kind
// and scope. It returns how many went.
func (l *Lifecycle) ClearAllocation(ctx context.Context, in AllocationInput, by string) (int, error) {
	if jsjson.Truthy(in.ID) {
		id := claude.JSString(in.ID)
		a, ok, err := l.db.FindAllocation(ctx, id)
		if err != nil {
			return 0, err
		}
		if !ok {
			return 0, fmt.Errorf("no allocation %s", id)
		}
		root, found, err := l.agentRef(ctx, a.RootID)
		if err != nil {
			return 0, err
		}
		if !found || !l.mayManageTree(ctx, by, root, nil) {
			return 0, fmt.Errorf("%s may clear an allocation only on trees inside its own tree", l.byName(ctx, by))
		}
		return l.db.DeleteAllocation(ctx, a.ID)
	}
	root, err := l.mustTree(ctx, in.Tree)
	if err != nil {
		return 0, err
	}
	if !l.mayManageTree(ctx, by, root, nil) {
		return 0, fmt.Errorf("%s may clear an allocation only on trees inside its own tree", l.byName(ctx, by))
	}
	kind := "window"
	if in.Kind == "usd" {
		kind = "usd"
	}
	window, period := allocationScope(kind, jsText(in.Window), jsText(in.Period))
	return l.db.DeleteAllocationAt(ctx, root.ID, jsText(in.Account), kind, window, period)
}

// AckTreeNotices is src/cost-pause.ts ackTree for the agent rootRef names (nothing when there is none): setting or
// clearing a tree's allocation counts as acting on its cost notices.
func (l *Lifecycle) AckTreeNotices(ctx context.Context, rootRef, by, via string) error {
	root, ok, err := l.agentRef(ctx, rootRef)
	if err != nil || !ok {
		return err
	}
	agents, err := l.treeAgents(ctx, root)
	if err != nil {
		return err
	}
	_, err = l.ackTree(ctx, agents, by, via)
	return err
}

// allocationOf is an allocation's percent (window) or amount (usd), 0 for none.
func allocationOf(a db.Allocation) float64 {
	p := a.Percent
	if a.Kind == "usd" {
		p = a.Amount
	}
	if p == nil {
		return 0
	}
	return *p
}

// childrenTotal is src/allocations.ts childrenTotal: the allocations of the direct children of parentID with the same
// scope, summed (rounded to cents), and how many there are.
func (l *Lifecycle) childrenTotal(ctx context.Context, parentID, account, kind, window, period string) (float64, int, error) {
	local, err := l.db.ChildrenOf(ctx, parentID)
	if err != nil {
		return 0, 0, err
	}
	peer, err := l.db.PeerChildrenOf(ctx, parentID)
	if err != nil {
		return 0, 0, err
	}
	seen := map[string]bool{}
	var kids []string
	for _, c := range append(local, peer...) {
		if !seen[c] {
			seen[c] = true
			kids = append(kids, c)
		}
	}
	rows, err := l.db.AllocationsOf(ctx, kids, account, kind, window, period)
	if err != nil {
		return 0, 0, err
	}
	sum := 0.0
	for _, r := range rows {
		sum += allocationOf(r)
	}
	return roundCents(sum), len(rows), nil
}

// treeAncestors is src/allocations.ts treeAncestors: the agents above id (its parents and theirs).
func (l *Lifecycle) treeAncestors(ctx context.Context, id string) ([]string, error) {
	a, err := l.db.GetAgent(ctx, id)
	if err != nil {
		return nil, err
	}
	stack, err := l.db.ParentsOf(ctx, a)
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	var out []string
	for len(stack) > 0 {
		p := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[p] {
			continue
		}
		seen[p] = true
		out = append(out, p)
		if pa, ok, err := l.agentRef(ctx, p); err != nil {
			return nil, err
		} else if ok {
			ps, err := l.db.ParentsOf(ctx, pa)
			if err != nil {
				return nil, err
			}
			stack = append(stack, ps...)
		}
	}
	return out, nil
}

// overlapWarning is src/allocations.ts overlapWarning: a warning (never a refusal) when the tree's children, or an
// ancestor tree's children, add up past that parent tree's own allocation for the same account, kind and scope.
func (l *Lifecycle) overlapWarning(ctx context.Context, rootID, account, kind, window, period string) (*string, error) {
	ancestors, err := l.treeAncestors(ctx, rootID)
	if err != nil {
		return nil, err
	}
	var messages []string
	for _, id := range append([]string{rootID}, ancestors...) {
		parent, ok, err := l.db.AllocationAt(ctx, id, account, kind, window, period)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		of := allocationOf(parent)
		sum, count, err := l.childrenTotal(ctx, id, account, kind, window, period)
		if err != nil {
			return nil, err
		}
		if count == 0 || !(sum > of) {
			continue
		}
		name := l.byName(ctx, id)
		unit, total, scope := jsjson.Number(of)+"%", jsjson.Number(sum)+"%", "on "+window
		if kind == "usd" {
			unit, total, scope = "$"+jsjson.Number(of), "$"+jsjson.Number(sum), "per "+period
		}
		messages = append(messages, "warning: the allocations of "+name+"'s children add up to "+total+", over "+name+"'s own "+unit+" "+scope+" allocation; not refused.")
	}
	if len(messages) == 0 {
		return nil, nil
	}
	w := strings.Join(messages, "\n")
	return &w, nil
}

// treePaidSpend is src/allocations.ts paidSpend: a tree's paid spend in a period from stam's ledger, the column
// paidspend.go reads per account, summed over the tree's members and rounded to cents.
func (l *Lifecycle) treePaidSpend(ctx context.Context, rootID, account, period string, now time.Time) (float64, error) {
	members, err := l.treeMembers(ctx, rootID)
	if err != nil || len(members) == 0 {
		return 0, err
	}
	since, _ := periodStart(period, now)
	column := "paid_estimate_usd"
	for _, n := range openRouterAccounts(l.settings.Get()) {
		if n == account {
			column = "cost_usd"
		}
	}
	s, err := l.db.TreePaidSpend(ctx, members, account, since, column)
	return roundCents(s), err
}

// utcMinute is `new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'`.
func utcMinute(ms float64) string { return strings.Replace(isoMs(ms), "T", " ", 1)[:16] + " UTC" }

// allocationProjection is src/allocations.ts projectionLine: when the tree reaches its allocation at the rate it has
// used so far since the period began. of is percent points or dollars; resets is nil for none.
func allocationProjection(used, of, since, now float64, resets *float64) string {
	if used >= of {
		return "The tree is already at or past its allocation."
	}
	elapsed := now - since
	if elapsed <= 0 || used <= 0 {
		return "No projection yet: too little use in this period."
	}
	at := now + float64((of-used)*elapsed)/used
	when := utcMinute(at)
	if resets != nil && at >= *resets {
		return "At the current rate the period resets before the tree reaches its allocation (around " + when + ")."
	}
	return "At the current rate the tree reaches its allocation around " + when + "."
}

// allocationThreshold is the 80% or 100% line an allocation's use reached, 0 for neither, with the use as a percentage
// of the allocation.
func allocationThreshold(used, of float64) (float64, float64) {
	percent := 0.0
	if of > 0 {
		percent = used / of * 100
	}
	switch {
	case percent >= 100:
		return 100, percent
	case percent >= 80:
		return 80, percent
	}
	return 0, percent
}

// allocationNotice is src/cost-notices.ts AllocationNotice.
type allocationNotice struct {
	allocation, root, account, kind, window, period string
	used, of, usedPercent, threshold                float64
	basis, projection                               string
	note                                            *string
}

// fireWindowAllocation is src/allocations.ts fireWindow: a window allocation's notice at 80% and 100%, deduped per reset.
func (l *Lifecycle) fireWindowAllocation(ctx context.Context, a db.Allocation, used float64, since string, p projection, now time.Time) {
	of := allocationOf(a)
	threshold, percent := allocationThreshold(used, of)
	if threshold == 0 {
		return
	}
	sinceMs, _ := parseMs(since)
	var resets *float64
	if p.resetsAt != nil {
		if ms, ok := parseMs(*p.resetsAt); ok {
			resets = &ms
		}
	}
	lines := []string{allocationProjection(used, of, sinceMs, float64(now.UnixMilli()), resets)}
	if p.reaches100At != nil {
		lines = append(lines, "The "+firstUnderscore(a.Window)+" window itself reaches 100% around "+strings.Replace(*p.reaches100At, "T", " ", 1)[:16]+" UTC.")
	}
	l.allocationWarning(ctx, allocationNotice{allocation: a.ID, root: a.RootID, account: a.Account, kind: "window", window: a.Window,
		used: roundCents(used), of: of, usedPercent: roundCents(percent), threshold: threshold, basis: since,
		projection: strings.Join(lines, " "), note: a.Note}, now)
}

// fireUsdAllocation is src/allocations.ts fireUsd: a usd allocation's notice at 80% and 100%, deduped per period.
func (l *Lifecycle) fireUsdAllocation(ctx context.Context, a db.Allocation, spent float64, now time.Time) {
	of := allocationOf(a)
	threshold, percent := allocationThreshold(spent, of)
	if threshold == 0 {
		return
	}
	day, _ := periodStart(a.Period, now)
	since := day + "T00:00:00.000Z"
	sinceMs, _ := parseMs(since)
	l.allocationWarning(ctx, allocationNotice{allocation: a.ID, root: a.RootID, account: a.Account, kind: "usd", period: a.Period,
		used: roundCents(spent), of: of, usedPercent: roundCents(percent), threshold: threshold,
		// The period start is the reset a usd notice re-arms on.
		basis: since, projection: allocationProjection(spent, of, sinceMs, float64(now.UnixMilli()), nil), note: a.Note}, now)
}

// checkWindowAllocations is src/allocations.ts checkWindow, on each window reading: every window allocation on the
// account for that window is checked against the tree's estimated share since the window's current reset.
func (l *Lifecycle) checkWindowAllocations(ctx context.Context, name, window string, now time.Time) {
	account := l.accountForReading(name)
	if account == "" {
		return
	}
	rows, err := l.db.AllocationsOn(ctx, "window", account, window)
	if err != nil || len(rows) == 0 {
		if err != nil {
			slog.Error("allocations", "account", account, "window", window, "err", err)
		}
		return
	}
	shares, err := l.windowSharesOf(ctx, account, window, nil, float64(now.UnixMilli()))
	if err != nil {
		logAttribution(err, "allocation "+account+" "+window)
		return
	}
	for _, a := range rows {
		used, err := l.treeShare(ctx, a.RootID, shares)
		if err != nil {
			logAttribution(err, "allocation "+account+" "+window)
			continue
		}
		l.fireWindowAllocation(ctx, a, used, shares.since, shares.projection, now)
	}
}

// checkUsdAllocations is src/allocations.ts checkUsd, on each usage report: every usd allocation on the account.
func (l *Lifecycle) checkUsdAllocations(ctx context.Context, account string, now time.Time) {
	if account == "" {
		return
	}
	rows, err := l.db.AllocationsOn(ctx, "usd", account, "")
	if err != nil {
		slog.Error("allocations", "account", account, "err", err)
		return
	}
	for _, a := range rows {
		spent, err := l.treePaidSpend(ctx, a.RootID, account, a.Period, now)
		if err != nil {
			slog.Error("allocations", "account", account, "err", err)
			continue
		}
		l.fireUsdAllocation(ctx, a, spent, now)
	}
}

func jsNum(f float64) jsfmt.Value { return jsfmt.Value{Kind: jsfmt.Number, Num: jsjson.Number(f)} }

func jsOptNum(p *float64) jsfmt.Value {
	if p == nil {
		return jsfmt.NullValue()
	}
	return jsNum(*p)
}

func jsOptText(p *string) jsfmt.Value {
	if p == nil {
		return jsfmt.NullValue()
	}
	return jsfmt.StringValue(*p)
}

// AllocationJSON is an allocations row as TS's SELECT * gives it.
func AllocationJSON(a db.Allocation) jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("id", jsfmt.StringValue(a.ID))
	v.Set("root_id", jsfmt.StringValue(a.RootID))
	v.Set("account", jsfmt.StringValue(a.Account))
	v.Set("kind", jsfmt.StringValue(a.Kind))
	v.Set("window", jsfmt.StringValue(a.Window))
	v.Set("percent", jsOptNum(a.Percent))
	v.Set("amount", jsOptNum(a.Amount))
	v.Set("period", jsfmt.StringValue(a.Period))
	v.Set("set_by", jsfmt.StringValue(a.SetBy))
	v.Set("set_at", jsfmt.StringValue(a.SetAt))
	v.Set("note", jsOptText(a.Note))
	return v
}

// projectionJSON is src/attribution.ts Projection.
func projectionJSON(p projection) jsfmt.Value {
	v := jsfmt.Value{Kind: jsfmt.Object}
	v.Set("estimate", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
	v.Set("used_percentage", jsOptNum(p.usedPercentage))
	v.Set("percent_per_hour", jsOptNum(p.percentPerHour))
	v.Set("reaches_100_at", jsOptText(p.reaches100At))
	v.Set("resets_at", jsOptText(p.resetsAt))
	if p.note != "" {
		v.Set("note", jsfmt.StringValue(p.note))
	}
	return v
}

// AllocationViews is src/allocations.ts view: the allocations with their current use, for the CLI and usage_info. With
// rootID, only that tree's.
func (l *Lifecycle) AllocationViews(ctx context.Context, rootID string, now time.Time) ([]jsfmt.Value, error) {
	rows, err := l.db.Allocations(ctx, rootID)
	if err != nil {
		return nil, err
	}
	out := []jsfmt.Value{}
	for _, a := range rows {
		v := AllocationJSON(a)
		v.Set("root", jsfmt.StringValue(l.byName(ctx, a.RootID)))
		var used float64
		var of *float64
		var p *projection
		if a.Kind == "window" {
			shares, err := l.windowSharesOf(ctx, a.Account, a.Window, nil, float64(now.UnixMilli()))
			if err != nil {
				return nil, err
			}
			share, err := l.treeShare(ctx, a.RootID, shares)
			if err != nil {
				return nil, err
			}
			used, of, p = roundCents(share), a.Percent, &shares.projection
		} else {
			if used, err = l.treePaidSpend(ctx, a.RootID, a.Account, a.Period, now); err != nil {
				return nil, err
			}
			of = a.Amount
		}
		v.Set("used", jsNum(used))
		if of != nil && *of != 0 {
			v.Set("used_percent", jsNum(roundCents(used / *of * 100)))
		} else {
			v.Set("used_percent", jsfmt.NullValue())
		}
		if p != nil {
			v.Set("projection", projectionJSON(*p))
		}
		out = append(out, v)
	}
	return out, nil
}
