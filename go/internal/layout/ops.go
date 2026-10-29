// Package layout is the human's layout: worlds, panes and tabs (src/layout-ops.ts), and the daemon's one copy of it
// in STAM_HOME/layout.json (src/layout.ts).
//
// A layout is parsed JSON (jsjson) rather than Go structs, so a pane tree the web sends keeps every key it has, in its
// order, as the TS daemon's JSON copies do. The ops read and write it as src/layout-ops.ts does, JavaScript's
// truthiness and strict equality included; an op that would throw a TypeError there is an error here too.
package layout

import (
	"fmt"
	"math"
	"regexp"
	"runtime"
	"strings"

	"stam/internal/jsjson"
)

// Home is the home world's id (src/layout-ops.ts HOME).
const Home = "_home"

// NewID makes a pane or split id.
type NewID func() string

// opError is an op's refusal, thrown inside apply and returned by Apply, as src/layout-ops.ts throws an Error.
type opError struct{ msg string }

func fail(format string, args ...any) { panic(opError{fmt.Sprintf(format, args...)}) }

// typeError stands for a TypeError TS would throw on a tree or op of the wrong shape.
func typeError(what string) { fail("not a layout op this layout can take: %s", what) }

// EmptyLayout is src/layout-ops.ts emptyLayout.
func EmptyLayout() *jsjson.Object {
	return jsjson.NewObject("version", float64(0), "current", nil, "agentWorlds", jsjson.NewObject(), "worlds", jsjson.NewObject())
}

// IsEmpty is src/layout-ops.ts isEmptyLayout.
func IsEmpty(l *jsjson.Object) bool {
	cur, _ := l.Get("current")
	return cur == nil && objOf(get(l, "agentWorlds")).Len() == 0 && objOf(get(l, "worlds")).Len() == 0
}

// DefaultWorld is src/layout-ops.ts defaultWorld: one pane with the world's own view, its id fixed.
func DefaultWorld(id string) *jsjson.Object {
	var tabs []jsjson.Value
	switch {
	case id == Home:
		tabs = []jsjson.Value{}
	case strings.HasPrefix(id, "w:itsa:"):
		tabs = []jsjson.Value{"itsa:" + id[7:], "board:" + id[7:]}
	case strings.HasPrefix(id, "t:"):
		tabs = []jsjson.Value{"thread:" + id[2:]}
	case strings.HasPrefix(id, "w:"):
		tabs = []jsjson.Value{id[2:]}
	default:
		tabs = []jsjson.Value{"agent:" + id}
	}
	var active jsjson.Value
	if len(tabs) > 0 {
		active = tabs[0]
	}
	root := jsjson.NewObject("id", "p_0", "tabs", tabs, "active", active)
	return jsjson.NewObject("root", root, "focused", "p_0")
}

// validNode is src/layout-ops.ts validNode: a pane has an id, string tabs and an active tab or null; a split has an id,
// a direction, children, and one positive, finite size per child.
func validNode(v jsjson.Value) bool {
	n, ok := v.(*jsjson.Object)
	if !ok {
		return false
	}
	split, isSplit := n.Get("split")
	if !isSplit {
		tabs, ok := get(n, "tabs").([]jsjson.Value)
		if !isString(get(n, "id")) || !ok {
			return false
		}
		for _, t := range tabs {
			if !isString(t) {
				return false
			}
		}
		active, has := n.Get("active")
		return has && (active == nil || isString(active))
	}
	if split != "row" && split != "col" || !isString(get(n, "id")) {
		return false
	}
	children, ok := get(n, "children").([]jsjson.Value)
	if !ok || len(children) == 0 {
		return false
	}
	sizes, ok := get(n, "sizes").([]jsjson.Value)
	if !ok || len(sizes) != len(children) {
		return false
	}
	for _, x := range sizes {
		f, ok := x.(float64)
		if !ok || math.IsInf(f, 0) || math.IsNaN(f) || f <= 0 {
			return false
		}
	}
	for _, c := range children {
		if !validNode(c) {
			return false
		}
	}
	return true
}

