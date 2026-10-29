package lifecycle

import (
	"math"
	"time"

	"stam/internal/jsjson"
)

// Usage history (src/usage-history.ts, docs/cost-policy.md build step 9, S-3807): how much of a subscription window is
// used per hour, by hour of day and weekday, overall and per agent and tree, and a projection that follows that usual
// pattern for the coming hours. Built from attribution.go's calibration (the same intervals and agent shares), never a
// second attribution path. Everything is an estimate; it never sets or clears a blocker.
//
//	slot        (weekday, hour) in the daemon's local time
//	piece       each calibration interval [a, b] is cut at local hour boundaries; a piece of length t gets
//	            change × t / (b − a), and each agent's share likewise
//	rate        percent per hour of a slot = Σ piece change / Σ piece hours, so only time the readings covered counts
//	hour, day   the same rate over every slot with that hour of day, or with that weekday
//	agent, tree an agent's rate uses its share of each piece over the same covered hours; a tree's is the sum over its
//	            members, each once
//	pattern     from now: the rest of this hour at the current rate (the 30-minute projection's percent_per_hour),
//	            then each later hour at its slot's rate, or the hour of day's when the slot has under minSlotHours
//	            covered, or the current rate when neither has; 100% where the running sum reaches 100 − used, or none
//	            when the window resets first or the horizon (the reset, else the window's length) ends

const hourMs = float64(time.Hour / time.Millisecond)

// minSlotHours is src/usage-history.ts MIN_HOURS: a slot's covered hours before the pattern trusts its rate.
const minSlotHours = 1

// weekdays is src/usage-history.ts DAYS.
var weekdays = []string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

func round2(n float64) float64 { return round(n*100) / 100 }

// localOf is new Date(t) in the daemon's local time: the time value truncated to a whole millisecond.
func localOf(t float64) time.Time { return time.UnixMilli(int64(math.Trunc(t))).In(time.Local) }

// nextHour is src/usage-history.ts nextHour: the start of the next local hour after t, as the time left in this local
// hour in real milliseconds, so a fall-back's repeated hour is kept and a spring-forward gap is crossed.
func nextHour(t float64) float64 {
	d := localOf(t)
	return t - float64(d.Minute()*60_000+d.Second()*1000+d.Nanosecond()/1e6) + hourMs
}

// slotOf is a time's slot, weekday × 24 + hour, in local time.
func slotOf(t float64) int {
	d := localOf(t)
	return int(d.Weekday())*24 + d.Hour()
}

// hourCell is src/usage-history.ts Cell; order is the agents in the order they first had a share, as the TS Map's.
type hourCell struct {
	hours, change float64
	agents        map[string]float64
	order         []string
}

func (c *hourCell) add(id string, p float64) {
	if _, ok := c.agents[id]; !ok {
		c.order = append(c.order, id)
	}
	c.agents[id] += p
}

// hourlyHistory is src/usage-history.ts Hourly: slots keyed by weekday × 24 + hour.
type hourlyHistory struct {
	from  float64
	slots []*hourCell
}

// hourly is src/usage-history.ts hourly: each interval ending after from cut into local-hour pieces and summed per slot.
func hourly(cal calibration, from float64) hourlyHistory {
	h := hourlyHistory{from: from, slots: make([]*hourCell, 7*24)}
	for i := range h.slots {
		h.slots[i] = &hourCell{agents: map[string]float64{}}
	}
	for _, iv := range cal.intervals {
		ivFrom, _ := parseMs(iv.from)
		a, b := math.Max(ivFrom, from), iv.toMs
		length := b - ivFrom
		if b <= a || length <= 0 {
			continue
		}
		for t := a; t < b; {
			end := math.Min(nextHour(t), b)
			f := (end - t) / length
			c := h.slots[slotOf(t)]
			c.hours += (end - t) / hourMs
			c.change += iv.change * f
			for _, id := range iv.agentOrder {
				c.add(id, iv.agents[id]*f)
			}
			t = end
		}
	}
	return h
}

// hourRate is src/usage-history.ts rate's answer: percentPerHour nil for null.
type hourRate struct {
	percentPerHour *float64
	hours          float64
}

