package server

import (
	"math"
	"math/big"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"stam/internal/mcp"
)

// The retro digest and the Retros view (src/retro-digest.ts, S-161, S-162): the retro items and feedback reports filed
// or +1'd in a period, the final rounds and archives in it, and the loop-health metrics (S-806), as Markdown for the
// digest mail or as rows for the view. buildDigest, buildRetros and loopLines are pure, so the test feeds them the rows
// it feeds src/retro-digest.ts; gather reads the stores (retro_digest_send.go).

const (
	digestMaxKeys       = 3
	digestMaxWithout    = 10
	digestMaxTargets    = 5
	digestMaxRecurrence = 5
	retrosParentKind    = "retros"
	retrosParentTitle   = "Retros"
)

// evidenceKinds is src/retro.ts EVIDENCE_KINDS, in rank order.
var evidenceKinds = []string{"human", "gate", "review", "rollback", "measured", "none"}

// evidenceRank is src/retro.ts evidenceRank: the position in evidenceKinds, an unknown one last.
func evidenceRank(evidence string) int {
	for i, k := range evidenceKinds {
		if k == evidence {
			return i
		}
	}
	return len(evidenceKinds)
}

// digestItem is a retro item or feedback report as the digest groups it and the Retros view lists it (RetroRow).
// Evidence is always set ("none" when the header has none), as gather sets it. Report is absent in an agent type's
// memory, as in TS.
type digestItem struct {
	ID        string `json:"id"`
	Key       string `json:"key"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	Kind      string `json:"kind"`
	Target    string `json:"target"`
	Evidence  string `json:"evidence"`
	When      string `json:"when"`
	PlusOnes  int    `json:"plusOnes"`
	Report    *bool  `json:"report,omitempty"`
}

// digestRound is one final round: the self-reported split, and the measured one beside it (nil when there is none).
type digestRound struct {
	Name     string             `json:"name"`
	Model    *string            `json:"model"`
	Type     *string            `json:"type"`
	Effort   map[string]float64 `json:"effort"`
	Measured map[string]float64 `json:"measured"`
}

// digestLive is an agent not archived yet, active in the period, with its measured split.
type digestLive struct {
	Name     string             `json:"name"`
	Model    *string            `json:"model"`
	Type     *string            `json:"type"`
	Measured map[string]float64 `json:"measured"`
}

// digestArchived is an agent archived in the period, whether it filed a final round, and why it skipped one.
type digestArchived struct {
	Name     string  `json:"name"`
	HasRound bool    `json:"hasRound"`
	Reason   *string `json:"reason,omitempty"`
}

// loopItem is a retro item for the loop metrics: its target, its creation, and when each counted +1 arrived.
type loopItem struct {
	Key       string   `json:"key"`
	Target    string   `json:"target"`
	CreatedAt string   `json:"created_at"`
	PlusOnes  []string `json:"plusOnes"`
}

// loopAnswer is a proposal closed as done and one retro item on its `Answers:` line.
type loopAnswer struct {
	Proposal string `json:"proposal"`
	Item     string `json:"item"`
	ClosedAt string `json:"closed_at"`
}

type wordDelta struct {
	File  string `json:"file"`
	Delta int    `json:"delta"`
}

type loopRows struct {
	Since   string       `json:"since"`
	Items   []loopItem   `json:"items"`
	Answers []loopAnswer `json:"answers"`
	Words   []wordDelta  `json:"words"`
}

type digestRows struct {
	Items    []digestItem     `json:"items"`
	Rounds   []digestRound    `json:"rounds"`
	Archived []digestArchived `json:"archived"`
	Live     []digestLive     `json:"live"`
	Loop     *loopRows        `json:"loop"`
}

// localeCompare is String.prototype.localeCompare, as the CLDR root collation (instructions.localeCompare). A
// Collator keeps buffers between calls, so each sort takes its own.
func localeCompare() func(a, b string) int { return collate.New(language.Und).CompareString }

// toFixed1 is Number.prototype.toFixed(1) for x >= 0: the nearer tenth of x's exact value, a tie going up.
func toFixed1(x float64) string {
	f := new(big.Float).SetPrec(256).SetFloat64(x)
	f.Mul(f, big.NewFloat(10))
	n, _ := f.Int(nil)
	if new(big.Float).Sub(f, new(big.Float).SetInt(n)).Cmp(big.NewFloat(0.5)) >= 0 {
		n.Add(n, big.NewInt(1))
	}
	s := n.String()
	if len(s) < 2 {
		s = "0" + s
	}
	return s[:len(s)-1] + "." + s[len(s)-1:]
}

func pluralOf(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return strconv.Itoa(n) + " " + word + "s"
}

func plusOnesOf(n int) string {
	if n == 1 {
		return "1 +1"
	}
	return strconv.Itoa(n) + " +1s"
}

// meanOf is the mean of one key over splits, 0 for a missing key.
func meanOf(xs []map[string]float64, k string) float64 {
	n := 0.0
	for _, x := range xs {
		n += x[k]
	}
	return n / float64(len(xs))
}

func orText(p *string, def string) string {
	if p == nil {
		return def
	}
	return *p
}

// run is one `model · type` group of rounds or live rows.
type run[T any] struct {
	label string
	rows  []T
}

// runsOf groups rows by `model · type`, sorted by that label.
func runsOf[T any](xs []T, modelType func(T) (*string, *string)) []run[T] {
	var out []run[T]
	at := map[string]int{}
	for _, x := range xs {
		m, t := modelType(x)
		label := orText(m, "no model") + " · " + orText(t, "no type")
		i, ok := at[label]
		if !ok {
			i = len(out)
			at[label] = i
			out = append(out, run[T]{label: label})
		}
		out[i].rows = append(out[i].rows, x)
	}
	cmp := localeCompare()
	sort.SliceStable(out, func(i, j int) bool { return cmp(out[i].label, out[j].label) < 0 })
	return out
}

func roundRuns(rs []digestRound) []run[digestRound] {
	return runsOf(rs, func(r digestRound) (*string, *string) { return r.Model, r.Type })
}

func efforts(rs []digestRound) []map[string]float64 {
	out := make([]map[string]float64, len(rs))
	for i, r := range rs {
		out[i] = r.Effort
	}
	return out
}

func measureds(rs []digestRound) []map[string]float64 {
	var out []map[string]float64
	for _, r := range rs {
		if r.Measured != nil {
			out = append(out, r.Measured)
		}
	}
	return out
}

// effortCell is a self-reported cell: the average share, then the measured average of the rounds that have one.
func effortCell(rs []digestRound, k string) string {
	measured := "–"
	if ms := measureds(rs); len(ms) > 0 {
		measured = jsNumText(jsRound(meanOf(ms, k))) + "%"
	}
	return jsNumText(jsRound(meanOf(efforts(rs), k))) + "% (measured " + measured + ")"
}

type effortGap struct {
	label, key           string
	self, measured, diff float64
}

// largestGap is the self-report whose measured average is furthest from it, over the runs with measured rounds.
func largestGap(rounds []digestRound) *effortGap {
	var best *effortGap
	for _, g := range roundRuns(rounds) {
		ms := measureds(g.rows)
		if len(ms) == 0 {
			continue
		}
		for _, k := range effortKeys {
			self := jsRound(meanOf(efforts(g.rows), k))
			got := jsRound(meanOf(ms, k))
			if best == nil || math.Abs(got-self) > math.Abs(best.diff) {
				best = &effortGap{g.label, k, self, got, got - self}
			}
		}
	}
	return best
}

// digestLabel is the label of the subject and heading: the local date when daily, the ISO week otherwise.
func digestLabel(t time.Time, day string) string {
	if day == "daily" {
		return t.Format("2006-01-02")
	}
	y, w := t.ISOWeek()
	return strconv.Itoa(y) + "-W" + pad2(w)
}

func pad2(n int) string {
	if n < 10 {
		return "0" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// splitJSSpace is s.trim().split(/\s+/).filter(Boolean).
func splitJSSpace(s string) []string { return strings.FieldsFunc(s, mcp.IsJSSpace) }

var (
	reInstructionFile = regexp.MustCompile(`^(?:CLAUDE\.md|AGENTS\.md|templates/type-[^/]+\.md)$`)
	// JS's \S is not JS whitespace, and `.` stops at a line terminator; without the m flag `$` is the end of the line.
	reDiffGit   = regexp.MustCompile(`^diff --git a/[^` + mcp.JSSpace + `]+ b/([^` + mcp.JSSpace + `]+)$`)
	reDiffFrom  = regexp.MustCompile(`^--- a/([^\n\r\x{2028}\x{2029}]+)$`)
	reDiffTo    = regexp.MustCompile(`^\+\+\+ b/([^\n\r\x{2028}\x{2029}]+)$`)
	reAnswerKey = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]*-[0-9]+$`)
)

