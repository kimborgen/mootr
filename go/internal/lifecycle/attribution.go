package lifecycle

import (
	"context"
	"log/slog"
	"math"
	"time"

	"stam/internal/db"
)

// Attribution and estimates (src/attribution.ts, docs/cost-policy.md build step 7, S-2848 B5c): each agent's and each
// tree's estimated share of a subscription window, and when the window reaches 100% at the current rate. Everything
// here is an estimate from stam's own samples and window readings; it never sets or clears a blocker.
//
//	weighted tokens  w = Σ over token types of tokens × price (USD per million tokens, from the registry's prices; a
//	                 model without a price weighs 1 per token, a type without a price uses the model's input price)
//	interval         two consecutive window readings a, b (the last reading in each 5-minute bucket), covering the
//	                 sample buckets after a's bucket up to b's
//	change           Δ = b% − a%, at least 0 (a fall under an unchanged, unpassed reset time is a correction: Δ = 0, no
//	                 reset); across a window reset (reset time moved or passed, or a fall with no reset time), Δ = b% and
//	                 only buckets from the reset on. A reading whose neighbours agree within 5 points and differ from it
//	                 by more is an outlier and is dropped (S-3243)
//	scale            s, percent per weighted token, an exponential moving average of Δ / W over intervals, weighted by
//	                 time (α = 1 − e^(−dt / 2 h)); reset (re-seeded from this interval's Δ / W) when the window resets or
//	                 Δ misses s × W by > 25%
//	explained        E = Δ when W > 0 and s is unknown or the miss is within 25% or Δ is below the prediction; E = s × W
//	                 when Δ exceeds the prediction by more than 25%; E = 0 when W = 0 (no stam agent ran)
//	agent share      Δ_i = w_i / W × E;   other = Δ − E;   Σ Δ_i + other = Δ
//	tree share       Σ Δ_i over the agent and its descendants, each agent once
//	projection       rate = min(s × (W over the last 30 minutes) / 30 min, R), where R is the rise the readings show over
//	                 the same 30 minutes (none when the window started inside them); 100% at now + (100 − current%) /
//	                 rate, or none when the rate is 0, s is unknown, or the window resets first
//
// Times are milliseconds as float64, as TS's numbers are, so a fractional reset time moves no boundary. The Usage page's
// summaries (windowSummary, treeTotals, the worth range and the hourly history) and the snapshot serve /api/usage
// (attribsummary.go); the cost notices need only the shares and the projection.

const (
	// emaTau is src/attribution.ts EMA_TAU_MS.
	emaTau = 2 * float64(time.Hour/time.Millisecond)
	// missRatio is src/attribution.ts MISS.
	missRatio = 0.25
	// burnSpan is src/attribution.ts BURN_MS: the span the projection's rate is read over.
	burnSpan = 30 * float64(time.Minute/time.Millisecond)
	// outlierPoints is src/attribution.ts OUTLIER: the most a reading's neighbours may differ for it to be an outlier.
	outlierPoints = 5
	// calibrationWarmup is src/attribution.ts WARMUP_MS: calibration starts this long before the span asked for.
	calibrationWarmup = 6 * float64(time.Hour/time.Millisecond)
	// bucketMs is sampleBucket in milliseconds.
	bucketMs = float64(sampleBucket / time.Millisecond)
)

// windowLength is src/attribution.ts WINDOW_MS; any other window is read as five_hour.
var windowLength = map[string]float64{"five_hour": 5 * float64(time.Hour/time.Millisecond), "seven_day": 7 * 24 * float64(time.Hour/time.Millisecond)}

// parseMs is Date.parse of a stored ISO time; false when it doesn't parse.
func parseMs(s string) (float64, bool) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0, false
	}
	return float64(t.UnixMilli()), true
}

func floorBucket(t float64) float64 { return math.Floor(t/bucketMs) * bucketMs }

// windowReading is src/attribution.ts Reading.
type windowReading struct {
	at, used float64
	resetsAt *float64
}

// sameReset is resets_at === resets_at for two readings' reset times, either null.
func sameReset(a, b *float64) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