func validWorld(v jsjson.Value) bool {
	w, ok := v.(*jsjson.Object)
	if !ok || !validNode(get(w, "root")) || !isString(get(w, "focused")) {
		return false
	}
	saved, has := w.Get("saved")
	return !has || validNode(saved)
}

// Valid is src/layout-ops.ts validLayout: the Layout shape, with every tree in it well formed.
func Valid(v jsjson.Value) bool {
	l, ok := v.(*jsjson.Object)
	if !ok {
		return false
	}
	version, ok := get(l, "version").(float64)
	if !ok || version != math.Trunc(version) || math.IsInf(version, 0) || version < 0 {
		return false
	}
	cur, has := l.Get("current")
	if !has || cur != nil && !isString(cur) {
		return false
	}
	for _, k := range []string{"agentWorlds", "worlds"} {
		m, ok := get(l, k).(*jsjson.Object)
		if !ok {
			return false
		}
		for _, id := range m.Keys() {
			if !validWorld(get(m, id)) {
				return false
			}
		}
	}
	return true
}

// leaves is src/layout-ops.ts leaves: the panes of a tree, left to right.
func leaves(v jsjson.Value) []*jsjson.Object {
	n, ok := v.(*jsjson.Object)
	if !ok {
		typeError("a pane tree holds something that isn't a pane or a split")
	}
	if !truthy(get(n, "split")) {
		return []*jsjson.Object{n}
	}
	children, ok := get(n, "children").([]jsjson.Value)
	if !ok {
		typeError("a split's children aren't a list")
	}
	var out []*jsjson.Object
	for _, c := range children {
		out = append(out, leaves(c)...)
	}
	return out
}

// DeadImageTabOps is src/layout-ops.ts deadImageTabOps: the image:PAGE.N tabs whose page isn't live, as close ops.
func DeadImageTabOps(l *jsjson.Object, live func(page string) bool) []*jsjson.Object {
	var ops []*jsjson.Object
	dead := func(world string, w jsjson.Value) {
		for _, leaf := range leaves(get(objOf(w), "root")) {
			for _, t := range tabsOf(leaf) {
				key, ok := t.(string)
				if ok && strings.HasPrefix(key, "image:") && !live(strings.SplitN(key[len("image:"):], ".", 2)[0]) {
					ops = append(ops, jsjson.NewObject("op", "close", "world", world, "key", key))
				}
			}
		}
	}
	for _, k := range []string{"worlds", "agentWorlds"} {
		m := objOf(get(l, k))
		for _, id := range m.Keys() {
			dead(id, get(m, id))
		}
	}
	return ops
}

// parentOf is the split that holds node, and node's index in it; nil when node is the root.
func parentOf(root jsjson.Value, node *jsjson.Object) (*jsjson.Object, int) {
	r, ok := root.(*jsjson.Object)
	if !ok || !truthy(get(r, "split")) {
		return nil, 0
	}
	children, _ := get(r, "children").([]jsjson.Value)
	for i, c := range children {
		if c == jsjson.Value(node) {
			return r, i
		}
		if p, j := parentOf(c, node); p != nil {
			return p, j
		}
	}
	return nil, 0
}

func replace(w, node, with *jsjson.Object) {
	if p, i := parentOf(get(w, "root"), node); p != nil {
		get(p, "children").([]jsjson.Value)[i] = with
	} else {
		w.Set("root", with)
	}
}

// splitBeside puts fresh beside target, on the side side names.
func splitBeside(w, target, fresh *jsjson.Object, side jsjson.Value, newID NewID) {
	dir := "col"
	if side == "right" || side == "left" {
		dir = "row"
	}
	before := side == "left" || side == "up"
	at := 1
	if before {
		at = 0
	}
	if p, i := parentOf(get(w, "root"), target); p != nil && get(p, "split") == dir {
		sizes := arrOf(get(p, "sizes"))
		s := jsjson.ToNumber(at0(sizes, i)) / 2
		if i < len(sizes) {
			sizes[i] = s
		}
		p.Set("children", splice(arrOf(get(p, "children")), i+at, 0, fresh))
		p.Set("sizes", splice(sizes, i+at, 0, s))
		return
	}
	children := []jsjson.Value{target, fresh}
	if before {
		children = []jsjson.Value{fresh, target}
	}
	replace(w, target, jsjson.NewObject("id", newID(), "split", dir, "children", children, "sizes", []jsjson.Value{float64(1), float64(1)}))
}