// rate is src/usage-history.ts rate: Σ change (or the members' share; nil members for all) / Σ covered hours.
func rate(cells []*hourCell, members map[string]bool) hourRate {
	hours, change := 0.0, 0.0
	for _, c := range cells {
		hours += c.hours
		if members == nil {
			change += c.change
			continue
		}
		for _, id := range c.order {
			if members[id] {
				change += c.agents[id]
			}
		}
	}
	r := hourRate{hours: round2(hours)}
	if hours > 0 {
		p := round2(change / hours)
		r.percentPerHour = &p
	}
	return r
}

func optNumber(p *float64) jsjson.Value {
	if p == nil {
		return nil
	}
	return *p
}

func byHourCells(h hourlyHistory, hour int) []*hourCell {
	out := make([]*hourCell, len(weekdays))
	for d := range weekdays {
		out[d] = h.slots[d*24+hour]
	}
	return out
}

func byDayCells(h hourlyHistory, day int) []*hourCell { return h.slots[day*24 : day*24+24] }

// profile is src/usage-history.ts profile: the rate per hour of day and per weekday, overall (nil members) or for one
// agent set, as the by_hour and by_weekday keys it spreads.
func profile(h hourlyHistory, members map[string]bool) (byHour, byWeekday []jsjson.Value) {
	for hour := range 24 {
		r := rate(byHourCells(h, hour), members)
		byHour = append(byHour, jsjson.NewObject("hour", float64(hour), "percent_per_hour", optNumber(r.percentPerHour), "hours", r.hours))
	}
	for d, day := range weekdays {
		r := rate(byDayCells(h, d), members)
		byWeekday = append(byWeekday, jsjson.NewObject("day", day, "percent_per_hour", optNumber(r.percentPerHour), "hours", r.hours))
	}
	return byHour, byWeekday
}

// hourRates is src/usage-history.ts hourRates: one agent set's rate per hour of day, null where nothing was covered.
func hourRates(h hourlyHistory, members map[string]bool) []jsjson.Value {
	out := make([]jsjson.Value, 24)
	for hour := range 24 {
		out[hour] = optNumber(rate(byHourCells(h, hour), members).percentPerHour)
	}
	return out
}

// agentRates is src/usage-history.ts agentRates: each agent's average and hour-of-day rates in one pass, the numbers
// average(h, {id}) and hourRates(h, {id}) give.
func agentRates(h hourlyHistory, ids []string) map[string]*jsjson.Object {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	change := map[string]float64{}
	changeByHour := make([]map[string]float64, 24)
	for i := range changeByHour {
		changeByHour[i] = map[string]float64{}
	}
	hoursByHour := make([]float64, 24)
	hours := 0.0
	for i, c := range h.slots {
		hour := i % 24
		hours += c.hours
		hoursByHour[hour] += c.hours
		for _, id := range c.order {
			if !want[id] {
				continue
			}
			change[id] += c.agents[id]
			changeByHour[hour][id] += c.agents[id]
		}
	}
	out := map[string]*jsjson.Object{}
	for id := range want {
		var avg jsjson.Value
		if hours > 0 {
			avg = round2(change[id] / hours)
		}
		byHour := make([]jsjson.Value, 24)
		for hour := range 24 {
			if hoursByHour[hour] > 0 {
				byHour[hour] = round2(changeByHour[hour][id] / hoursByHour[hour])
			}
		}
		out[id] = jsjson.NewObject("percent_per_hour", avg, "by_hour", byHour)
	}
	return out
}

// average is src/usage-history.ts average: the rate over every covered hour, for one agent set (nil for all).
func average(h hourlyHistory, members map[string]bool) jsjson.Value {
	return optNumber(rate(h.slots, members).percentPerHour)
}

// slotRate is src/usage-history.ts slotRate: the rate for the hour starting at t, its slot's, else its hour of day's;
// false when neither has enough covered hours.
func slotRate(h hourlyHistory, t float64) (float64, bool) {
	slot := h.slots[slotOf(t)]
	if slot.hours >= minSlotHours {
		return slot.change / slot.hours, true
	}
	r := rate(byHourCells(h, localOf(t).Hour()), nil)
	if r.hours >= minSlotHours && r.percentPerHour != nil {
		return *r.percentPerHour, true
	}
	return 0, false
}

