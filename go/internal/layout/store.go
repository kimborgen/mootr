package layout

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"stam/internal/jsjson"
)

// Conflict is a stale base, or a PUT over a layout that isn't empty: the caller gets the current layout with it.
type Conflict struct {
	Layout  *jsjson.Object
	Message string
}

func (c *Conflict) Error() string { return c.Message }

// batchesKept is how many batch ids the store remembers: a client that lost the reply to a batch sends it again, and it
// must not apply twice (its new panes would repeat their ids).
const batchesKept = 512

// Store is src/layout.ts: the one layout of the daemon, kept in HOME/layout.json and written atomically, and the web
// pages that follow it.
type Store struct {
	file string
	now  func() time.Time
	// writeTimeout bounds each write to a stream (writeTimeout; a test shortens it), and hooks are a test's seams in it.
	writeTimeout time.Duration
	hooks        streamHooks

	mu      sync.Mutex
	layout  *jsjson.Object
	applied map[string]bool
	order   []string
	subs    map[*subscriber]bool
	pages   *pageLiveness
}

// Open loads home's layout.json: a missing file is the empty layout, and one that isn't a layout is logged and starts
// empty, as in TS.
func Open(home string) *Store {
	s := &Store{file: filepath.Join(home, "layout.json"), now: time.Now, writeTimeout: writeTimeout, applied: map[string]bool{}, subs: map[*subscriber]bool{}}
	s.layout = s.load()
	s.pages = newPageLiveness(s.now())
	return s
}

func (s *Store) load() *jsjson.Object {
	b, err := os.ReadFile(s.file)
	if errors.Is(err, os.ErrNotExist) {
		return EmptyLayout()
	}
	if err == nil {
		var v jsjson.Value
		if v, err = jsjson.Parse(b); err == nil {
			if Valid(v) {
				return v.(*jsjson.Object)
			}
			slog.Error(fmt.Sprintf("layout: %s isn't a layout; starting empty", s.file))
			return EmptyLayout()
		}
	}
	slog.Error(fmt.Sprintf("layout: couldn't read %s (%v); starting empty", s.file, err))
	return EmptyLayout()
}

