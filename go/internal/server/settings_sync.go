package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	neturl "net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// Shared settings across machines (src/settings-sync.ts, S-390, S-3782 part 6c). The home serves the shared part of its
// settings.json, with its registry.json, instructions.md and type templates, under one rev, and tells its peers when
// that rev changes. A non-home daemon fetches them at boot, on the home's push, and on a poll, into its cache
// (settings.shared.json), keeping the last good copy while the home is down. Nothing here runs on a request's path or
// blocks boot. A secret in the shared part travels only to a peer's daemon, over its peer token, as in TS.
//
// Not yet ported: the home's web origin (the Go daemon serves no page: it sends no `web`, so a peer's page writes its
// shared settings on the home's own page), and a peer's tidy of the type templates its home dropped (pruneTypeFiles,
// with the type templates of part 6d).

// The deadlines of src/settings-sync.ts.
const (
	settingsFetchWait = 5 * time.Second
	settingsPushWait  = 3 * time.Second
)

// settingsSync is the sync's state: the home's payload memo and push, and a peer's view of its home.
type settingsSync struct {
	mu sync.Mutex
	// pushedRev is the rev last pushed; pushQueued a push waiting to run.
	pushedRev  string
	pushQueued bool

	// rev is the rev of the cache ("" none), homeWeb the home's page origin; fetchedAt and lastError the last fetch.
	rev       string
	homeWeb   string
	fetchedAt string
	lastError string
	failed    bool
	// running is a fetch in flight, done closed when it ends; again asks it for one more run.
	running bool
	again   bool
	done    chan struct{}
}

// sharedPayload is the home's shared settings as its peers get them (config.SharedPayload).
func (s *Server) sharedPayload() *jsjson.Object {
	text, _ := s.settings.Text()
	return config.SharedPayload(s.cfg.Home, text)
}

// payloadRev is the payload's rev, "" for none.
func payloadRev(p *jsjson.Object) string {
	if p == nil {
		return ""
	}
	v, _ := p.Get("rev")
	r, _ := v.(string)
	return r
}

// StartSettingsSync is src/daemon.ts's watchHomeChanges and startSettingsSync, once the daemon is up: the home pushes
// after each write and once now; a non-home daemon syncs now, then every STAM_SETTINGS_SYNC_MS (60 s), until ctx ends.
func (s *Server) StartSettingsSync(ctx context.Context) {
	s.settings.OnChange(s.schedulePush)
	s.schedulePush()
	if c := s.settings.SharedCache(); c != nil {
		s.sharedSync.mu.Lock()
		s.sharedSync.rev, _ = c.Rev.(string)
		if o, ok := webOrigin(c.Web); ok && o == c.Web {
			s.sharedSync.homeWeb = c.Web
		}
		s.sharedSync.mu.Unlock()
	}
	poll := 60 * time.Second
	if n, err := strconv.ParseFloat(os.Getenv("STAM_SETTINGS_SYNC_MS"), 64); err == nil && n > 0 {
		poll = time.Duration(n * float64(time.Millisecond))
	}
	go func() {
		s.syncShared()
		s.pruneTypeFilesNow()
		t := time.NewTicker(poll)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.syncShared()
			}
		}
	}()
}

// schedulePush is src/settings-sync.ts schedulePush: a push off the write path, coalesced.
func (s *Server) schedulePush() {
	s.sharedSync.mu.Lock()
	if s.sharedSync.pushQueued {
		s.sharedSync.mu.Unlock()
		return
	}
	s.sharedSync.pushQueued = true
	s.sharedSync.mu.Unlock()
	go func() {
		s.sharedSync.mu.Lock()
		s.sharedSync.pushQueued = false
		s.sharedSync.mu.Unlock()
		s.pushIfChanged()
	}()
}

// pushIfChanged is src/settings-sync.ts pushIfChanged: on the home, each peer is told a new rev, fire-and-forget; a down
// peer catches up on its poll. A write that left the shared part as it was pushes nothing.
func (s *Server) pushIfChanged() {
	if !s.isSettingsHome() {
		return
	}
	rev := payloadRev(s.sharedPayload())
	s.sharedSync.mu.Lock()
	if rev == "" || rev == s.sharedSync.pushedRev {
		s.sharedSync.mu.Unlock()
		return
	}
	s.sharedSync.pushedRev = rev
	s.sharedSync.mu.Unlock()
	for _, p := range s.peers.Peers() {
		s.peers.Notify(p, http.MethodPost, "/api/config/settings/changed", map[string]string{"rev": rev}, settingsPushWait)
	}
}

