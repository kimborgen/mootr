package server

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"stam/internal/auth"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/process"
)

// The process designer's files (src/daemon.ts processesHere and processRoute, S-869): `processes/*.yaml` in this release's repo
// root, parsed against the registry's agent types and the ITSA statuses. The parse is cached while every file's size and
// modification time hold and the registry's agent types are unchanged; a process file changes rarely.
type processCache struct {
	mu     sync.Mutex
	stamp  string
	loaded process.Loaded
}

func (s *Server) registryTypes() []string {
	if s.tpl == nil {
		return nil
	}
	types, err := s.tpl.Types()
	if err != nil {
		return nil
	}
	names := make([]string, 0, len(types))
	for n := range types {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// processesHere is the loaded processes of the checkout's processes/ folder.
func (s *Server) processesHere() (process.Loaded, error) {
	if s.tpl == nil {
		return process.Loaded{}, Errorf(http.StatusInternalServerError, "no checkout to read processes/ from")
	}
	dir := filepath.Join(s.tpl.Root, "processes")
	types := s.registryTypes()
	files, err := process.Files(dir)
	if err != nil {
		return process.Loaded{}, err
	}
	stamp := strings.Join(append(append([]string{}, types...), files...), "|")
	s.procs.mu.Lock()
	defer s.procs.mu.Unlock()
	if s.procs.stamp == stamp && s.procs.loaded.Processes != nil {
		return s.procs.loaded, nil
	}
	known := map[string]bool{}
	for _, t := range types {
		known[t] = true
	}
	statuses := map[string]bool{}
	for _, st := range s.itsaStatuses() {
		statuses[st.Name] = true
	}
	loaded, err := process.Load(dir, known, statuses)
	if err != nil {
		return process.Loaded{}, err
	}
	if loaded.Processes == nil {
		loaded.Processes = []*process.Def{}
	}
	s.procs.stamp, s.procs.loaded = stamp, loaded
	return loaded, nil
}

// processesRoute is GET /api/processes: what the designer draws, with the live count of open ITSAs at each node that names
// statuses. The ITSAs live on the ITSA home daemon, and a peer proxies this path there before the route runs; the counts are
// computed per request and only the parse is cached.
func (s *Server) processesRoute(r *http.Request, c auth.Resolved) (any, error) {
	if err := s.notHome(c); err != nil {
		return nil, err
	}
	ctx := r.Context()
	loaded, err := s.processesHere()
	if err != nil {
		return nil, err
	}
	list, err := s.db.ListItsas(ctx, db.ItsaFilter{})
	if err != nil {
		return nil, err
	}
	itsas := make([]process.CountItsa, 0, len(list))
	for _, x := range list {
		ci := process.CountItsa{Key: x.Text("key"), ID: x.Text("id"), Title: x.Text("title"), Status: x.Text("status")}
		if k, ok := x.Get("kind"); ok && k.Kind == jsfmt.String {
			kind := k.Str
			ci.Kind = &kind
		}
		if f, ok := x.Get("fields"); ok && f.Kind == jsfmt.Object {
			if st, ok := f.Get("stage"); ok && st.Kind == jsfmt.String {
				stage := st.Str
				ci.Stage = &stage
			}
		}
		if o := x.Text("owner"); o != "" {
			ci.Owner = o
			if a, err := s.db.GetAgent(ctx, o); err == nil {
				ci.Owner = a.Name
			}
		}
		itsas = append(itsas, ci)
	}
	counts := process.Counts(loaded.Processes, itsas, s.isClosedStatus)
	procs := make([]jsfmt.Value, len(loaded.Processes))
	for i, p := range loaded.Processes {
		v := p.Value()
		v.Set("counts", process.CountsValue(p, counts[p.ID]))
		if text, err := os.ReadFile(filepath.Join(s.tpl.Root, "processes", p.ID+".yaml")); err == nil {
			v.Set("source", jsfmt.StringValue(string(text)))
		}
		procs[i] = v
	}
	errs := make([]jsfmt.Value, len(loaded.Errors))
	for i, e := range loaded.Errors {
		ev := jsfmt.Value{Kind: jsfmt.Object}
		ev.Set("file", jsfmt.StringValue(e.File))
		ev.Set("message", jsfmt.StringValue(e.Message))
		errs[i] = ev
	}
	types := s.registryTypes()
	tv := make([]jsfmt.Value, len(types))
	for i, t := range types {
		tv[i] = jsfmt.StringValue(t)
	}
	out := jsfmt.Value{Kind: jsfmt.Object}
	out.Set("processes", jsfmt.ArrayValue(procs))
	out.Set("errors", jsfmt.ArrayValue(errs))
	out.Set("types", jsfmt.ArrayValue(tv))
	return out, nil
}