func (s *Store) save(next *jsjson.Object) error {
	tmp := s.file + "." + strconv.Itoa(os.Getpid()) + ".tmp"
	if err := os.WriteFile(tmp, []byte(jsjson.Stringify(next, "  ")+"\n"), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// commit saves next and tells every stream. The caller holds mu.
func (s *Store) commit(next *jsjson.Object) error {
	if err := s.save(next); err != nil {
		return fmt.Errorf("layout: couldn't save %s: %w", s.file, err)
	}
	s.layout = next
	data := event(next)
	for sub := range s.subs {
		sub.send(data)
	}
	return nil
}

// Get is the layout as it is. The caller must not change it: every change makes a new one.
func (s *Store) Get() *jsjson.Object {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.layout
}

// newID is src/layout.ts newId: 'p' and the first 8 hex digits of a random UUID.
func newID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return "p" + hex.EncodeToString(b)
}

// ApplyOps is src/layout.ts applyOps: every op in order, all or none, as one version step. base, when not nil, must be
// the current version, else a *Conflict. An invalid op is an error and changes nothing. batch, when not nil, makes a
// repeat of the same call return the layout as it is, applying nothing.
func (s *Store) ApplyOps(ops []jsjson.Value, base *float64, batch *string) (*jsjson.Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applyOps(ops, base, batch)
}

func (s *Store) applyOps(ops []jsjson.Value, base *float64, batch *string) (*jsjson.Object, error) {
	if batch != nil && s.applied[*batch] {
		return s.layout, nil
	}
	version := jsjson.ToNumber(get(s.layout, "version"))
	if base != nil && *base != version {
		return nil, &Conflict{Layout: s.layout, Message: fmt.Sprintf("layout is at version %s, not the base %s", jsjson.Number(version), jsjson.Number(*base))}
	}
	if len(ops) == 0 {
		return s.layout, nil
	}
	next := s.layout
	for _, op := range ops {
		var err error
		if next, err = Apply(next, op, newID); err != nil {
			return nil, err
		}
	}
	next.Set("version", version+1)
	// A change that leaves a malformed tree would be refused at the next start, so it's refused now.
	if !Valid(next) {
		return nil, errors.New("that change would leave an invalid layout (a pane tree with no children, or sizes that aren't positive numbers); nothing changed")
	}
	if err := s.commit(next); err != nil {
		return nil, err
	}
	if batch != nil {
		s.applied[*batch] = true
		s.order = append(s.order, *batch)
		if len(s.order) > batchesKept {
			delete(s.applied, s.order[0])
			s.order = s.order[1:]
		}
	}
	return s.layout, nil
}

// Replace is src/layout.ts replaceLayout: the whole layout (the web's one-time move from its browser storage), only
// while the stored one is empty, else a *Conflict.
func (s *Store) Replace(next jsjson.Value) (*jsjson.Object, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !IsEmpty(s.layout) {
		return nil, &Conflict{Layout: s.layout, Message: "the layout isn't empty; PUT replaces only an empty layout"}
	}
	if !Valid(next) {
		return nil, errors.New("not a layout: needs version, current, agentWorlds, and worlds, with well-formed panes")
	}
	// { ...next, version: layout.version + 1 }: next's keys in its order, version where next has it.
	committed := jsjson.Clone(next).(*jsjson.Object)
	committed.Set("version", jsjson.ToNumber(get(s.layout, "version"))+1)
	if err := s.commit(committed); err != nil {
		return nil, err
	}
	return s.layout, nil
}

// pageID is a web page's id in its stream's x-stam-page header.
var pageID = regexp.MustCompile(`^[a-z0-9]{1,12}$`)

// DropDeadImageTabs is src/layout.ts dropDeadImageTabs: the image tabs of the pages that aren't live close, and those
// are the only tabs it touches.
func (s *Store) DropDeadImageTabs() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.pages.prune(now)
	ops := DeadImageTabOps(s.layout, func(page string) bool { return s.pages.live(page, now) })
	if len(ops) == 0 {
		return nil
	}
	list := make([]jsjson.Value, len(ops))
	for i, op := range ops {
		list[i] = op
	}
	_, err := s.applyOps(list, nil, nil)
	return err
}

// sweepEvery is how often the image tabs of dead pages are closed (src/layout.ts SWEEP).
const sweepEvery = 15 * time.Second

// Sweep closes the image tabs of dead pages every 15 s until done closes.
func (s *Store) Sweep(done <-chan struct{}) {
	t := time.NewTicker(sweepEvery)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
			if err := s.DropDeadImageTabs(); err != nil {
				slog.Error(fmt.Sprintf("layout: couldn't close the image tabs of dead pages (%v)", err))
			}
		}
	}
}

// DescribeOp is src/layout.ts describeOp: one op as a short phrase, for the agent's event log.
func DescribeOp(v jsjson.Value) string {
	op, _ := v.(*jsjson.Object)
	f := func(k string) string { return tpl(field(op, k)) }
	switch field(op, "op") {
	case "open":
		return "open " + f("key") + " in " + f("world")
	case "close":
		return "close " + f("key") + " in " + f("world")
	case "swap":
		return "show " + f("with") + " in place of " + f("key") + " in " + f("world")
	case "move":
		return "move " + f("key") + " to pane " + f("to") + " in " + f("world")
	case "split":
		return "split pane " + f("pane") + " " + f("side") + " in " + f("world")
	case "closePane":
		return "close pane " + f("pane") + " in " + f("world")
	case "activate":
		return "show " + f("key") + " in pane " + f("pane") + " of " + f("world")
	case "focus":
		return "focus pane " + f("pane") + " in " + f("world")
	case "tabBar":
		if truthy(field(op, "on")) {
			return "show the tab bar of pane " + f("pane") + " in " + f("world")
		}
		return "hide the tab bar of pane " + f("pane") + " in " + f("world")
	case "resize":
		return "resize split " + f("split") + " in " + f("world")
	case "setRoot":
		return "rearrange " + f("world")
	case "dropWorld":
		return "drop the world " + f("world")
	case "current":
		// op.world ?? 'home'
		if w := field(op, "world"); w != undefined && w != nil {
			return "show " + tpl(w)
		}
		return "show home"
	}
	// TS's switch has no default: the op names are checked before any is described.
	return "undefined"
}