// syncState is src/settings-sync.ts SyncState, in its key order.
type syncState struct {
	Home      string  `json:"home"`
	Rev       *string `json:"rev"`
	FetchedAt *string `json:"fetchedAt"`
	LastError *string `json:"lastError"`
	Stale     bool    `json:"stale"`
	HomeWeb   *string `json:"homeWeb"`
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// syncState is src/settings-sync.ts syncState: where this daemon's copy of the shared settings stands.
func (s *Server) syncState() syncState {
	home := s.settings.Get().Home
	if home == s.cfg.Machine {
		return syncState{Home: home, Rev: strPtr(payloadRev(s.sharedPayload()))}
	}
	st := &s.sharedSync
	st.mu.Lock()
	defer st.mu.Unlock()
	var lastError *string
	if st.failed {
		e := st.lastError
		lastError = &e
	}
	return syncState{Home: home, Rev: strPtr(st.rev), FetchedAt: strPtr(st.fetchedAt), LastError: lastError, Stale: st.failed || st.fetchedAt == "", HomeWeb: strPtr(st.homeWeb)}
}

// syncShared is src/settings-sync.ts syncShared: one fetch at a time; a call while one runs makes exactly one more run
// after it, and waits for it.
func (s *Server) syncShared() {
	st := &s.sharedSync
	st.mu.Lock()
	if st.running {
		st.again = true
		done := st.done
		st.mu.Unlock()
		<-done
		return
	}
	st.running = true
	st.done = make(chan struct{})
	done := st.done
	st.mu.Unlock()
	for {
		s.fetchShared()
		st.mu.Lock()
		if !st.again {
			st.running = false
			close(done)
			st.mu.Unlock()
			return
		}
		st.again = false
		st.mu.Unlock()
	}
}

// homeChanged is src/settings-sync.ts homeChanged: a push from the home is a sync, unless this daemon already has
// that rev. It returns whether it started one.
func (s *Server) homeChanged(pushed jsjson.Value) bool {
	st := &s.sharedSync
	st.mu.Lock()
	r, isStr := pushed.(string)
	have := isStr && r == st.rev && st.rev != "" && !st.failed
	st.mu.Unlock()
	if !have {
		go s.syncShared()
	}
	return !have
}

// fetchShared is src/settings-sync.ts fetchOnce: the home's shared settings into the cache. A failure keeps the cache
// and is logged once per outage.
func (s *Server) fetchShared() {
	if s.isSettingsHome() {
		return
	}
	home := s.settings.Get().Home
	err := s.fetchSharedFrom(home)
	st := &s.sharedSync
	st.mu.Lock()
	defer st.mu.Unlock()
	if err != nil {
		if !st.failed {
			slog.Error(fmt.Sprintf("settings sync: can't fetch the shared settings from %s, keeping the cached copy: %s", home, err.Error()))
		}
		st.failed, st.lastError = true, err.Error()
		return
	}
	st.fetchedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if st.failed {
		slog.Info("settings sync: " + home + " reached again")
	}
	st.failed, st.lastError = false, ""
}

func (s *Server) fetchSharedFrom(home string) error {
	peer, ok := s.peers.ByName(home)
	if !ok {
		return fmt.Errorf("the settings home '%s' is not a configured peer", home)
	}
	s.sharedSync.mu.Lock()
	rev, homeWeb := s.sharedSync.rev, s.sharedSync.homeWeb
	s.sharedSync.mu.Unlock()
	path := "/api/config/settings/shared"
	if rev != "" {
		path += "?rev=" + jsEncodeURIComponent(rev)
	}
	ctx, cancel := context.WithTimeout(context.Background(), settingsFetchWait)
	defer cancel()
	r, err := s.peers.Call(ctx, peer, http.MethodGet, path, nil, settingsFetchWait, false, nil)
	if err != nil {
		return err
	}
	if r.Status != http.StatusOK {
		msg := ""
		if e, ok := r.Data.Get("error"); ok && e.Kind == jsfmt.String {
			msg = e.Str
		}
		return fmt.Errorf("%s answered %d: %s", home, r.Status, msg)
	}
	data, perr := jsjson.Parse([]byte(jsfmt.Compact(r.Data)))
	d, _ := data.(*jsjson.Object)
	if perr != nil || d == nil {
		return fmt.Errorf("%s sent no shared settings", home)
	}
	// Only a bare origin is taken, so the UI can't be sent to a path or another scheme.
	web := ""
	if w, _ := d.Get("web"); w != nil {
		if ws, isStr := w.(string); isStr {
			if o, ok := webOrigin(ws); ok && o == strings.TrimSuffix(strings.ToLower(ws), "/") {
				web = o
			}
		}
	}
	unchanged, _ := d.Get("unchanged")
	if !jsjson.Truthy(unchanged) {
		nextRev, _ := d.Get("rev")
		next, _ := d.Get("settings")
		nr, isStr := nextRev.(string)
		if _, isObj := next.(*jsjson.Object); !isStr || !isObj {
			return fmt.Errorf("%s sent no shared settings", home)
		}
		cache := jsjson.NewObject("rev", nr, "settings", next)
		if reg, _ := d.Get("registry"); reg != nil {
			if _, isObj := reg.(*jsjson.Object); isObj {
				cache.Set("registry", reg)
			}
		}
		if ins, ok := d.Get("instructions"); ok {
			if _, isStr := ins.(string); isStr {
				cache.Set("instructions", ins)
			}
		}
		if tpl, _ := d.Get("templates"); tpl != nil {
			if t, isObj := tpl.(*jsjson.Object); isObj {
				kept := jsjson.NewObject()
				for _, k := range t.Keys() {
					v, _ := t.Get(k)
					if _, isStr := v.(string); isStr && config.TypeTemplateName.MatchString(k) {
						kept.Set(k, v)
					}
				}
				cache.Set("templates", kept)
			}
		}
		if web != "" {
			cache.Set("web", web)
		}
		if nr != rev || web != homeWeb {
			if err := s.settings.WriteSharedCache(config.Text(cache)); err != nil {
				return err
			}
		}
		s.sharedSync.mu.Lock()
		s.sharedSync.rev = nr
		s.sharedSync.mu.Unlock()
		reg, _ := d.Get("registry")
		s.pruneTypeFiles(reg)
	}
	// A home that starts or stops serving its page with no settings change: the cache keeps the new origin too.
	if jsjson.Truthy(unchanged) && web != homeWeb {
		if raw, err := os.ReadFile(s.settings.SharedPath()); err == nil && s.settings.SharedCache() != nil {
			c := config.ParseObject(string(raw))
			if web != "" {
				c.Set("web", web)
			} else {
				c.Delete("web")
			}
			if err := s.settings.WriteSharedCache(config.Text(c)); err != nil {
				return err
			}
		}
	}
	s.sharedSync.mu.Lock()
	s.sharedSync.homeWeb = web
	s.sharedSync.mu.Unlock()
	return nil
}

// webOrigin is src/web-origins.ts originOf: an http or https URL's origin, lower-cased.
func webOrigin(raw string) (string, bool) {
	u, err := neturl.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", false
	}
	host := strings.ToLower(u.Host)
	// URL#origin leaves out the scheme's default port.
	if p := u.Port(); (u.Scheme == "http" && p == "80") || (u.Scheme == "https" && p == "443") {
		host = strings.TrimSuffix(host, ":"+p)
	}
	return u.Scheme + "://" + host, true
}