// isLineEnd is a JS line terminator, where the m flag's ^ and $ match.
func isLineEnd(r byte, s string, i int) bool {
	switch r {
	case '\n', '\r':
		return true
	case 0xe2:
		return strings.HasPrefix(s[i:], " ") || strings.HasPrefix(s[i:], " ")
	}
	return false
}

// lineStart is whether i starts a line, as the m flag's ^ reads it.
func lineStart(s string, i int) bool {
	if i == 0 {
		return true
	}
	if s[i-1] == '\n' || s[i-1] == '\r' {
		return true
	}
	return i >= 3 && (s[i-3:i] == " " || s[i-3:i] == " ")
}

// lineEnd is whether i ends a line, as the m flag's $ reads it.
func lineEnd(s string, i int) bool { return i == len(s) || isLineEnd(s[i], s, i) }

// diffBlock is /^```diff\n([\s\S]*?)^```$/m's group: the first fenced diff block that closes.
func diffBlock(body string) string {
	const open = "```diff\n"
	for i := 0; i+len(open) <= len(body); i++ {
		if !lineStart(body, i) || !strings.HasPrefix(body[i:], open) {
			continue
		}
		from := i + len(open)
		for j := from; j+3 <= len(body); j++ {
			if lineStart(body, j) && strings.HasPrefix(body[j:], "```") && lineEnd(body, j+3) {
				return body[from:j]
			}
		}
	}
	return ""
}