// readings is src/attribution.ts readings: the last reading in each 5-minute bucket from from to until, oldest first,
// with isolated outliers dropped. The reading just before from is context for the outlier test on the first, so the
// same reading is judged the same way whatever range asks for it.
func (l *Lifecycle) readings(ctx context.Context, name, window string, from, until float64) ([]windowReading, error) {
	rows, err := l.db.WindowReadingsAround(ctx, name, window, isoMs(from), isoMs(until))
	if err != nil {
		return nil, err
	}
	var out []windowReading
	for _, r := range rows {
		at, ok := parseMs(r.At)
		if r.Used == nil || !ok {
			continue
		}
		reading := windowReading{at: at, used: *r.Used, resetsAt: r.ResetsAt}
		if n := len(out); n > 0 && math.Floor(out[n-1].at/bucketMs) == math.Floor(at/bucketMs) {
			out[n-1] = reading
		} else {
			out = append(out, reading)
		}
	}
	kept := withoutOutliers(out)
	inRange := kept[:0]
	for _, r := range kept {
		if r.at >= from {
			inRange = append(inRange, r)
		}
	}
	return inRange, nil
}

// withoutOutliers is src/attribution.ts withoutOutliers (S-3243): a reading whose neighbours on both sides share its
// reset time, agree with each other within outlierPoints, and sit more than that from it is dropped. The first and last
// readings have a neighbour on one side only and are kept.
func withoutOutliers(rs []windowReading) []windowReading {
	var out []windowReading
	for i, r := range rs {
		if i == 0 || i == len(rs)-1 || r.resetsAt == nil {
			out = append(out, r)
			continue
		}
		p, n := rs[i-1], rs[i+1]
		if !sameReset(p.resetsAt, r.resetsAt) || !sameReset(n.resetsAt, r.resetsAt) {
			out = append(out, r)
			continue
		}
		if !(math.Abs(p.used-n.used) <= outlierPoints && math.Abs(r.used-p.used) > outlierPoints && math.Abs(r.used-n.used) > outlierPoints) {
			out = append(out, r)
		}
	}
	return out
}

// isReset is src/attribution.ts isReset: b starts a new window after a when the reset time changed, or the percentage
// fell with no reset time to check it against, or b is past a's reset time. A fall under an unchanged, unpassed reset
// time is a correction, not a reset.
func isReset(a, b windowReading) bool {
	if !sameReset(a.resetsAt, b.resetsAt) {
		return true
	}
	if b.used >= a.used {
		return false
	}
	return a.resetsAt == nil || b.at >= *a.resetsAt*1000
}

// weightedSample is src/attribution.ts Weighted: one sample's weighted tokens, by bucket, agent and model.
type weightedSample struct {
	bucket       float64
	agent, model string
	w            float64
}

// weighted is src/attribution.ts weighted: a sample's weighted tokens at the registry's prices (a millionth of a dollar
// at API prices per unit), or its plain token count when the model has no price.
func weighted(prices map[string]price, s db.TokenSample) float64 {
	p, ok := priceOf(prices, s.Model)
	if !ok {
		return s.In + s.Out + s.CacheRead + s.CacheWrite
	}
	return p.weigh(s.In, s.Out, s.CacheRead, s.CacheWrite)
}

// weightedSamples is src/attribution.ts weightedSamples without the snapshot's memo: the account's samples with a bucket
// from from up to until.
func (l *Lifecycle) weightedSamples(ctx context.Context, account string, from, until float64) ([]weightedSample, error) {
	rows, err := l.db.TokenSamples(ctx, account, isoMs(from), isoMs(until))
	if err != nil {
		return nil, err
	}
	prices := l.prices()
	out := make([]weightedSample, 0, len(rows))
	for _, r := range rows {
		bucket, _ := parseMs(r.Bucket)
		out = append(out, weightedSample{bucket: bucket, agent: r.AgentID, model: r.Model, w: weighted(prices, r)})
	}
	return out, nil
}