// removeLeaf removes an empty pane; a split left with one child gives way to it.
func removeLeaf(w, target *jsjson.Object) {
	p, i := parentOf(get(w, "root"), target)
	if p == nil {
		return
	}
	children := splice(arrOf(get(p, "children")), i, 1)
	p.Set("children", children)
	p.Set("sizes", splice(arrOf(get(p, "sizes")), i, 1))
	if len(children) == 1 {
		only, _ := children[0].(*jsjson.Object)
		gp, gi := parentOf(get(w, "root"), p)
		// A child split in the same direction as its new parent merges into it.
		if gp != nil && only != nil && truthy(get(only, "split")) && get(only, "split") == get(gp, "split") {
			gsizes := arrOf(get(gp, "sizes"))
			s := jsjson.ToNumber(at0(gsizes, gi))
			osizes := arrOf(get(only, "sizes"))
			// A valid tree's sizes are numbers; a size of another type (only inside a batch, before the check) is Number(size).
			total := 0.0
			for _, x := range osizes {
				total += jsjson.ToNumber(x)
			}
			scaled := make([]jsjson.Value, len(osizes))
			for k, x := range osizes {
				scaled[k] = jsjson.ToNumber(x) / total * s
			}
			gp.Set("children", splice(arrOf(get(gp, "children")), gi, 1, arrOf(get(only, "children"))...))
			gp.Set("sizes", splice(gsizes, gi, 1, scaled...))
		} else if only != nil {
			replace(w, p, only)
		} else {
			typeError("a split holds something that isn't a pane or a split")
		}
	}
	if get(w, "focused") == get(target, "id") {
		w.Set("focused", get(firstLeaf(get(w, "root")), "id"))
	}
}

func firstLeaf(root jsjson.Value) *jsjson.Object {
	ls := leaves(root)
	if len(ls) == 0 {
		typeError("a world has no panes left")
	}
	return ls[0]
}

// worldOf is the world an op names: 'main' is the current one's; any other name is a world of worlds when it has one,
// else an agent's, thread's or page's world, made as DefaultWorld when it doesn't exist yet.
func worldOf(l *jsjson.Object, world string) *jsjson.Object {
	if world != "main" {
		if w, ok := get(objOf(get(l, "worlds")), world).(*jsjson.Object); ok {
			return w
		}
	}
	id := world
	if world == "main" {
		id = Home
		if cur, ok := get(l, "current").(string); ok {
			id = cur
		}
	}
	agents := objOf(get(l, "agentWorlds"))
	if w, ok := agents.Get(id); ok && w != nil {
		wo, ok := w.(*jsjson.Object)
		if !ok {
			typeError("a world isn't an object")
		}
		return wo
	}
	w := DefaultWorld(id)
	agents.Set(id, w)
	return w
}

var paneID = regexp.MustCompile(`^[\w:.-]{1,64}$`)

// idsFrom is the ids an op names first, then made-up ones.
func idsFrom(op *jsjson.Object, newID NewID) NewID {
	raw, has := op.Get("ids")
	if !has {
		return newID
	}
	list, ok := raw.([]jsjson.Value)
	if ok {
		for _, x := range list {
			if s, isStr := x.(string); !isStr || !paneID.MatchString(s) {
				ok = false
				break
			}
		}
	}
	if !ok {
		fail("ids must be a list of pane ids (letters, digits, _ : . -)")
	}
	q := append([]jsjson.Value(nil), list...)
	return func() string {
		if len(q) == 0 {
			return newID()
		}
		id := q[0].(string)
		q = q[1:]
		return id
	}
}

