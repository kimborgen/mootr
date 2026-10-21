// Package process is src/process.ts and src/process-validate.ts (S-869): the visual process designer's files. One process is one
// YAML file under processes/ at the repo root; ParseText checks one file's text, Load reads the folder and resolves the
// cross-file `call` references, Counts gives the live counts the designer draws, and RenderNextSteps the next-step text of an
// agent type's brief.
package process

import (
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"

	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// NodeKinds are the eight node kinds, drawn and explained in docs/processes.md.
var NodeKinds = []string{"start", "end", "agent", "human", "script", "exclusive", "parallel", "wait"}

// BuiltinLaneTypes are lane types that are not registry agent types. Any other type must be one the registry knows.
var BuiltinLaneTypes = []string{"human", "script", "cos"}

var (
	humanAsks    = []string{"approve", "decide", "answer", "review", "test"}
	endStatuses  = []string{"done", "canceled", "wont_do"}
	boundaryOns  = []string{"cost", "timeout", "error"}
	reNodeID     = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
	reMachine    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$`)
	reYamlSuffix = regexp.MustCompile(`(?i)\.ya?ml$`)
)

// NodeIDPattern is the node id rule as JavaScript prints it, for the error text.
const NodeIDPattern = "/^[a-z][a-z0-9_-]*$/"

// Lane is a lane of a process: who acts in it.
type Lane struct {
	Type, Label, Fallback, Machine string
	hasLabel                       bool
}

// Trigger is a start event.
type Trigger struct {
	Source, Label           string
	HasLabel                bool
	Subjects, Types, Actors []string
	Cron                    string
	HasCron                 bool
	Example                 bool
}

// Boundary is an interruption drawn on a task: cost, timeout, or error.
type Boundary struct {
	On, Action   string
	HasAction    bool
	Minutes      float64
	HasMinutes   bool
	Interrupting bool
	HasInterrupt bool
}

// Tell is the text a node adds to other lanes' briefs.
type Tell struct {
	Lanes []string
	Text  string
}

// Node is one step of a process.
type Node struct {
	ID, Kind, Lane string
	Label          string
	HasLabel       bool
	Statuses       []string
	DoneWhen       string
	HasDoneWhen    bool
	Brief          string
	Tell           *Tell
	Ask, Run       string
	Event, Status  string
	Call           string
	HasCall        bool
	HasRun         bool
	HasEvent       bool
	Boundary       []Boundary
	Triggers       []Trigger
}

// Edge joins two nodes.
type Edge struct {
	From, To    string
	When, Label string
	HasWhen     bool
	HasLabel    bool
}

// Def is a valid process file.
type Def struct {
	ID, Title      string
	Description    string
	HasDescription bool
	AppliesToKind  []string
	// Lanes and Nodes keep the file's order (LaneNames, NodeIDs).
	LaneNames []string
	Lanes     map[string]Lane
	NodeIDs   []string
	Nodes     map[string]*Node
	Edges     []Edge
}

// Error is a problem found in a file of the folder.
type Error struct{ File, Message string }

// ParseOptions are what a file is checked against.
type ParseOptions struct {
	File string
	// KnownTypes are the registry's agent types; nil checks no lane type.
	KnownTypes map[string]bool
	// KnownStatuses are the ITSA status names.
	KnownStatuses map[string]bool
}

// FileID is the id a file must declare: its name without the extension.
func FileID(file string) string {
	if i := strings.LastIndex(file, "/"); i >= 0 {
		file = file[i+1:]
	}
	return reYamlSuffix.ReplaceAllString(file, "")
}

// ParseText is src/process-validate.ts parseProcessText: one process file's definition when it is valid, and every problem
// found otherwise, each naming the file.
func ParseText(yamlText string, opts ParseOptions) (*Def, []string) {
	file := opts.File
	var errs []string
	add := func(m string) { errs = append(errs, file+": "+m) }
	doc, msg, valid := parseDocument(yamlText)
	if !valid {
		return nil, []string{file + ": not valid YAML: " + msg}
	}
	var raw *yaml.Node
	if doc.Kind == yaml.DocumentNode && len(doc.Content) > 0 {
		raw = resolve(doc.Content[0])
	}
	if k, dup := dupKey(raw); dup {
		return nil, []string{file + ": not valid YAML: Map keys must be unique; \"" + k + "\" is repeated"}
	}
	if !isMapping(raw) {
		return nil, []string{file + ": the file must be a mapping"}
	}

	id := ""
	if s, ok := str(get(raw, "process")); ok {
		id = jsjson.Trim(s)
	}
	expected := FileID(file)
	if id == "" {
		add("process: missing")
	} else if id != expected {
		add(fmt.Sprintf("process \"%s\" must equal the file name \"%s\"", id, expected))
	}

	def := &Def{Lanes: map[string]Lane{}, Nodes: map[string]*Node{}}
	lanesNode := get(raw, "lanes")
	if !isMapping(lanesNode) {
		add("lanes: missing")
	} else {
		names, vals := entries(lanesNode)
		for _, name := range names {
			l := vals[name]
			if !isMapping(l) {
				add(fmt.Sprintf("lane \"%s\": must be a mapping", name))
				continue
			}
			typ := ""
			if s, ok := str(get(l, "type")); ok {
				typ = jsjson.Trim(s)
			}
			if typ == "" {
				add(fmt.Sprintf("lane \"%s\": missing type", name))
			} else if !contains(BuiltinLaneTypes, typ) && opts.KnownTypes != nil && !opts.KnownTypes[typ] {
				add(fmt.Sprintf("lane \"%s\": unknown agent type \"%s\"", name, typ))
			}
			lane := Lane{Type: typ}
			if s, ok := str(get(l, "label")); ok {
				lane.Label, lane.hasLabel = s, true
			}
			if s, ok := str(get(l, "fallback")); ok {
				fb := jsjson.Trim(s)
				if fb != "" && !contains(BuiltinLaneTypes, fb) && opts.KnownTypes != nil && !opts.KnownTypes[fb] {
					add(fmt.Sprintf("lane \"%s\": unknown agent type \"%s\" in fallback", name, fb))
				}
				if fb != "" {
					lane.Fallback = fb
				}
			}
			if m := get(l, "machine"); m != nil {
				machine := ""
				if s, ok := str(m); ok {
					machine = jsjson.Trim(s)
				}
				if !reMachine.MatchString(machine) {
					add(fmt.Sprintf("lane \"%s\": machine must be a machine name", name))
				} else {
					lane.Machine = machine
				}
			}
			if _, seen := def.Lanes[name]; !seen {
				def.LaneNames = append(def.LaneNames, name)
			}
			def.Lanes[name] = lane
		}
	}

	statusOwner := map[string]string{}
	nodesNode := get(raw, "nodes")
	if !isMapping(nodesNode) {
		add("nodes: missing")
	} else {
		ids, vals := entries(nodesNode)
		for _, nodeID := range ids {
			if !reNodeID.MatchString(nodeID) {
				add(fmt.Sprintf("node \"%s\": the id must match %s", nodeID, NodeIDPattern))
			}
			n := vals[nodeID]
			if !isMapping(n) {
				add(fmt.Sprintf("node \"%s\": must be a mapping", nodeID))
				continue
			}
			if node := normalizeNode(nodeID, n, def.Lanes, opts.KnownStatuses, statusOwner, add); node != nil {
				def.NodeIDs = append(def.NodeIDs, nodeID)
				def.Nodes[nodeID] = node
			}
		}
	}

	edgesNode := resolve(get(raw, "edges"))
	if !isSequence(edgesNode) {
		add("edges: missing")
	} else {
		for i, e := range edgesNode.Content {
			e = resolve(e)
			var from, to string
			okFrom, okTo := false, false
			if e.Kind == yaml.SequenceNode && len(e.Content) >= 2 {
				from, okFrom = str(e.Content[0])
				to, okTo = str(e.Content[1])
			}
			if e.Kind != yaml.SequenceNode || len(e.Content) < 2 || len(e.Content) > 3 || !okFrom || !okTo {
				add(fmt.Sprintf("edge %d: must be [from, to] or [from, to, options]", i+1))
				continue
			}
			if def.Nodes[from] == nil {
				add(fmt.Sprintf("edge %s -> %s: unknown node \"%s\"", from, to, from))
			}
			if def.Nodes[to] == nil {
				add(fmt.Sprintf("edge %s -> %s: unknown node \"%s\"", from, to, to))
			}
			edge := Edge{From: from, To: to}
			if len(e.Content) == 3 {
				if !isMapping(e.Content[2]) {
					add(fmt.Sprintf("edge %s -> %s: options must be a mapping", from, to))
				} else {
					if s, ok := str(get(e.Content[2], "when")); ok {
						edge.When, edge.HasWhen = s, true
					}
					if s, ok := str(get(e.Content[2], "label")); ok {
						edge.Label, edge.HasLabel = s, true
					}
				}
			}
			def.Edges = append(def.Edges, edge)
		}
	}

	incoming, outgoing := map[string]bool{}, map[string]bool{}
	for _, e := range def.Edges {
		incoming[e.To], outgoing[e.From] = true, true
	}
	for _, nodeID := range def.NodeIDs {
		n := def.Nodes[nodeID]
		if n.Kind == "start" && incoming[n.ID] {
			add(fmt.Sprintf("start node \"%s\" has an incoming edge", n.ID))
		}
		if n.Kind == "end" && outgoing[n.ID] {
			add(fmt.Sprintf("end node \"%s\" has an outgoing edge", n.ID))
		}
	}

	def.ID = id
	if s, ok := str(get(raw, "title")); ok {
		def.Title = s
	}
	if s, ok := str(get(raw, "description")); ok {
		def.Description, def.HasDescription = s, true
	}
	if a := get(raw, "applies_to"); isMapping(a) {
		if kind := stringsOf(get(a, "kind")); len(kind) > 0 {
			def.AppliesToKind = kind
		}
	}
	if len(errs) > 0 {
		return nil, errs
	}
	return def, nil
}

func normalizeNode(id string, n *yaml.Node, lanes map[string]Lane, knownStatuses map[string]bool, statusOwner map[string]string, bad func(string)) *Node {
	kind := jsjson.Trim(jsString(get(n, "kind")))
	if !contains(NodeKinds, kind) {
		bad(fmt.Sprintf("node \"%s\": unknown kind \"%s\"", id, kind))
		return nil
	}
	node := &Node{ID: id, Kind: kind, Statuses: []string{}, Boundary: []Boundary{}, Triggers: []Trigger{}}
	if s, ok := str(get(n, "lane")); ok && jsjson.Trim(s) != "" {
		node.Lane = jsjson.Trim(s)
	} else {
		bad(fmt.Sprintf("node \"%s\": missing lane", id))
	}
	if _, ok := lanes[node.Lane]; node.Lane != "" && !ok {
		bad(fmt.Sprintf("node \"%s\": unknown lane \"%s\"", id, node.Lane))
	}
	if s, ok := str(get(n, "label")); ok {
		node.Label, node.HasLabel = s, true
	}
	for _, status := range stringsOf(get(n, "statuses")) {
		if !knownStatuses[status] {
			bad(fmt.Sprintf("node \"%s\": unknown ITSA status \"%s\"", id, status))
		} else if owner, taken := statusOwner[status]; taken {
			bad(fmt.Sprintf("status \"%s\" is mapped on more than one node (\"%s\" and \"%s\")", status, owner, id))
		} else {
			statusOwner[status] = id
		}
		node.Statuses = append(node.Statuses, status)
	}
	if s, ok := str(get(n, "done_when")); ok {
		node.DoneWhen, node.HasDoneWhen = s, true
	}
	if s, ok := str(get(n, "brief")); ok && jsjson.Trim(s) != "" {
		node.Brief = jsjson.Trim(s)
	}
	if t := get(n, "tell"); t != nil {
		var told []string
		text, textOK := "", false
		if isMapping(t) {
			told = stringsOf(get(t, "lanes"))
			text, textOK = str(get(t, "text"))
		}
		if !isMapping(t) || !textOK || jsjson.Trim(text) == "" || len(told) == 0 {
			bad(fmt.Sprintf("node \"%s\": tell needs lanes and text", id))
		} else {
			for _, l := range told {
				if _, ok := lanes[l]; !ok {
					bad(fmt.Sprintf("node \"%s\": tell names unknown lane \"%s\"", id, l))
				}
			}
			node.Tell = &Tell{Lanes: told, Text: jsjson.Trim(text)}
		}
	}
	if s, ok := str(get(n, "call")); ok {
		node.Call, node.HasCall = s, true
	}
	if s, ok := str(get(n, "run")); ok {
		node.Run, node.HasRun = s, true
	}
	if s, ok := str(get(n, "event")); ok {
		node.Event, node.HasEvent = s, true
	}
	if kindRaw, _ := str(get(n, "kind")); kindRaw == "end" {
		if s, ok := str(get(n, "status")); !ok || !contains(endStatuses, s) {
			bad(fmt.Sprintf("end node \"%s\": status must be %s", id, strings.Join(endStatuses, ", ")))
		} else {
			node.Status = s
		}
	}
	if kindRaw, _ := str(get(n, "kind")); kindRaw == "human" {
		if s, ok := str(get(n, "ask")); !ok || !contains(humanAsks, s) {
			bad(fmt.Sprintf("human node \"%s\": ask must be %s", id, strings.Join(humanAsks, ", ")))
		} else {
			node.Ask = s
		}
	}
	if trig := resolve(get(n, "triggers")); trig != nil && trig.Kind == yaml.SequenceNode {
		for i, t := range trig.Content {
			src, ok := str(get(t, "source"))
			if !isMapping(t) || !ok || jsjson.Trim(src) == "" {
				bad(fmt.Sprintf("node \"%s\": trigger %d has no source", id, i+1))
				continue
			}
			trigger := Trigger{Source: jsjson.Trim(src)}
			if s, ok := str(get(t, "label")); ok {
				trigger.Label, trigger.HasLabel = s, true
			}
			if v := stringsOf(get(t, "subjects")); len(v) > 0 {
				trigger.Subjects = v
			}
			if v := stringsOf(get(t, "types")); len(v) > 0 {
				trigger.Types = v
			}
			if v := stringsOf(get(t, "actors")); len(v) > 0 {
				trigger.Actors = v
			}
			if s, ok := str(get(t, "cron")); ok {
				trigger.Cron, trigger.HasCron = s, true
			}
			if b, ok := boolean(get(t, "example")); ok && b {
				trigger.Example = true
			}
			if trigger.Source == "timer" && (!trigger.HasCron || trigger.Cron == "") {
				bad(fmt.Sprintf("node \"%s\": a timer trigger needs a cron", id))
			}
			node.Triggers = append(node.Triggers, trigger)
		}
	}
	if kind == "start" && len(node.Triggers) == 0 {
		bad(fmt.Sprintf("start node \"%s\" needs at least one trigger", id))
	}
	if bs := resolve(get(n, "boundary")); bs != nil && bs.Kind == yaml.SequenceNode {
		for _, b := range bs.Content {
			on, ok := str(get(b, "on"))
			if !isMapping(b) || !ok || !contains(boundaryOns, on) {
				bad(fmt.Sprintf("node \"%s\": a boundary event needs on: %s", id, strings.Join(boundaryOns, ", ")))
				continue
			}
			boundary := Boundary{On: on}
			if s, ok := str(get(b, "action")); ok {
				boundary.Action, boundary.HasAction = s, true
			}
			if f, ok := number(get(b, "minutes")); ok {
				boundary.Minutes, boundary.HasMinutes = f, true
			}
			if v, ok := boolean(get(b, "interrupting")); ok {
				boundary.Interrupting, boundary.HasInterrupt = v, true
			}
			node.Boundary = append(node.Boundary, boundary)
		}
	}
	return node
}

// --- the definition as the API shows it ---

func strs(list []string) jsfmt.Value {
	items := make([]jsfmt.Value, len(list))
	for i, s := range list {
		items[i] = jsfmt.StringValue(s)
	}
	return jsfmt.ArrayValue(items)
}

func put(v *jsfmt.Value, key string, val jsfmt.Value) { v.Set(key, val) }

// Value is the process as JSON.stringify prints the ProcessDef of src/process-validate.ts, key order and all.
func (d *Def) Value() jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	put(&out, "id", jsfmt.StringValue(d.ID))
	put(&out, "title", jsfmt.StringValue(d.Title))
	lanes := jsfmt.Value{Kind: jsfmt.Object}
	for _, name := range d.LaneNames {
		l := d.Lanes[name]
		lv := jsfmt.Value{Kind: jsfmt.Object}
		put(&lv, "type", jsfmt.StringValue(l.Type))
		if l.hasLabel {
			put(&lv, "label", jsfmt.StringValue(l.Label))
		}
		if l.Fallback != "" {
			put(&lv, "fallback", jsfmt.StringValue(l.Fallback))
		}
		if l.Machine != "" {
			put(&lv, "machine", jsfmt.StringValue(l.Machine))
		}
		put(&lanes, name, lv)
	}
	put(&out, "lanes", lanes)
	nodes := jsfmt.Value{Kind: jsfmt.Object}
	for _, id := range d.NodeIDs {
		put(&nodes, id, d.Nodes[id].value())
	}
	put(&out, "nodes", nodes)
	edges := make([]jsfmt.Value, len(d.Edges))
	for i, e := range d.Edges {
		ev := jsfmt.Value{Kind: jsfmt.Object}
		put(&ev, "from", jsfmt.StringValue(e.From))
		put(&ev, "to", jsfmt.StringValue(e.To))
		if e.HasWhen {
			put(&ev, "when", jsfmt.StringValue(e.When))
		}
		if e.HasLabel {
			put(&ev, "label", jsfmt.StringValue(e.Label))
		}
		edges[i] = ev
	}
	put(&out, "edges", jsfmt.ArrayValue(edges))
	if d.HasDescription {
		put(&out, "description", jsfmt.StringValue(d.Description))
	}
	if len(d.AppliesToKind) > 0 {
		a := jsfmt.Value{Kind: jsfmt.Object}
		put(&a, "kind", strs(d.AppliesToKind))
		put(&out, "appliesTo", a)
	}
	return out
}

func (n *Node) value() jsfmt.Value {
	out := jsfmt.Value{Kind: jsfmt.Object}
	put(&out, "id", jsfmt.StringValue(n.ID))
	put(&out, "kind", jsfmt.StringValue(n.Kind))
	put(&out, "lane", jsfmt.StringValue(n.Lane))
	put(&out, "statuses", strs(n.Statuses))
	bs := make([]jsfmt.Value, len(n.Boundary))
	for i, b := range n.Boundary {
		bv := jsfmt.Value{Kind: jsfmt.Object}
		put(&bv, "on", jsfmt.StringValue(b.On))
		if b.HasAction {
			put(&bv, "action", jsfmt.StringValue(b.Action))
		}
		if b.HasMinutes {
			put(&bv, "minutes", jsfmt.Value{Kind: jsfmt.Number, Num: jsjson.Number(b.Minutes)})
		}
		if b.HasInterrupt {
			put(&bv, "interrupting", jsfmt.Value{Kind: jsfmt.Bool, Bool: b.Interrupting})
		}
		bs[i] = bv
	}
	put(&out, "boundary", jsfmt.ArrayValue(bs))
	ts := make([]jsfmt.Value, len(n.Triggers))
	for i, t := range n.Triggers {
		tv := jsfmt.Value{Kind: jsfmt.Object}
		put(&tv, "source", jsfmt.StringValue(t.Source))
		if t.HasLabel {
			put(&tv, "label", jsfmt.StringValue(t.Label))
		}
		if t.Subjects != nil {
			put(&tv, "subjects", strs(t.Subjects))
		}
		if t.Types != nil {
			put(&tv, "types", strs(t.Types))
		}
		if t.Actors != nil {
			put(&tv, "actors", strs(t.Actors))
		}
		if t.HasCron {
			put(&tv, "cron", jsfmt.StringValue(t.Cron))
		}
		if t.Example {
			put(&tv, "example", jsfmt.Value{Kind: jsfmt.Bool, Bool: true})
		}
		ts[i] = tv
	}
	put(&out, "triggers", jsfmt.ArrayValue(ts))
	if n.HasLabel {
		put(&out, "label", jsfmt.StringValue(n.Label))
	}
	if n.HasDoneWhen {
		put(&out, "doneWhen", jsfmt.StringValue(n.DoneWhen))
	}
	if n.Brief != "" {
		put(&out, "brief", jsfmt.StringValue(n.Brief))
	}
	if n.Tell != nil {
		t := jsfmt.Value{Kind: jsfmt.Object}
		put(&t, "lanes", strs(n.Tell.Lanes))
		put(&t, "text", jsfmt.StringValue(n.Tell.Text))
		put(&out, "tell", t)
	}
	if n.HasCall {
		put(&out, "call", jsfmt.StringValue(n.Call))
	}
	if n.HasRun {
		put(&out, "run", jsfmt.StringValue(n.Run))
	}
	if n.HasEvent {
		put(&out, "event", jsfmt.StringValue(n.Event))
	}
	if n.Status != "" {
		put(&out, "status", jsfmt.StringValue(n.Status))
	}
	if n.Ask != "" {
		put(&out, "ask", jsfmt.StringValue(n.Ask))
	}
	return out
}

// ValidID is src/process.ts NODE_ID: a process or node id.
func ValidID(s string) bool { return reNodeID.MatchString(s) }