// patternProjection is src/usage-history.ts patternProjection: when the window reaches 100% at the current rate for the
// rest of this hour and the usual rate for each hour after it.
func patternProjection(h hourlyHistory, p projection, windowMs, now float64) *jsjson.Object {
	out := jsjson.NewObject("estimate", true, "reaches_100_at", nil)
	if p.usedPercentage == nil {
		out.Set("note", "no readings")
		return out
	}
	if *p.usedPercentage >= 100 {
		if p.reaches100At != nil {
			out.Set("reaches_100_at", *p.reaches100At)
		}
		return out
	}
	var resets *float64
	if p.resetsAt != nil {
		r := dateParse(*p.resetsAt)
		resets = &r
	}
	horizon := now + windowMs
	if resets != nil {
		horizon = *resets
	}
	left := 100 - *p.usedPercentage
	for t, first := now, true; t < horizon; first = false {
		end := math.Min(nextHour(t), horizon)
		// (first ? current : null) ?? slotRate(h, t) ?? current ?? 0
		var r float64
		if first && p.percentPerHour != nil {
			r = *p.percentPerHour
		} else if s, ok := slotRate(h, t); ok {
			r = s
		} else if p.percentPerHour != nil {
			r = *p.percentPerHour
		}
		add := (r * (end - t)) / hourMs
		// Reaching 100% only at the horizon is not reaching it, as in project.
		if r > 0 && add >= left {
			at := t + (left/r)*hourMs
			if at < horizon {
				out.Set("reaches_100_at", isoMs(at))
				return out
			}
			break
		}
		left -= add
		t = end
	}
	if resets != nil {
		out.Set("note", "resets before reaching 100% at the usual pattern")
	} else {
		out.Set("note", "does not reach 100% within the window at the usual pattern")
	}
	return out
}

// paceMinHours is src/usage-history.ts PACE_MIN_HOURS.
var paceMinHours = map[string]float64{"pace_7d": 24, "pace_24h": 2}

// paceAt is src/usage-history.ts paceAt: a flat-rate forecast at the history's average rate, nil (null) when it covers
// too few hours or no reading says how much is used.
func paceAt(h hourlyHistory, min float64, p projection, now float64) jsjson.Value {
	r := rate(h.slots, nil)
	if r.percentPerHour == nil || r.hours < min || p.usedPercentage == nil {
		return nil
	}
	used, perHour := *p.usedPercentage, *r.percentPerHour
	var resets *float64
	if p.resetsAt != nil {
		x := dateParse(*p.resetsAt)
		resets = &x
	}
	out := jsjson.NewObject("estimate", true, "percent_per_hour", perHour, "covered_hours", r.hours)
	if used >= 100 {
		out.Set("at_reset", 100.0)
		if p.reaches100At != nil {
			out.Set("reaches_100_at", *p.reaches100At)
		} else {
			out.Set("reaches_100_at", nil)
		}
		return out
	}
	// Reaching 100% only at the reset is not reaching it, as in project.
	if perHour > 0 {
		at := now + ((100-used)/perHour)*hourMs
		if resets == nil || at < *resets {
			if resets == nil {
				out.Set("at_reset", nil)
			} else {
				out.Set("at_reset", 100.0)
			}
			out.Set("reaches_100_at", isoMs(at))
			return out
		}
	}
	if resets == nil {
		out.Set("at_reset", nil)
	} else {
		out.Set("at_reset", math.Min(100, round2(used+(perHour*math.Max(0, *resets-now))/hourMs)))
	}
	out.Set("reaches_100_at", nil)
	return out
}

// paces is src/usage-history.ts paces: the 7-day and 24-hour paces from the calibration that feeds the hourly history.
func paces(cal calibration, p projection, now float64) (pace7d, pace24h jsjson.Value) {
	return paceAt(hourly(cal, now-7*24*hourMs), paceMinHours["pace_7d"], p, now), paceAt(hourly(cal, now-24*hourMs), paceMinHours["pace_24h"], p, now)
}