func findSplit(v jsjson.Value, id jsjson.Value) *jsjson.Object {
	n, ok := v.(*jsjson.Object)
	if !ok || !truthy(get(n, "split")) {
		return nil
	}
	if strictEq(get(n, "id"), id) {
		return n
	}
	for _, c := range arrOf(get(n, "children")) {
		if s := findSplit(c, id); s != nil {
			return s
		}
	}
	return nil
}

func leafIn(w *jsjson.Object, id jsjson.Value, world string) *jsjson.Object {
	for _, l := range leaves(get(w, "root")) {
		if strictEq(get(l, "id"), id) {
			return l
		}
	}
	fail("no pane %s in world %s", tpl(id), world)
	return nil
}

func tabIn(w *jsjson.Object, key jsjson.Value, world string) (*jsjson.Object, int) {
	for _, l := range leaves(get(w, "root")) {
		if i := indexOf(tabsOf(l), key); i >= 0 {
			return l, i
		}
	}
	fail("no tab %s in world %s", tpl(key), world)
	return nil, 0
}

func focusedLeaf(w *jsjson.Object) *jsjson.Object {
	ls := leaves(get(w, "root"))
	for _, l := range ls {
		if strictEq(get(l, "id"), get(w, "focused")) {
			return l
		}
	}
	if len(ls) == 0 {
		typeError("a world has no panes")
	}
	return ls[0]
}

// firstTab is `tabs[0] ?? null`.
func firstTab(tabs []jsjson.Value) jsjson.Value {
	if len(tabs) == 0 {
		return nil
	}
	return tabs[0]
}

func doMove(w *jsjson.Object, world string, key, toID, beforeKey jsjson.Value, side jsjson.Value, newID NewID) {
	from, index := tabIn(w, key, world)
	target := leafIn(w, toID, world)
	if truthy(side) && from == target && len(tabsOf(from)) == 1 {
		return
	}
	if strictEq(beforeKey, key) {
		return // dropped on its own place
	}
	ftabs := splice(tabsOf(from), index, 1)
	from.Set("tabs", ftabs)
	if strictEq(get(from, "active"), key) {
		from.Set("active", firstTab(ftabs))
	}
	dest := target
	if truthy(side) {
		dest = jsjson.NewObject("id", newID(), "tabs", []jsjson.Value{key}, "active", key)
		splitBeside(w, target, dest, side, newID)
	} else {
		tabs := tabsOf(target)
		at := -1
		if truthy(beforeKey) {
			at = indexOf(tabs, beforeKey)
		}
		if at >= 0 {
			tabs = splice(tabs, at, 0, key)
		} else {
			tabs = append(tabs, key)
		}
		target.Set("tabs", tabs)
		target.Set("active", key)
	}
	if len(tabsOf(from)) == 0 {
		removeLeaf(w, from)
	}
	w.Set("focused", get(dest, "id"))
}

var opNames = map[string]bool{"open": true, "close": true, "swap": true, "move": true, "split": true, "closePane": true, "activate": true,
	"focus": true, "tabBar": true, "resize": true, "setRoot": true, "dropWorld": true, "current": true}

// Apply is src/layout-ops.ts apply: one op on a copy of layout, which is never changed, with the version one up. An
// unknown pane, tab or op, or one this layout's tree can't take, is an error naming the problem.
func Apply(layout *jsjson.Object, rawOp jsjson.Value, made NewID) (out *jsjson.Object, err error) {
	defer func() {
		if p := recover(); p != nil {
			switch e := p.(type) {
			case opError:
				out, err = nil, fmt.Errorf("%s", e.msg)
			case runtime.Error:
				out, err = nil, fmt.Errorf("not a layout op this layout can take")
			default:
				panic(p)
			}
		}
	}()
	return apply(layout, rawOp, made), nil
}