// wordsInDiff is src/retro-digest.ts wordsInDiff: the net word delta per instruction file in a body's diff block.
func wordsInDiff(body string) []wordDelta {
	block := diffBlock(body)
	if block == "" {
		return nil
	}
	var out []wordDelta
	at := map[string]int{}
	file := ""
	for _, line := range strings.Split(block, "\n") {
		head := ""
		if m := reDiffGit.FindStringSubmatch(line); m != nil {
			head = m[1]
		} else if m := reDiffFrom.FindStringSubmatch(line); m != nil {
			head = m[1]
		} else if m := reDiffTo.FindStringSubmatch(line); m != nil {
			head = m[1]
		}
		if head != "" {
			file = ""
			if reInstructionFile.MatchString(head) {
				file = head
			}
			continue
		}
		if file == "" || (!strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "-")) {
			continue
		}
		n := len(splitJSSpace(line[1:]))
		if line[0] == '-' {
			n = -n
		}
		i, ok := at[file]
		if !ok {
			i = len(out)
			at[file] = i
			out = append(out, wordDelta{File: file})
		}
		out[i].Delta += n
	}
	return nonZero(out)
}

func nonZero(ws []wordDelta) []wordDelta {
	out := []wordDelta{}
	for _, w := range ws {
		if w.Delta != 0 {
			out = append(out, w)
		}
	}
	return out
}