// readingName is src/attribution.ts readingName: an account's window readings are stored under its harness's name; ""
// when the account isn't configured.
func (l *Lifecycle) readingName(account string) string {
	return l.settings.Get().CostAccounts[account].Harness
}

// interval is src/attribution.ts Interval: one change between two readings, the scale before it and after, and its
// split among the agents and models (percentage points), with what no stam agent explains as other.
type interval struct {
	from, to           string
	toMs               float64
	change, weighted   float64
	scaleBefore, scale *float64
	reset              string
	explained, other   float64
	agents, models     map[string]float64
	// agentOrder and modelOrder are the keys of agents and models in TS's insertion order, which the summaries' sums
	// and stable sorts follow.
	agentOrder, modelOrder []string
}

// calibration is src/attribution.ts Calibration: the intervals, the scale after the last, and the last reading.
type calibration struct {
	intervals []interval
	scale     *float64
	current   *windowReading
}

// calibrate is src/attribution.ts calibrate: it walks the readings from from to now, fitting the scale and splitting
// each change.
func (l *Lifecycle) calibrate(ctx context.Context, account, window string, from, now float64) (calibration, error) {
	name := l.readingName(account)
	if name == "" {
		return calibration{}, nil
	}
	rs, err := l.readings(ctx, name, window, from, now)
	if err != nil {
		return calibration{}, err
	}
	var samples []weightedSample
	if len(rs) > 1 {
		if samples, err = l.weightedSamples(ctx, account, floorBucket(rs[0].at)+bucketMs, floorBucket(rs[len(rs)-1].at)+bucketMs); err != nil {
			return calibration{}, err
		}
	}
	var cal calibration
	var scale *float64
	i := 0
	for k := 1; k < len(rs); k++ {
		a, b := rs[k-1], rs[k]
		start := floorBucket(a.at) + bucketMs
		end := floorBucket(b.at) + bucketMs
		windowReset := isReset(a, b)
		change := math.Max(0, b.used-a.used)
		if windowReset {
			change = b.used
			// Only tokens from the reset on count toward the new window.
			if a.resetsAt != nil && *a.resetsAt*1000 > a.at && *a.resetsAt*1000 <= b.at {
				start = math.Max(start, floorBucket(*a.resetsAt*1000))
			}
			scale = nil
		}
		agents, models := map[string]float64{}, map[string]float64{}
		var agentOrder, modelOrder []string
		W := 0.0
		for i < len(samples) && samples[i].bucket < end {
			s := samples[i]
			i++
			if s.bucket < start {
				continue
			}
			if _, ok := agents[s.agent]; !ok {
				agentOrder = append(agentOrder, s.agent)
			}
			if _, ok := models[s.model]; !ok {
				modelOrder = append(modelOrder, s.model)
			}
			agents[s.agent] += s.w
			models[s.model] += s.w
			W += s.w
		}
		before := scale
		reset := ""
		if windowReset {
			reset = "window"
		}
		explained := 0.0
		if W > 0 && change > 0 {
			ratio := change / W
			var predicted float64
			if before != nil {
				predicted = *before * W
			}
			switch {
			case before == nil:
				explained, scale = change, &ratio
			case math.Abs(change-predicted) > missRatio*predicted:
				// A miss: Δ above the prediction is partly use outside stam; below it, stam's tokens still explain all
				// of Δ. Either way the fit starts over from this interval.
				explained = change
				if change > predicted {
					explained = predicted
				}
				scale = &ratio
				if reset == "" {
					reset = "miss"
				}
			default:
				explained = change
				alpha := 1 - math.Exp(-(b.at-a.at)/emaTau)
				next := *before + alpha*(ratio-*before)
				scale = &next
			}
		}
		for id, w := range agents {
			agents[id] = 0
			if W > 0 {
				agents[id] = (w / W) * explained
			}
		}
		for m, w := range models {
			models[m] = 0
			if W > 0 {
				models[m] = (w / W) * explained
			}
		}
		cal.intervals = append(cal.intervals, interval{from: isoMs(a.at), to: isoMs(b.at), toMs: b.at, change: change, weighted: W, scaleBefore: before,
			scale: scale, reset: reset, explained: explained, other: math.Max(0, change-explained), agents: agents, models: models,
			agentOrder: agentOrder, modelOrder: modelOrder})
	}
	cal.scale = scale
	if n := len(rs); n > 0 {
		cal.current = &rs[n-1]
	}
	return cal, nil
}