func apply(layout *jsjson.Object, rawOp jsjson.Value, made NewID) *jsjson.Object {
	op, _ := rawOp.(*jsjson.Object)
	name, _ := field(op, "op").(string)
	if !opNames[name] {
		fail("unknown layout op %s", tpl(field(op, "op")))
	}
	world, isStr := field(op, "world").(string)
	if name != "current" && !isStr {
		fail("%s needs a world", name)
	}
	l := jsjson.Clone(layout).(*jsjson.Object)
	newID := idsFrom(op, made)
	version := jsjson.ToNumber(get(layout, "version")) + 1
	if name == "current" || name == "dropWorld" {
		// Showing a world makes it, so its views stay alive after the human moves on, as long as it's in the layout.
		if name == "current" {
			raw, has := op.Get("world")
			switch x := raw.(type) {
			case nil:
				if has {
					l.Set("current", nil)
				} else {
					// world undefined: TS sets current to undefined, then defaultWorld(undefined) throws.
					typeError("current needs a world, or null for home")
				}
			case string:
				l.Set("current", x)
				agents := objOf(get(l, "agentWorlds"))
				if w, ok := agents.Get(x); !ok || w == nil {
					agents.Set(x, DefaultWorld(x))
				}
			default:
				typeError("current needs a world, or null for home")
			}
		} else {
			objOf(get(l, "agentWorlds")).Delete(world)
			if get(l, "current") == jsjson.Value(world) {
				l.Set("current", nil)
			}
		}
		l.Set("version", version)
		return l
	}
	w := worldOf(l, world)
	key := field(op, "key")
	switch name {
	case "open":
		var found *jsjson.Object
		for _, x := range leaves(get(w, "root")) {
			if includes(tabsOf(x), key) {
				found = x
				break
			}
		}
		background := truthy(field(op, "background"))
		if found != nil {
			found.Set("active", key)
			if !background {
				w.Set("focused", get(found, "id"))
			}
			break
		}
		// An undefined key goes in as TS puts it in: in tabs as JSON.stringify prints it, null, and as an active tab
		// not at all. No valid layout holds either.
		tab := key
		if key == undefined {
			tab = nil
		}
		var target *jsjson.Object
		if pane := field(op, "pane"); pane != undefined {
			target = leafIn(w, pane, world)
		} else {
			target = focusedLeaf(w)
		}
		if split := field(op, "split"); truthy(split) {
			fresh := jsjson.NewObject("id", newID(), "tabs", []jsjson.Value{tab})
			setActive(fresh, key)
			splitBeside(w, target, fresh, split, newID)
			target = fresh
		} else {
			tabs := tabsOf(target)
			at := len(tabs)
			if active := get(target, "active"); truthy(active) {
				at = indexOf(tabs, active) + 1
			}
			target.Set("tabs", splice(tabs, at, 0, tab))
			setActive(target, key)
		}
		if !background {
			w.Set("focused", get(target, "id"))
		}
	case "close":
		leaf, index := tabIn(w, key, world)
		tabs := splice(tabsOf(leaf), index, 1)
		leaf.Set("tabs", tabs)
		if strictEq(get(leaf, "active"), key) {
			// tabs[Math.min(index, tabs.length - 1)] ?? null
			var next jsjson.Value
			if i := min(index, len(tabs)-1); i >= 0 {
				next = tabs[i]
			}
			leaf.Set("active", next)
		}
		if len(tabs) == 0 {
			removeLeaf(w, leaf)
		}
	// Shows `with` where `key` is, in the same pane and place (an agent's terminal and stam's view of it trade places).
	// A `with` open elsewhere in the world moves there, so the world never shows it twice.
	case "swap":
		with, ok := field(op, "with").(string)
		if !ok || with == "" {
			fail("swap needs a tab key in with")
		}
		if strictEq(key, with) {
			tabIn(w, key, world)
			break
		}
		leaf, _ := tabIn(w, key, world)
		var other *jsjson.Object
		for _, x := range leaves(get(w, "root")) {
			if includes(tabsOf(x), with) {
				other = x
				break
			}
		}
		if other != nil {
			otabs := splice(tabsOf(other), indexOf(tabsOf(other), with), 1)
			other.Set("tabs", otabs)
			if get(other, "active") == jsjson.Value(with) {
				other.Set("active", firstTab(otabs))
			}
			if other != leaf && len(otabs) == 0 {
				removeLeaf(w, other)
			}
		}
		tabs := tabsOf(leaf)
		tabs[indexOf(tabs, key)] = with
		if active, _ := leaf.Get("active"); strictEq(active, key) || active == nil {
			leaf.Set("active", with)
		}
	case "move":
		doMove(w, world, key, field(op, "to"), field(op, "before"), field(op, "side"), newID)
	case "split":
		pane := field(op, "pane")
		l0 := leafIn(w, pane, world)
		if active := get(l0, "active"); truthy(active) && len(tabsOf(l0)) > 1 {
			doMove(w, world, active, pane, nil, field(op, "side"), newID)
			break
		}
		fresh := jsjson.NewObject("id", newID(), "tabs", []jsjson.Value{}, "active", nil)
		splitBeside(w, l0, fresh, field(op, "side"), newID)
		w.Set("focused", get(fresh, "id"))
	case "closePane":
		l0 := leafIn(w, field(op, "pane"), world)
		if len(leaves(get(w, "root"))) < 2 {
			break
		}
		// Its tabs join the pane just before it (or just after, when it was first).
		p, i := parentOf(get(w, "root"), l0)
		children := arrOf(get(p, "children"))
		var sibling jsjson.Value
		if i > 0 {
			sibling = children[i-1]
		}
		if sibling == nil && i+1 < len(children) {
			sibling = children[i+1]
		}
		intoID := get(firstLeaf(sibling), "id")
		keys := append([]jsjson.Value(nil), tabsOf(l0)...)
		removeLeaf(w, l0)
		into := leafIn(w, intoID, world)
		tabs := tabsOf(into)
		for _, k := range keys {
			if !includes(tabs, k) {
				tabs = append(tabs, k)
			}
		}
		into.Set("tabs", tabs)
		// into.active ?? keys[0] ?? null
		if active, _ := into.Get("active"); active == nil {
			into.Set("active", firstTab(keys))
		}
		w.Set("focused", get(into, "id"))
	case "activate":
		pane := field(op, "pane")
		leaf := leafIn(w, pane, world)
		if !includes(tabsOf(leaf), key) {
			fail("no tab %s in pane %s of world %s", tpl(key), tpl(pane), world)
		}
		leaf.Set("active", key)
	case "focus":
		w.Set("focused", get(leafIn(w, field(op, "pane"), world), "id"))
	case "tabBar":
		leaf := leafIn(w, field(op, "pane"), world)
		// An undefined on is a key JSON.stringify leaves out.
		if on, has := op.Get("on"); has {
			leaf.Set("showTabs", on)
		} else {
			leaf.Delete("showTabs")
		}
	case "resize":
		id := field(op, "split")
		s := findSplit(get(w, "root"), id)
		if s == nil {
			fail("no split %s in world %s", tpl(id), world)
		}
		n := len(arrOf(get(s, "children")))
		sizes, ok := field(op, "sizes").([]jsjson.Value)
		if !ok || len(sizes) != n {
			fail("split %s needs %d sizes", tpl(id), n)
		}
		s.Set("sizes", jsjson.Clone(sizes))
	case "setRoot":
		root, has := op.Get("root")
		if !has {
			// JSON.parse(JSON.stringify(undefined)) throws.
			typeError("setRoot needs a root")
		}
		w.Set("root", jsjson.Clone(root))
		ls := leaves(get(w, "root"))
		if len(ls) == 0 {
			fail("setRoot for world %s has no panes", world)
		}
		focus := ls[0]
		if fk, has := op.Get("focusKey"); has {
			for _, x := range ls {
				if includes(tabsOf(x), fk) {
					focus = x
					break
				}
			}
		}
		w.Set("focused", get(focus, "id"))
		if meta := field(op, "meta"); truthy(meta) {
			for _, k := range []string{"tree", "saved", "mainPane", "treeSig"} {
				w.Delete(k)
			}
			if m, ok := meta.(*jsjson.Object); ok {
				m = jsjson.Clone(m).(*jsjson.Object)
				for _, k := range m.Keys() {
					w.Set(k, get(m, k))
				}
			}
		}
	}
	l.Set("version", version)
	return l
}