// answersOf is src/retro-loop.ts answersOf: the retro item keys on a body's first `Answers:` line, once each. As the
// regexp /^\s*Answers:\s*(.*)$/m does, the spaces around the label may span lines.
func answersOf(body string) []string {
	line := ""
	for i := 0; i <= len(body); i++ {
		if !lineStart(body, i) {
			continue
		}
		j := i + len(body[i:]) - len(strings.TrimLeftFunc(body[i:], mcp.IsJSSpace))
		if !strings.HasPrefix(body[j:], "Answers:") {
			continue
		}
		rest := strings.TrimLeftFunc(body[j+len("Answers:"):], mcp.IsJSSpace)
		end := 0
		for end < len(rest) && !isLineEnd(rest[end], rest, end) {
			end++
		}
		line = rest[:end]
		break
	}
	out := []string{}
	seen := map[string]bool{}
	for _, k := range strings.FieldsFunc(line, func(r rune) bool { return r == ',' || mcp.IsJSSpace(r) }) {
		if reAnswerKey.MatchString(k) && !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	return out
}

// answeredTargets is src/retro-digest.ts answeredTargets: a proposal closed as done answers its `Answers:` items.
func answeredTargets(key, status, closedAt, body string) []loopAnswer {
	if status != "done" || closedAt == "" {
		return nil
	}
	var out []loopAnswer
	for _, item := range answersOf(body) {
		out = append(out, loopAnswer{Proposal: key, Item: item, ClosedAt: closedAt})
	}
	return out
}

// isUntargeted is an item with no target: the header's `none`, whatever its case or whitespace.
func isUntargeted(target string) bool {
	return strings.ToLower(strings.TrimFunc(target, mcp.IsJSSpace)) == "none"
}

type targetCount struct {
	target          string
	items, plusOnes int
}

type recurrence struct {
	key, target     string
	items, plusOnes int
}

type loopMetrics struct {
	newItems, newPlusOnes               int
	untargetedItems, untargetedPlusOnes int
	targets                             []targetCount
	moreTargets                         int
	recurrence                          []recurrence
	moreRecurrence                      int
	perAgent                            *float64
	words                               []wordDelta
	wordsTotal                          int
}

func countSince(ts []string, since string) int {
	n := 0
	for _, t := range ts {
		if t >= since {
			n++
		}
	}
	return n
}

// metricsOf is src/retro-digest.ts loopMetrics.
func metricsOf(loop loopRows, archived int) loopMetrics {
	in := func(t string) bool { return t >= loop.Since }
	b2i := func(b bool) int {
		if b {
			return 1
		}
		return 0
	}
	var m loopMetrics
	for _, x := range loop.Items {
		fresh := countSince(x.PlusOnes, loop.Since)
		m.newItems += b2i(in(x.CreatedAt))
		m.newPlusOnes += fresh
		if isUntargeted(x.Target) {
			m.untargetedItems += b2i(in(x.CreatedAt))
			m.untargetedPlusOnes += fresh
		}
	}
	var ranked []targetCount
	at := map[string]int{}
	for _, x := range loop.Items {
		fresh := countSince(x.PlusOnes, loop.Since)
		if b2i(in(x.CreatedAt))+fresh == 0 || isUntargeted(x.Target) {
			continue
		}
		i, ok := at[x.Target]
		if !ok {
			i = len(ranked)
			at[x.Target] = i
			ranked = append(ranked, targetCount{target: x.Target})
		}
		ranked[i].items += b2i(in(x.CreatedAt))
		ranked[i].plusOnes += fresh
	}
	cmp := localeCompare()
	sort.SliceStable(ranked, func(i, j int) bool {
		a, b := ranked[i], ranked[j]
		if d := (b.items + b.plusOnes) - (a.items + a.plusOnes); d != 0 {
			return d < 0
		}
		if a.items != b.items {
			return a.items > b.items
		}
		return cmp(a.target, b.target) < 0
	})

	// Each target a done proposal answered, counted from the latest close of the proposals that answered it.
	targetOf := map[string]string{}
	for _, x := range loop.Items {
		targetOf[x.Key] = x.Target
	}
	type seen struct{ key, at string }
	var order []string
	answered := map[string]seen{}
	for _, a := range loop.Answers {
		target := targetOf[a.Item]
		if target == "" || isUntargeted(target) {
			continue
		}
		s, ok := answered[target]
		if !ok {
			order = append(order, target)
		}
		if !ok || a.ClosedAt > s.at {
			answered[target] = seen{a.Proposal, a.ClosedAt}
		}
	}
	var rec []recurrence
	for _, target := range order {
		s := answered[target]
		r := recurrence{key: s.key, target: target}
		for _, x := range loop.Items {
			if x.Target == target {
				if x.CreatedAt >= s.at {
					r.items++
				}
				r.plusOnes += countSince(x.PlusOnes, s.at)
			}
		}
		rec = append(rec, r)
	}
	sort.SliceStable(rec, func(i, j int) bool {
		a, b := rec[i], rec[j]
		if d := (b.items + b.plusOnes) - (a.items + a.plusOnes); d != 0 {
			return d < 0
		}
		return cmp(a.target, b.target) < 0
	})

	m.targets, m.moreTargets = ranked, 0
	if len(ranked) > digestMaxTargets {
		m.targets, m.moreTargets = ranked[:digestMaxTargets], len(ranked)-digestMaxTargets
	}
	m.recurrence = rec
	if len(rec) > digestMaxRecurrence {
		m.recurrence, m.moreRecurrence = rec[:digestMaxRecurrence], len(rec)-digestMaxRecurrence
	}
	if archived > 0 {
		p := float64(m.newItems) / float64(archived)
		m.perAgent = &p
	}
	m.words = loop.Words
	for _, w := range loop.Words {
		m.wordsTotal += w.Delta
	}
	return m
}

// loopHasNews is src/retro-digest.ts loopHasNews: activity in the period, or an instruction word delta.
func loopHasNews(loop loopRows, archived int) bool {
	m := metricsOf(loop, archived)
	return m.newItems > 0 || m.newPlusOnes > 0 || len(m.words) > 0
}

func signed(n int) string {
	if n > 0 {
		return "+" + strconv.Itoa(n)
	}
	return strconv.Itoa(n)
}

// loopLines is src/retro-digest.ts loopLines: the Loop health section, one line per metric it can compute.
func loopLines(loop loopRows, archived int) []string {
	m := metricsOf(loop, archived)
	out := []string{"- " + pluralOf(m.newItems, "new item") + ", " + plusOnesOf(m.newPlusOnes) + " since the last digest."}
	if m.untargetedItems > 0 || m.untargetedPlusOnes > 0 {
		out = append(out, "- Untargeted: "+pluralOf(m.untargetedItems, "item")+", "+plusOnesOf(m.untargetedPlusOnes)+".")
	}
	if len(m.targets) > 0 {
		var list []string
		for _, t := range m.targets {
			list = append(list, t.target+" "+strconv.Itoa(t.items)+"/"+strconv.Itoa(t.plusOnes))
		}
		more := ""
		if m.moreTargets > 0 {
			more = ", and " + strconv.Itoa(m.moreTargets) + " more"
		}
		out = append(out, "- Top targets (items/+1s): "+strings.Join(list, ", ")+more+".")
	}
	if len(m.recurrence) > 0 {
		var list []string
		for _, r := range m.recurrence {
			var parts []string
			if r.items > 0 {
				parts = append(parts, pluralOf(r.items, "item"))
			}
			if r.plusOnes > 0 {
				parts = append(parts, plusOnesOf(r.plusOnes))
			}
			p := ""
			if len(parts) > 0 {
				p = " (" + strings.Join(parts, ", ") + ")"
			}
			list = append(list, r.target+" "+strconv.Itoa(r.items+r.plusOnes)+" new"+p+" after "+r.key+" closed")
		}
		more := ""
		if m.moreRecurrence > 0 {
			more = "; and " + strconv.Itoa(m.moreRecurrence) + " more"
		}
		out = append(out, "- Recurrence: "+strings.Join(list, "; ")+more+".")
	}
	if m.perAgent != nil {
		out = append(out, "- "+toFixed1(*m.perAgent)+" items per archived agent ("+strconv.Itoa(m.newItems)+" items, "+pluralOf(archived, "agent")+" archived).")
	}
	if len(m.words) > 0 {
		var list []string
		for _, w := range m.words {
			list = append(list, w.File+" "+signed(w.Delta))
		}
		out = append(out, "- Instruction words: "+signed(m.wordsTotal)+" net ("+strings.Join(list, ", ")+").")
	}
	return out
}

// buildDigest is src/retro-digest.ts buildDigest: the digest as Markdown, or false when there is nothing to send.
func buildDigest(rows digestRows, week string) (string, bool) {
	if len(rows.Items) == 0 && len(rows.Rounds) == 0 && len(rows.Archived) == 0 && len(rows.Live) == 0 &&
		!(rows.Loop != nil && loopHasNews(*rows.Loop, len(rows.Archived))) {
		return "", false
	}
	out := []string{"# Retro digest, " + week, "", "Items filed or +1'd since the last digest that have evidence or a +1, by evidence first, then +1s, grouped by kind and target; the rest are counted at the end.", "", "## Threads"}

	// An item with no evidence and no +1 is only counted (S-1230), so the digest leads with what has backing.
	backed := func(x digestItem) bool {
		return (x.Report != nil && *x.Report) || x.PlusOnes > 0 || (x.Evidence != "" && x.Evidence != "none")
	}
	type group struct {
		label string
		items []digestItem
		total int
	}
	var groups []*group
	at := map[string]*group{}
	var hidden []digestItem
	for _, x := range rows.Items {
		if !backed(x) {
			hidden = append(hidden, x)
			continue
		}
		label := "Kind: " + x.Kind + " · Target: " + x.Target
		g := at[label]
		if g == nil {
			g = &group{label: label}
			at[label] = g
			groups = append(groups, g)
		}
		g.items = append(g.items, x)
		g.total += x.PlusOnes
	}
	cmp := localeCompare()
	best := func(g *group) int {
		n := math.MaxInt
		for _, x := range g.items {
			n = min(n, evidenceRank(x.Evidence))
		}
		return n
	}
	for _, g := range groups {
		sort.SliceStable(g.items, func(i, j int) bool {
			a, b := g.items[i], g.items[j]
			if ra, rb := evidenceRank(a.Evidence), evidenceRank(b.Evidence); ra != rb {
				return ra < rb
			}
			if a.PlusOnes != b.PlusOnes {
				return a.PlusOnes > b.PlusOnes
			}
			return cmp(a.Key, b.Key) < 0
		})
	}
	sort.SliceStable(groups, func(i, j int) bool {
		a, b := groups[i], groups[j]
		if ba, bb := best(a), best(b); ba != bb {
			return ba < bb
		}
		if a.total != b.total {
			return a.total > b.total
		}
		if len(a.items) != len(b.items) {
			return len(a.items) > len(b.items)
		}
		return cmp(a.label, b.label) < 0
	})
	if len(groups) == 0 {
		out = append(out, "None.")
	}
	for _, g := range groups {
		var keys []string
		for _, x := range g.items[:min(len(g.items), digestMaxKeys)] {
			keys = append(keys, x.Key+" ("+plusOnesOf(x.PlusOnes)+")")
		}
		more := ""
		if len(g.items) > digestMaxKeys {
			more = ", and " + strconv.Itoa(len(g.items)-digestMaxKeys) + " more"
		}
		out = append(out, "- **"+g.label+"**: "+pluralOf(len(g.items), "item")+", "+plusOnesOf(g.total)+". "+strings.Join(keys, ", ")+more)
	}
	if len(hidden) > 0 {
		type kindCount struct {
			kind string
			n    int
		}
		var kinds []kindCount
		ki := map[string]int{}
		for _, x := range hidden {
			i, ok := ki[x.Kind]
			if !ok {
				i = len(kinds)
				ki[x.Kind] = i
				kinds = append(kinds, kindCount{kind: x.Kind})
			}
			kinds[i].n++
		}
		sort.SliceStable(kinds, func(i, j int) bool {
			if kinds[i].n != kinds[j].n {
				return kinds[i].n > kinds[j].n
			}
			return cmp(kinds[i].kind, kinds[j].kind) < 0
		})
		var by []string
		for _, k := range kinds {
			by = append(by, k.kind+" "+strconv.Itoa(k.n))
		}
		out = append(out, "- "+pluralOf(len(hidden), "more item")+" without evidence or +1s: "+strings.Join(by, ", ")+".")
	}

	out = append(out, "", "## Effort", "")
	if len(rows.Rounds) == 0 && len(rows.Live) == 0 {
		out = append(out, "No final rounds.")
	} else {
		out = append(out, "| Model · type | Rounds | "+strings.Join(effortKeys, " | ")+" |", "|"+strings.Repeat("---|", len(effortKeys)+2))
		for _, g := range roundRuns(rows.Rounds) {
			cells := make([]string, len(effortKeys))
			for i, k := range effortKeys {
				cells[i] = effortCell(g.rows, k)
			}
			out = append(out, "| "+g.label+" | "+strconv.Itoa(len(g.rows))+" | "+strings.Join(cells, " | ")+" |")
		}
		for _, g := range runsOf(rows.Live, func(l digestLive) (*string, *string) { return l.Model, l.Type }) {
			ms := make([]map[string]float64, len(g.rows))
			for i, l := range g.rows {
				ms[i] = l.Measured
			}
			cells := make([]string, len(effortKeys))
			for i, k := range effortKeys {
				cells[i] = "– (measured " + jsNumText(jsRound(meanOf(ms, k))) + "%)"
			}
			out = append(out, "| "+g.label+" (live, not archived) | "+strconv.Itoa(len(g.rows))+" live | "+strings.Join(cells, " | ")+" |")
		}
		if gap := largestGap(rows.Rounds); gap != nil {
			sign := ""
			if gap.diff > 0 {
				sign = "+"
			}
			out = append(out, "", "Largest self-report gap: "+gap.key+" in "+gap.label+", "+jsNumText(gap.self)+"% self-reported vs "+jsNumText(gap.measured)+"% measured ("+sign+jsNumText(gap.diff)+" points).")
		}
	}

	out = append(out, "", "## Coverage", "")
	if len(rows.Archived) == 0 {
		out = append(out, "No agents archived.")
	} else {
		var without []string
		for _, a := range rows.Archived {
			if a.HasRound {
				continue
			}
			if a.Reason != nil && *a.Reason != "" {
				without = append(without, a.Name+": "+*a.Reason)
			} else {
				without = append(without, a.Name)
			}
		}
		named := strings.Join(without[:min(len(without), digestMaxWithout)], ", ")
		if len(without) > digestMaxWithout {
			named += ", and " + strconv.Itoa(len(without)-digestMaxWithout) + " more"
		}
		list := ""
		if len(without) > 0 {
			list = " (" + named + ")"
		}
		out = append(out, pluralOf(len(rows.Archived), "agent")+" archived: "+strconv.Itoa(len(rows.Archived)-len(without))+" with a final round, "+strconv.Itoa(len(without))+" without"+list+".")
	}

	if rows.Loop != nil {
		out = append(out, "", "## Loop health", "")
		out = append(out, loopLines(*rows.Loop, len(rows.Archived))...)
	}

	out = append(out,
		"",
		"## What to do with it",
		"",
		"- Promote a thread that recurs, with several items or +1s, to a work ITSA under the project it is about, so the fix is tracked.",
		"- A retro steward (run by the chief of staff) drafts proposals from this digest; leave instruction edits to it.",
		"- Close the items you handled with `itsa_set` (closed), with a comment saying why.",
		"",
	)
	return strings.Join(out, "\n"), true
}

// retrosEffort is one row of the Retros view's effort split: a model and type, its rounds, and each key's average.
type retrosEffort struct {
	Model    *string      `json:"model"`
	Type     *string      `json:"type"`
	Rounds   int          `json:"rounds"`
	Avg      effortSplit  `json:"avg"`
	Measured *effortSplit `json:"measured"`
}

type retrosCoverage struct {
	Archived  int      `json:"archived"`
	WithRound int      `json:"withRound"`
	Without   []string `json:"without"`
}

// retrosView is src/retro-digest.ts RetrosView.
type retrosView struct {
	Items    []digestItem   `json:"items"`
	Effort   []retrosEffort `json:"effort"`
	Coverage retrosCoverage `json:"coverage"`
}

// buildRetros is src/retro-digest.ts buildRetros: the items ranked by evidence, +1s, then newest; the effort split per
// model and type; and coverage of the archived agents.
func buildRetros(rows digestRows) retrosView {
	cmp := localeCompare()
	items := append([]digestItem{}, rows.Items...)
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if ra, rb := evidenceRank(a.Evidence), evidenceRank(b.Evidence); ra != rb {
			return ra < rb
		}
		if a.PlusOnes != b.PlusOnes {
			return a.PlusOnes > b.PlusOnes
		}
		if c := cmp(b.CreatedAt, a.CreatedAt); c != 0 {
			return c < 0
		}
		return cmp(a.Key, b.Key) < 0
	})
	var runs [][]digestRound
	at := map[[2]string]int{}
	for _, r := range rows.Rounds {
		// JSON.stringify([model, type]): null and a string never collide.
		k := [2]string{"\x00", "\x00"}
		if r.Model != nil {
			k[0] = "s" + *r.Model
		}
		if r.Type != nil {
			k[1] = "s" + *r.Type
		}
		i, ok := at[k]
		if !ok {
			i = len(runs)
			at[k] = i
			runs = append(runs, nil)
		}
		runs[i] = append(runs[i], r)
	}
	effort := []retrosEffort{}
	for _, rs := range runs {
		e := retrosEffort{Model: rs[0].Model, Type: rs[0].Type, Rounds: len(rs)}
		for _, k := range effortKeys {
			*e.Avg.at(k) = jsRound(meanOf(efforts(rs), k))
		}
		if ms := measureds(rs); len(ms) > 0 {
			e.Measured = &effortSplit{}
			for _, k := range effortKeys {
				*e.Measured.at(k) = jsRound(meanOf(ms, k))
			}
		}
		effort = append(effort, e)
	}
	sort.SliceStable(effort, func(i, j int) bool {
		return cmp(orText(effort[i].Model, "")+" "+orText(effort[i].Type, ""), orText(effort[j].Model, "")+" "+orText(effort[j].Type, "")) < 0
	})
	without := []string{}
	for _, a := range rows.Archived {
		if !a.HasRound {
			without = append(without, a.Name)
		}
	}
	return retrosView{Items: items, Effort: effort, Coverage: retrosCoverage{Archived: len(rows.Archived), WithRound: len(rows.Archived) - len(without), Without: without}}
}
