package process

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"stam/internal/jsfmt"
)

// Parse is src/process.ts parseProcess: one file's text against the registry's agent types and the ITSA statuses.
func Parse(yamlText, file string, knownTypes map[string]bool, knownStatuses map[string]bool) (*Def, []string) {
	return ParseText(yamlText, ParseOptions{File: file, KnownTypes: knownTypes, KnownStatuses: knownStatuses})
}

// Loaded is every valid process of a folder and every problem found in it.
type Loaded struct {
	Processes []*Def
	Errors    []Error
}

// Load is src/process.ts loadProcesses: every `*.yaml` in a folder, in file order, with each file's own errors and the
// cross-file ones: a `call` that names no other loaded process. A folder that can't be read is an error; a file that can't be
// parsed is a problem in Errors, not a failure.
func Load(dir string, knownTypes map[string]bool, knownStatuses map[string]bool) (Loaded, error) {
	files, err := yamlFiles(dir)
	if err != nil {
		return Loaded{}, err
	}
	var out Loaded
	fileOf := map[string]string{}
	for _, f := range files {
		text, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			return Loaded{}, err
		}
		def, errs := Parse(string(text), dir+"/"+f, knownTypes, knownStatuses)
		for _, m := range errs {
			out.Errors = append(out.Errors, Error{File: f, Message: m})
		}
		if def != nil {
			out.Processes = append(out.Processes, def)
			fileOf[def.ID] = f
		}
	}
	ids := map[string]bool{}
	for _, p := range out.Processes {
		ids[p.ID] = true
	}
	for _, p := range out.Processes {
		for _, id := range p.NodeIDs {
			n := p.Nodes[id]
			if n.HasCall && n.Call != "" && !ids[n.Call] {
				file := fileOf[p.ID]
				if file == "" {
					file = p.ID
				}
				out.Errors = append(out.Errors, Error{File: file, Message: "node \"" + n.ID + "\": call \"" + n.Call + "\" is not a loaded process"})
			}
		}
	}
	return out, nil
}

// yamlFiles are the folder's `*.yaml` names, sorted.
func yamlFiles(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".yaml") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	return files, nil
}

// Files are the process files of a folder with their size and modification time, to tell when a parse is stale.
func Files(dir string) ([]string, error) {
	files, err := yamlFiles(dir)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(files))
	for i, f := range files {
		st, err := os.Stat(filepath.Join(dir, f))
		if err != nil {
			return nil, err
		}
		out[i] = f + ":" + st.ModTime().UTC().Format("20060102T150405.000000000") + ":" + jsfmtInt(st.Size())
	}
	return out, nil
}

func jsfmtInt(n int64) string { return jsfmt.IntValue(n).Num }

// CountItsa is one ITSA as the live counts need it.
type CountItsa struct {
	Key, ID, Title, Status string
	// Owner is the owner's name, "" for none.
	Owner string
	Kind  *string
	// Stage is the ITSA's `stage` field when set.
	Stage *string
}

// NodeCount is what sits at one node: the full number, and up to CountsCap of them, drawn.
type NodeCount struct {
	Count int
	Itsas []CountItsa
}

// CountsCap is the most ITSAs one node lists; Count stays the full number.
const CountsCap = 50

// Stageable is whether an ITSA's `stage` can name the node: every node but the events that start a flow and the gateways
// that only route it.
func Stageable(n *Node) bool {
	return n.Kind != "start" && n.Kind != "exclusive" && n.Kind != "parallel"
}

// Counts is src/process.ts processCounts: per process id, every node that names `statuses` (or that a stage names) has an
// entry (0 is a real answer), holding the open ITSAs whose status is one of them, or whose stage names the node. A process's
// `applies_to.kind`, when set, limits which ITSAs count in it. isClosed says whether a status is in the closed category.
func Counts(processes []*Def, itsas []CountItsa, isClosed func(status string) bool) map[string]map[string]NodeCount {
	all := map[string]map[string]NodeCount{}
	var open []CountItsa
	for _, x := range itsas {
		if !isClosed(x.Status) {
			open = append(open, x)
		}
	}
	for _, p := range processes {
		forProcess := open
		if len(p.AppliesToKind) > 0 {
			forProcess = nil
			for _, x := range open {
				if x.Kind != nil && contains(p.AppliesToKind, *x.Kind) {
					forProcess = append(forProcess, x)
				}
			}
		}
		byNode := map[string][]CountItsa{}
		byStatus := map[string][]CountItsa{}
		for _, x := range forProcess {
			if x.Stage != nil && *x.Stage != "" && p.Nodes[*x.Stage] != nil && Stageable(p.Nodes[*x.Stage]) {
				byNode[*x.Stage] = append(byNode[*x.Stage], x)
			} else {
				byStatus[x.Status] = append(byStatus[x.Status], x)
			}
		}
		nodes := map[string]NodeCount{}
		for _, id := range p.NodeIDs {
			node := p.Nodes[id]
			if len(node.Statuses) == 0 && len(byNode[id]) == 0 {
				continue
			}
			at := append([]CountItsa(nil), byNode[id]...)
			for _, status := range node.Statuses {
				at = append(at, byStatus[status]...)
			}
			shown := at
			if len(shown) > CountsCap {
				shown = shown[:CountsCap]
			}
			nodes[id] = NodeCount{Count: len(at), Itsas: shown}
		}
		all[p.ID] = nodes
	}
	return all
}