// undefined stands for a key an op doesn't have: JavaScript's undefined, which a template prints as "undefined" and ===
// tells apart from null.
type undefinedT struct{}

var undefined jsjson.Value = undefinedT{}

// field is op[k], undefined when op has no such key.
func field(o *jsjson.Object, k string) jsjson.Value {
	if v, ok := o.Get(k); ok {
		return v
	}
	return undefined
}

// setActive is `leaf.active = key`: an undefined key is a key JSON.stringify leaves out.
func setActive(leaf *jsjson.Object, key jsjson.Value) {
	if key == undefined {
		leaf.Delete("active")
		return
	}
	leaf.Set("active", key)
}

// truthy is JavaScript's truthiness, undefined included.
func truthy(v jsjson.Value) bool { return v != undefined && jsjson.Truthy(v) }

// get is o[k], nil for a missing key or a non-object.
func get(o jsjson.Value, k string) jsjson.Value {
	obj, ok := o.(*jsjson.Object)
	if !ok {
		return nil
	}
	v, _ := obj.Get(k)
	return v
}

// objOf is v as an object, an empty one when it isn't.
func objOf(v jsjson.Value) *jsjson.Object {
	if o, ok := v.(*jsjson.Object); ok {
		return o
	}
	return jsjson.NewObject()
}