// windowStart is src/attribution.ts windowStart: the start of the window's current period, its reset time minus its
// length, or now minus its length when the reset time is unknown.
func (l *Lifecycle) windowStart(ctx context.Context, account, window string, now float64) (float64, error) {
	length, ok := windowLength[window]
	if !ok {
		length = windowLength["five_hour"]
	}
	if name := l.readingName(account); name != "" {
		resets, err := l.db.LastResetsAt(ctx, name, window)
		if err != nil {
			return 0, err
		}
		if resets != nil {
			return *resets*1000 - length, nil
		}
	}
	return now - length, nil
}

// windowShares is src/attribution.ts WindowShares.
type windowShares struct {
	account, window, since string
	change, other          float64
	scale                  *float64
	// agents and models are each agent's and model's estimated percentage points of the window since since, their keys
	// in TS's insertion order in agentOrder and modelOrder.
	agents, models         map[string]float64
	agentOrder, modelOrder []string
	intervals              int
	projection             projection
}

// projection is src/attribution.ts Projection: percentPerHour and reaches100At are nil for null, and note "" for none.
type projection struct {
	usedPercentage, percentPerHour *float64
	reaches100At, resetsAt         *string
	note                           string
}

// windowSharesOf is src/attribution.ts windowShares: each agent's estimated share of one window from since (nil for the
// window's current period), other, and the projection.
func (l *Lifecycle) windowSharesOf(ctx context.Context, account, window string, since *float64, now float64) (windowShares, error) {
	var from float64
	if since != nil {
		from = *since
	} else {
		var err error
		if from, err = l.windowStart(ctx, account, window, now); err != nil {
			return windowShares{}, err
		}
	}
	cal, err := l.calibrate(ctx, account, window, from-calibrationWarmup, now)
	if err != nil {
		return windowShares{}, err
	}
	s := windowShares{account: account, window: window, since: isoMs(from), scale: cal.scale, agents: map[string]float64{}, models: map[string]float64{}}
	for _, iv := range cal.intervals {
		if iv.toMs <= from {
			continue
		}
		s.intervals++
		s.change += iv.change
		s.other += iv.other
		for _, id := range iv.agentOrder {
			if _, ok := s.agents[id]; !ok {
				s.agentOrder = append(s.agentOrder, id)
			}
			s.agents[id] += iv.agents[id]
		}
		for _, m := range iv.modelOrder {
			if _, ok := s.models[m]; !ok {
				s.modelOrder = append(s.modelOrder, m)
			}
			s.models[m] += iv.models[m]
		}
	}
	if s.projection, err = l.project(ctx, account, cal, now, window); err != nil {
		return windowShares{}, err
	}
	return s, nil
}

// observedRate is src/attribution.ts observedRate: the percent per millisecond the window readings show over the last
// 30 minutes, within the current window. Zero when they show no rise or fewer than two readings span the period; nil
// when the window began inside the period, so the readings can't say.
func (l *Lifecycle) observedRate(ctx context.Context, account, window string, now float64) (*float64, error) {
	zero := 0.0
	name := l.readingName(account)
	if name == "" {
		return &zero, nil
	}
	rs, err := l.readings(ctx, name, window, now-calibrationWarmup, now)
	if err != nil || len(rs) == 0 {
		return &zero, err
	}
	// The current window: from the last reset in the readings on.
	first := len(rs) - 1
	for first > 0 && !isReset(rs[first-1], rs[first]) {
		first--
	}
	span := rs[first:]
	last := span[len(span)-1]
	from := now - burnSpan
	// The current window must have started before the 30 minutes did: a reset or jump inside them leaves a rise from the
	// post-reset reading that the readings can't support, so no rate (S-532).
	if span[0].at > from {
		return nil, nil
	}
	// The reading at the span's start: the first at or after it, else the last (no rise then).
	base := last
	for _, r := range span {
		if r.at >= from {
			base = r
			break
		}
	}
	ms, rise := last.at-base.at, last.used-base.used
	if ms <= 0 || rise <= 0 {
		return &zero, nil
	}
	rate := rise / ms
	return &rate, nil
}