// The sync routes (src/daemon.ts): the home serves the shared part of its settings to its peers, a peer hears when it
// changed, and the sync state shows where a peer's copy stands.
func (s *Server) settingsSyncRoutes() {
	s.handle("GET /api/config/settings/shared", s.getSharedSettings)
	s.handle("POST /api/config/settings/sync", s.postSettingsSync)
	s.handle("POST /api/config/settings/changed", s.postSettingsChanged)
	s.handle("GET /api/config/settings/sync", func(*http.Request, auth.Resolved) (any, error) { return s.syncState(), nil })
}

// getSharedSettings is GET /api/config/settings/shared: only a peer's daemon, and only from the home. With the rev the
// peer has, the answer is {unchanged, rev}.
func (s *Server) getSharedSettings(r *http.Request, c auth.Resolved) (any, error) {
	if !c.Local {
		return nil, Errorf(http.StatusForbidden, "only a peer can fetch the shared settings")
	}
	if !s.isSettingsHome() {
		return nil, Errorf(http.StatusConflict, "%s is not the settings home", s.cfg.Machine)
	}
	payload := s.sharedPayload()
	if payload == nil {
		return nil, Errorf(http.StatusServiceUnavailable, "settings.json is not valid JSON")
	}
	if rev := payloadRev(payload); r.URL.Query().Get("rev") == rev {
		payload = jsjson.NewObject("unchanged", true, "rev", rev)
	}
	// The home's web origin rides along, so a peer's page knows where to send shared writes (S-414).
	if web := s.publishedWebOrigin(); web != "" {
		payload.Set("web", web)
	}
	return json.RawMessage(jsjson.Stringify(payload, "")), nil
}