// CountsValue is one process's counts as JSON, the nodes in the process's order.
func CountsValue(p *Def, counts map[string]NodeCount) jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	for _, id := range p.NodeIDs {
		c, ok := counts[id]
		if !ok {
			continue
		}
		items := make([]jsfmt.Value, len(c.Itsas))
		for i, x := range c.Itsas {
			v := jsfmt.Value{Kind: jsfmt.Object}
			v.Set("key", jsfmt.StringValue(x.Key))
			v.Set("id", jsfmt.StringValue(x.ID))
			v.Set("title", jsfmt.StringValue(x.Title))
			v.Set("status", jsfmt.StringValue(x.Status))
			if x.Owner == "" {
				v.Set("owner", jsfmt.NullValue())
			} else {
				v.Set("owner", jsfmt.StringValue(x.Owner))
			}
			items[i] = v
		}
		n := jsfmt.Value{Kind: jsfmt.Object}
		n.Set("count", jsfmt.IntValue(int64(c.Count)))
		n.Set("itsas", jsfmt.ArrayValue(items))
		out.Set(id, n)
	}
	return out
}

// laneOfType is the lane of a process an agent type acts in: the lane of that type, or whose fallback it is.
func laneOfType(p *Def, typ string) (string, bool) {
	for _, name := range p.LaneNames {
		if p.Lanes[name].Type == typ {
			return name, true
		}
	}
	for _, name := range p.LaneNames {
		if p.Lanes[name].Fallback == typ {
			return name, true
		}
	}
	return "", false
}

// RenderNextSteps is src/process.ts renderNextSteps, the {{next_steps}} of a type's brief: in node order, the `brief` of every
// node in the type's lane and the `tell` text of every node that names the lane, joined by blank lines; "" when the process
// has no lane for the type or no step text for it.
func RenderNextSteps(p *Def, typ string) string {
	lane, ok := laneOfType(p, typ)
	if !ok {
		return ""
	}
	var parts []string
	for _, id := range p.NodeIDs {
		n := p.Nodes[id]
		if n.Lane == lane && n.Brief != "" {
			parts = append(parts, n.Brief)
		}
		if n.Tell != nil && contains(n.Tell.Lanes, lane) {
			parts = append(parts, n.Tell.Text)
		}
	}
	return strings.Join(parts, "\n\n")
}

// StageRefusal is src/process.ts stageRefusal: why a `stage` move is refused, or "" when it is allowed. Setting it from empty,
// clearing it, and keeping the same value always pass; a value the process has no node for passes too. A move back to a node
// that comes earlier (one that reaches `from` along the edges) passes too. Otherwise `to` must follow `from` along the edges,
// through gateways only.
func StageRefusal(p *Def, from, to string) string {
	if from == "" || to == "" || from == to {
		return ""
	}
	if p.Nodes[from] == nil || p.Nodes[to] == nil {
		return ""
	}
	reaches := func(a, b string) bool {
		visited := map[string]bool{a: true}
		stack := []string{a}
		for len(stack) > 0 {
			id := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			for _, e := range p.Edges {
				if e.From == id && !visited[e.To] {
					visited[e.To] = true
					stack = append(stack, e.To)
				}
			}
		}
		return visited[b]
	}
	if reaches(to, from) {
		return ""
	}
	seen := map[string]bool{}
	queue := []string{from}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		for _, e := range p.Edges {
			if e.From != id {
				continue
			}
			if e.To == to {
				return ""
			}
			if next := p.Nodes[e.To]; next != nil && !Stageable(next) && !seen[next.ID] {
				seen[next.ID] = true
				queue = append(queue, next.ID)
			}
		}
	}
	var allowed []string
	have := map[string]bool{}
	for _, e := range p.Edges {
		if e.From == from && !have[e.To] {
			have[e.To] = true
			allowed = append(allowed, e.To)
		}
	}
	list := strings.Join(allowed, ", ")
	if list == "" {
		list = "none"
	}
	return p.ID + " does not allow stage " + from + " -> " + to + " (from " + from + ": " + list + ")"
}

// CloseNodeOf is the node a closed ITSA of the process ends at: its `end` node that closes the ITSA, or "".
func CloseNodeOf(p *Def, isClosed func(status string) bool) string {
	for _, id := range p.NodeIDs {
		n := p.Nodes[id]
		if n.Kind == "end" && n.Status != "" && isClosed(n.Status) {
			return n.ID
		}
	}
	return ""
}