func arrOf(v jsjson.Value) []jsjson.Value {
	a, _ := v.([]jsjson.Value)
	return a
}

// tabsOf is a pane's tabs; a pane whose tabs aren't a list is a TypeError in TS.
func tabsOf(leaf *jsjson.Object) []jsjson.Value {
	a, ok := get(leaf, "tabs").([]jsjson.Value)
	if !ok {
		typeError("a pane's tabs aren't a list")
	}
	return a
}

func at0(a []jsjson.Value, i int) jsjson.Value {
	if i < 0 || i >= len(a) {
		return nil
	}
	return a[i]
}

func isString(v jsjson.Value) bool {
	_, ok := v.(string)
	return ok
}

// strictEq is JavaScript's === on parsed JSON: primitives by type and value, objects and arrays by identity.
func strictEq(a, b jsjson.Value) bool {
	switch x := a.(type) {
	case undefinedT:
		return b == undefined
	case nil:
		return b == nil
	case string, bool, float64:
		return a == b
	case *jsjson.Object:
		y, ok := b.(*jsjson.Object)
		return ok && x == y
	case []jsjson.Value:
		y, ok := b.([]jsjson.Value)
		return ok && len(x) == len(y) && len(x) > 0 && &x[0] == &y[0]
	}
	return false
}

func indexOf(a []jsjson.Value, v jsjson.Value) int {
	for i, x := range a {
		if strictEq(x, v) {
			return i
		}
	}
	return -1
}

// includes is Array#includes: indexOf, except that NaN, which JSON can't hold, would match itself.
func includes(a []jsjson.Value, v jsjson.Value) bool { return indexOf(a, v) >= 0 }

// splice is Array#splice on a copy: delete count items at start (clamped as JavaScript clamps it), insert items there.
func splice(a []jsjson.Value, start, count int, items ...jsjson.Value) []jsjson.Value {
	if start < 0 {
		start = max(len(a)+start, 0)
	}
	start = min(start, len(a))
	count = min(max(count, 0), len(a)-start)
	out := make([]jsjson.Value, 0, len(a)-count+len(items))
	out = append(out, a[:start]...)
	out = append(out, items...)
	return append(out, a[start+count:]...)
}

// tpl is a value in a template literal, as `${v}` prints it.
func tpl(v jsjson.Value) string {
	switch x := v.(type) {
	case undefinedT:
		return "undefined"
	case nil:
		return "null"
	case string:
		return x
	case float64:
		return jsjson.Number(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case []jsjson.Value:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = tpl(e)
			}
		}
		return strings.Join(parts, ",")
	case *jsjson.Object:
		return "[object Object]"
	}
	return fmt.Sprint(v)
}
