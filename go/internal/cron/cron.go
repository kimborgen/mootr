// Package cron is src/waits.ts's small 5-field cron parser (S-2848 B2a): minute, hour, day of month, month, day of
// week. A field is a comma list of numbers, '*', ranges 'a-b' and steps ('*/n' or 'a-b/n'). Day of month and day of
// week are OR'd when both are restricted, as cron does. Times are this machine's local time.
package cron

import (
	"fmt"
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Next is src/waits.ts nextCron: the first time after from that the spec fires, within 5 years.
func Next(spec string, from time.Time) (time.Time, error) {
	trimmed := strings.TrimSpace(spec)
	fields := strings.Fields(trimmed)
	if trimmed == "" {
		// "".split(/\s+/) is [""]: one field.
		fields = []string{""}
	}
	if len(fields) != 5 {
		return time.Time{}, fmt.Errorf("cron needs 5 fields, got %d: \"%s\"", len(fields), spec)
	}
	mi, ho, dom, mo, dow := fields[0], fields[1], fields[2], fields[3], fields[4]
	minutes, err := values(mi, 0, 59, "minute")
	if err != nil {
		return time.Time{}, err
	}
	hours, err := values(ho, 0, 23, "hour")
	if err != nil {
		return time.Time{}, err
	}
	doms, err := values(dom, 1, 31, "day of month")
	if err != nil {
		return time.Time{}, err
	}
	months, err := values(mo, 1, 12, "month")
	if err != nil {
		return time.Time{}, err
	}
	dows, err := values(dow, 0, 7, "day of week")
	if err != nil {
		return time.Time{}, err
	}
	// 7 is Sunday too.
	if dows[7] {
		delete(dows, 7)
		dows[0] = true
	}
	domStar, dowStar := strings.HasPrefix(dom, "*"), strings.HasPrefix(dow, "*")
	dayMatches := func(d time.Time) bool {
		dm, dw := doms[d.Day()], dows[int(d.Weekday())]
		if !domStar && !dowStar {
			return dm || dw
		}
		return dm && dw
	}
	hourList, minuteList := sorted(hours), sorted(minutes)
	from = from.Local()
	for i := 0; i < 366*5; i++ {
		d := time.Date(from.Year(), from.Month(), from.Day()+i, 0, 0, 0, 0, time.Local)
		if !months[int(d.Month())] || !dayMatches(d) {
			continue
		}
		for _, h := range hourList {
			for _, m := range minuteList {
				cand := Local(d.Year(), d.Month(), d.Day(), h, m)
				if !cand.After(from) {
					continue
				}
				// A local time inside a daylight-saving gap doesn't exist, and the zone moves it: only a candidate whose
				// fields still match is a real fire time.
				if cand.Hour() != h || cand.Minute() != m || cand.Day() != d.Day() || cand.Month() != d.Month() {
					continue
				}
				return cand, nil
			}
		}
	}
	return time.Time{}, fmt.Errorf("no cron time within 5 years for \"%s\"", spec)
}

// Local is time.Date in local time at minute precision, normalized as JavaScript's Date is: a time a clock set back
// repeats is its first.
func Local(year int, month time.Month, day, hour, min int) time.Time {
	return earliest(time.Date(year, month, day, hour, min, 0, 0, time.Local))
}

// earliest is the first of a local time that happens twice, as a clock set back for daylight saving repeats one:
// JavaScript's Date takes the first, Go's time.Date may take the second.
func earliest(t time.Time) time.Time {
	_, now := t.Zone()
	_, before := t.Add(-3 * time.Hour).Zone()
	if before <= now {
		return t
	}
	if e := t.Add(-time.Duration(before-now) * time.Second); e.Hour() == t.Hour() && e.Minute() == t.Minute() && e.Day() == t.Day() {
		return e
	}
	return t
}

var rangeRE = regexp.MustCompile(`^(\d+)(?:-(\d+))?$`)

// values is src/waits.ts fieldValues: the field's values, validated.
func values(spec string, min, max int, name string) (map[int]bool, error) {
	out := map[int]bool{}
	for _, part := range strings.Split(spec, ",") {
		pieces := strings.Split(part, "/")
		rng := pieces[0]
		step := 1.0
		if len(pieces) > 1 {
			step = number(pieces[1])
		}
		if step != math.Trunc(step) || step < 1 || math.IsInf(step, 0) {
			return nil, fmt.Errorf("bad cron %s step in \"%s\"", name, part)
		}
		lo, hi := min, max
		if rng != "" && rng != "*" {
			m := rangeRE.FindStringSubmatch(rng)
			if m == nil {
				return nil, fmt.Errorf("bad cron %s \"%s\"", name, part)
			}
			lo = atoi(m[1])
			hi = lo
			if m[2] != "" {
				hi = atoi(m[2])
			}
		}
		if lo < min || hi > max || lo > hi {
			return nil, fmt.Errorf("cron %s out of range in \"%s\" (%d-%d)", name, part, min, max)
		}
		// In float64, as JS loops: a step past int's range (`*/1e30`) ends the loop after lo instead of overflowing.
		for v := float64(lo); v <= float64(hi); v += step {
			out[int(v)] = true
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("empty cron %s \"%s\"", name, spec)
	}
	return out, nil
}

func sorted(set map[int]bool) []int {
	out := make([]int, 0, len(set))
	for v := range set {
		out = append(out, v)
	}
	sort.Ints(out)
	return out
}

// atoi reads digits as Number does; a number past int's range can't be in any field's range.
func atoi(s string) int {
	n, err := strconv.Atoi(s)
	if err != nil {
		return math.MaxInt
	}
	return n
}

var prefixed = regexp.MustCompile(`^0([xXbBoO])([0-9a-fA-F]+)$`)

// number is Number(s) for a step: "" is 0, a decimal number or a 0x, 0b or 0o integer is its value, and anything else
// is NaN (Infinity too, which no step accepts either).
func number(s string) float64 {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0
	}
	if m := prefixed.FindStringSubmatch(t); m != nil {
		base := map[byte]int{'x': 16, 'b': 2, 'o': 8}[m[1][0]|0x20]
		n, ok := new(big.Int).SetString(m[2], base)
		if !ok {
			return math.NaN()
		}
		f, _ := new(big.Float).SetInt(n).Float64()
		return f
	}
	if strings.ContainsAny(t, "_xXpPiInN") {
		return math.NaN()
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}