// project is src/attribution.ts project: when the window reaches 100% at the last 30 minutes' weighted tokens times the
// scale, or at the rise the readings show over the same span, whichever is slower.
func (l *Lifecycle) project(ctx context.Context, account string, cal calibration, now float64, window string) (projection, error) {
	cur := cal.current
	var p projection
	var resets *float64
	if cur != nil {
		p.usedPercentage = &cur.used
		if cur.resetsAt != nil {
			r := *cur.resetsAt * 1000
			resets = &r
			at := isoMs(r)
			p.resetsAt = &at
		}
	}
	if cur == nil {
		p.note = "no readings"
		return p, nil
	}
	if cal.scale == nil {
		p.note = "not calibrated yet"
		return p, nil
	}
	samples, err := l.weightedSamples(ctx, account, floorBucket(now-burnSpan)+bucketMs, floorBucket(now)+bucketMs)
	if err != nil {
		return projection{}, err
	}
	W := 0.0
	for _, s := range samples {
		W += s.w
	}
	scaled := (*cal.scale * W) / burnSpan
	perHour := func(perMs float64) *float64 { v := perMs * 3_600_000; return &v }
	if cur.used >= 100 {
		at := isoMs(cur.at)
		p.percentPerHour, p.reaches100At = perHour(scaled), &at
		return p, nil
	}
	if scaled <= 0 {
		p.percentPerHour, p.note = perHour(0), "no stam use in the last 30 minutes"
		return p, nil
	}
	// An inflated scale must not project past what the readings show.
	observed, err := l.observedRate(ctx, account, window, now)
	if err != nil {
		return projection{}, err
	}
	obs := 0.0
	if observed != nil {
		obs = *observed
	}
	perMs := math.Min(scaled, obs)
	p.percentPerHour = perHour(perMs)
	if observed == nil {
		p.note = "window began in the last 30 minutes"
		return p, nil
	}
	if perMs <= 0 {
		p.note = "readings show no rise in the last 30 minutes"
		return p, nil
	}
	at := now + (100-cur.used)/perMs
	if resets != nil && at >= *resets {
		p.note = "resets before reaching 100%"
		return p, nil
	}
	reaches := isoMs(at)
	p.reaches100At = &reaches
	return p, nil
}

// treeMembers is src/attribution.ts treeMembers outside a snapshot's index: the agent and everything below it, each
// once even where the tree is a DAG, following this daemon's parent links and the remembered peer agents' (src/tree.ts
// childrenOf), in TS's visiting order.
func (l *Lifecycle) treeMembers(ctx context.Context, agentID string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	stack := []string{agentID}
	for len(stack) > 0 {
		id := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
		local, err := l.db.ChildrenOf(ctx, id)
		if err != nil {
			return nil, err
		}
		peer, err := l.db.PeerChildrenOf(ctx, id)
		if err != nil {
			return nil, err
		}
		added := map[string]bool{}
		for _, c := range append(local, peer...) {
			if !added[c] {
				added[c] = true
				stack = append(stack, c)
			}
		}
	}
	return out, nil
}

// treeShare is src/attribution.ts treeShare: a tree's estimated share, the sum of its agents' shares in s.
func (l *Lifecycle) treeShare(ctx context.Context, agentID string, s windowShares) (float64, error) {
	members, err := l.treeMembers(ctx, agentID)
	if err != nil {
		return 0, err
	}
	sum := 0.0
	for _, id := range members {
		sum += s.agents[id]
	}
	return sum, nil
}

// logAttribution logs a failed estimate: a notice still goes out, with what could be said.
func logAttribution(err error, what string) {
	slog.Error("attribution", "what", what, "err", err)
}