// postSettingsSync is POST /api/config/settings/sync: a peer's page wrote to the home (S-414) and asks its own daemon to
// fetch the result now. Only a fetch from the home; it changes nothing else.
func (s *Server) postSettingsSync(*http.Request, auth.Resolved) (any, error) {
	s.syncShared()
	st := s.syncState()
	return struct {
		Rev       *string `json:"rev"`
		Stale     bool    `json:"stale"`
		FetchedAt *string `json:"fetchedAt"`
	}{st.Rev, st.Stale, st.FetchedAt}, nil
}

// postSettingsChanged is POST /api/config/settings/changed: the home's push.
func (s *Server) postSettingsChanged(r *http.Request, c auth.Resolved) (any, error) {
	if !c.Local {
		return nil, Errorf(http.StatusForbidden, "only a peer can say its settings changed")
	}
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	s.homeChanged(getValue(w.body, "rev"))
	return map[string]bool{"scheduled": true}, nil
}

// pruneTypeFilesNow is src/settings-sync.ts pruneTypeFiles() at boot: the home's registry asked for now, then
// pruneTypeFiles. Any failure, an unreachable home included, keeps every file.
func (s *Server) pruneTypeFilesNow() {
	if s.isSettingsHome() || len(s.localTypeFiles()) == 0 {
		return
	}
	peer, ok := s.peers.ByName(s.settings.Get().Home)
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), settingsFetchWait)
	defer cancel()
	r, err := s.peers.Call(ctx, peer, http.MethodGet, "/api/config/settings/shared", nil, settingsFetchWait, false, nil)
	if err != nil || r.Status != http.StatusOK {
		return
	}
	data, err := jsjson.Parse([]byte(jsfmt.Compact(r.Data)))
	if err != nil {
		return
	}
	reg, _ := at(data, "registry")
	s.pruneTypeFiles(reg)
}

// pruneTypeFiles is src/settings-sync.ts pruneTypeFiles with the home's registry as it sent it: the type templates a
// peer keeps from before the home kept them (STAM_HOME/templates/type-NAME.md, which nothing reads once the cache has
// the home's templates) go once that registry shows their type gone (typeFilesGone). Without the shipped types, or
// with a registry that has no types, every file stays.
func (s *Server) pruneTypeFiles(registry jsjson.Value) {
	if s.isSettingsHome() || s.tpl == nil {
		return
	}
	names := s.localTypeFiles()
	if len(names) == 0 {
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.tpl.Root, "registry", "defaults.json"))
	if err != nil {
		return
	}
	defaults, err := jsjson.Parse(raw)
	if err != nil {
		return
	}
	shipped, _ := at(defaults, "types")
	for _, n := range typeFilesGone(registry, names, shipped) {
		if err := os.Remove(filepath.Join(s.cfg.Home, "templates", n+".md")); err != nil && !errors.Is(err, fs.ErrNotExist) {
			slog.Error(fmt.Sprintf("settings sync: can't tidy the type templates: %s", err.Error()))
		}
	}
}

// typeFilesGone is src/settings-sync.ts typeFilesGone: of the template names (type-NAME), those whose type the home's
// registry shows gone, masked with null, or named by neither its types nor the shipped ones.
func typeFilesGone(registry jsjson.Value, names []string, shipped jsjson.Value) []string {
	types, ok := at(registry, "types")
	t, isObj := types.(*jsjson.Object)
	if !ok || !isObj {
		return nil
	}
	sh, _ := shipped.(*jsjson.Object)
	var out []string
	for _, n := range names {
		typ := strings.TrimPrefix(n, "type-")
		v, has := t.Get(typ)
		_, inShipped := sh.Get(typ)
		if (has && v == nil) || (!has && !inShipped) {
			out = append(out, n)
		}
	}
	return out
}

// localTypeFiles is the names (type-NAME) of the type templates in STAM_HOME/templates.
func (s *Server) localTypeFiles() []string {
	entries, _ := os.ReadDir(filepath.Join(s.cfg.Home, "templates"))
	var out []string
	for _, e := range entries {
		if m := config.TypeTemplateFile.FindStringSubmatch(e.Name()); m != nil {
			out = append(out, m[1])
		}
	}
	return out
}
