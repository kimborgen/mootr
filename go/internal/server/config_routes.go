package server

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"stam/internal/auth"
	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// The settings routes of src/daemon.ts (S-3071, S-3782 parts 6a and 6c): the human reads and writes settings.json on the
// settings home, an agent reads it redacted, and the chief of staff and the assistant may ask for a change. A non-home
// daemon shows the settings it uses (the home's shared part with its own local keys) and writes only its local keys: a
// change to a shared key is a 409 naming the home, and nothing of it is written (S-398).
//
// Not yet ported: a peer's UI writing the home's shared part (S-414; the Go daemon serves no page, so it never takes a
// request as a peer page's), an MCP server's client secret moving into the secret store (a write that holds one in
// plain text gets 501, so it never reaches settings.json), and the permission-modes event a write records
// (src/permission-modes.ts noteSettingsChange).

func (s *Server) configRoutes() {
	s.handle("GET /api/config/settings", s.getSettings)
	s.handle("POST /api/config/settings", s.postSettings)
	s.handle("PATCH /api/config/settings", s.patchSettings)
	s.settingsSyncRoutes()
	s.registryRoutes()
}

// settingsView is the settings GET's answer, in TS's key order.
type settingsView struct {
	Text      string   `json:"text"`
	Local     []string `json:"local"`
	Home      string   `json:"home"`
	Stale     bool     `json:"stale"`
	FetchedAt *string  `json:"fetchedAt"`
	// HomeWeb is the home's web origin, on a peer whose home serves one (S-414).
	HomeWeb *string `json:"homeWeb,omitempty"`
}

// isSettingsHome is src/settings.ts isSettingsHome: this daemon holds the settings.
func (s *Server) isSettingsHome() bool { return s.settings.Get().Home == s.cfg.Machine }

// peerLocalOnly is src/daemon.ts peerLocalOnly: a settings change on a non-home daemon may change only its local keys.
// One that touches a shared key is a 409 naming the home, so a mixed change is all or nothing. It returns the local
// part to write.
func (s *Server) peerLocalOnly(patch *jsjson.Object, fill bool) (*jsjson.Object, error) {
	local, shared := config.SplitPatch(patch, fill, s.settings.CachedSettings())
	if keys := shared.Keys(); len(keys) > 0 {
		home := s.settings.Get().Home
		return nil, &Error{Status: http.StatusConflict, Message: fmt.Sprintf("shared settings live on %s; change them there (%s)", home, strings.Join(keys, ", ")),
			Extra: map[string]any{"home": home, "shared": keys}}
	}
	return local, nil
}

// unredacted is src/daemon.ts unredacted: the change with the redacted values an agent kept put back, else a 400.
func (s *Server) unredacted(c config.Change) (*jsjson.Object, error) {
	current, err := s.settings.EffectiveText()
	if err != nil {
		return nil, err
	}
	u, err := config.UnredactedChange(c, current)
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	return u, nil
}

// trustedHuman is src/daemon.ts trustedHuman (auth.TrustedHuman): the human's own proof, whatever token comes with it.
func (s *Server) trustedHuman(r *http.Request) bool { return s.auth.TrustedHuman(r) }

// registry is the merged registry the settings checks resolve names in.
func (s *Server) registry() *jsjson.Object {
	root := ""
	if s.tpl != nil {
		root = s.tpl.Root
	}
	return config.Registry(root, s.cfg.Home, s.cfg.Machine)
}

// getSettings is GET /api/config/settings: the settings this daemon uses, redacted for an agent or the OpenCode server
// (S-259), with the machine-local keys, which daemon is the home, and whether a peer's copy may be behind.
func (s *Server) getSettings(r *http.Request, c auth.Resolved) (any, error) {
	peer := !s.isSettingsHome()
	text, err := s.settings.EffectiveText()
	if err != nil {
		return nil, err
	}
	if c.Caller.IsAgent() {
		text = config.RedactText(text)
	}
	st := s.syncState()
	view := settingsView{Text: text, Local: config.LocalKeys, Home: st.Home, Stale: st.Stale, FetchedAt: st.FetchedAt}
	if peer {
		view.HomeWeb = st.HomeWeb
	}
	return view, nil
}

// mayAskSettings is src/daemon.ts mayAskSettings: only the chief of staff and the assistant may ask the human for a
// settings change. It returns the asker.
func (s *Server) mayAskSettings(ctx context.Context, c auth.Resolved) (db.Agent, error) {
	if c.Kind == auth.Agent {
		if a, err := s.db.GetAgent(ctx, c.Agent); err == nil && (s.chiefOfStaffID(ctx) == a.ID || s.isAssistant(ctx, a.ID)) {
			return a, nil
		}
	}
	return db.Agent{}, Errorf(http.StatusForbidden, "only the human can change stam's settings, %s. The chief of staff and the assistant can ask instead: the MCP tool settings_ask (PATCH /api/config/settings {patch}) sends the human an approval that applies the patch itself; any other agent asks its chief of staff", s.humanWays("stam"))
}

// askSettings is src/daemon.ts askSettingsChange with src/permissions.ts requestSettingsChange: the change is checked as
// the human's save would check it, and the human gets an approval with a diff in which every secret is hidden. Nothing
// is written until they approve (answerSettings). The answer is 202 with the request's id.
func (s *Server) askSettings(ctx context.Context, c auth.Resolved, change config.Change) (any, error) {
	me, err := s.mayAskSettings(ctx, c)
	if err != nil {
		return nil, err
	}
	if change.Kind != "patch" && utf16Len(change.Text) > 256*1024 {
		return nil, Errorf(http.StatusBadRequest, "the settings text is over 256 KB")
	}
	// On a non-home daemon the diff is against the settings it uses (S-398); the route has refused an ask that touches a
	// shared key.
	current, err := s.settings.EffectiveText()
	if err != nil {
		return nil, err
	}
	next, problem, err := config.ResultOf(change, current, s.registry())
	if err != nil {
		if problem != nil && problem.Field == "cost" {
			s.noteInvalidCost(problem.Problem)
		}
		return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
	}
	if !s.isSettingsHome() {
		// A non-home daemon writes only the change's local keys, so the diff shows only those.
		u, err := config.UnredactedChange(change, current)
		if err != nil {
			return nil, Errorf(http.StatusBadRequest, "%s", err.Error())
		}
		local, _ := config.SplitPatch(u, change.Kind == "patch" && change.Fill, s.settings.CachedSettings())
		next = config.WithLocalKeys(current, local)
	}
	// Secrets are redacted on both sides, so the mail never carries one.
	diff := config.UnifiedDiff(config.RedactText(current), config.RedactedForDiff(current, next), "settings now", "settings if approved")
	if diff == "" {
		diff = "No visible change (only redacted values differ, or none)."
	}
	payload := jsjson.Stringify(config.Payload(change, current), "")
	reason := me.Name + " wants to change stam's settings (secrets hidden in the diff below)" + config.KeyDestinationNotes(current, next)
	r, err := s.requestPermissionWith(ctx, me, "Change stam settings", reason, diff, false, "human", permExtra{payload: &payload, fence: "diff"})
	if err != nil {
		return nil, err
	}
	return withStatus{http.StatusAccepted, map[string]string{"requested": r.Text("id")}}, nil
}

// postSettings is POST /api/config/settings: the human's whole-file save. The text is saved once it parses and its cost
// config and harness section pass (fileProblem), with its MCP client secrets moved into the secret store; otherwise
// nothing is written. The answer is the text written, so it holds the references, not the secrets (TS echoes the text
// sent).
func (s *Server) postSettings(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	text := ""
	if v := getValue(w.body, "text"); v != nil {
		text = jsjson.ToString(v)
	}
	if !s.isSettingsHome() {
		return s.postPeerSettings(r, c, text)
	}
	if !s.trustedHuman(r) {
		return s.askSettings(r.Context(), c, config.Change{Kind: "post", Text: text})
	}
	parsed, err := jsjson.Parse([]byte(text))
	if err != nil {
		// A fixed message: the parser's may quote the text, which may hold a secret.
		return nil, Errorf(http.StatusBadRequest, "not valid JSON: the text does not parse")
	}
	if p := config.FileProblem(parsed, s.registry()); p != nil {
		return nil, s.refuseProblem(p)
	}
	before := s.settings.Get().PermissionModes
	if err := s.settings.Update(func(string) (string, error) {
		stored, err := s.storeMcpSecretsInText(text)
		text = stored
		return stored, err
	}); err != nil {
		return nil, err
	}
	s.settingsWritten(before, humanName)
	return map[string]string{"text": text}, nil
}

// postPeerSettings is POST /api/config/settings on a non-home daemon: only local keys change, through the same guards
// (S-398). The chief of staff's or the assistant's text holds the redacted values its GET showed: they count as unchanged.
func (s *Server) postPeerSettings(r *http.Request, c auth.Resolved, text string) (any, error) {
	human := s.trustedHuman(r)
	if !human {
		if _, err := s.mayAskSettings(r.Context(), c); err != nil {
			return nil, err
		}
	}
	parsed, err := jsjson.Parse([]byte(text))
	if err != nil {
		return nil, Errorf(http.StatusBadRequest, "not valid JSON: the text does not parse")
	}
	user, ok := parsed.(*jsjson.Object)
	if !ok {
		return nil, Errorf(http.StatusBadRequest, "the settings must be a JSON object")
	}
	if !human {
		change := config.Change{Kind: "post", Text: text}
		u, err := s.unredacted(change)
		if err != nil {
			return nil, err
		}
		if _, err := s.peerLocalOnly(u, false); err != nil {
			return nil, err
		}
		return s.askSettings(r.Context(), c, change)
	}
	local, err := s.peerLocalOnly(user, false)
	if err != nil {
		return nil, err
	}
	return s.writeLocal(local)
}

// writeLocal writes a non-home daemon's local keys and answers the settings it now uses.
func (s *Server) writeLocal(local *jsjson.Object) (any, error) {
	if err := s.settings.PatchLocal(local); err != nil {
		return nil, err
	}
	text, err := s.settings.EffectiveText()
	if err != nil {
		return nil, err
	}
	return map[string]string{"text": text}, nil
}

// patchSettings is PATCH /api/config/settings: the human's partial change (S-293), one read-modify-write of the file.
// A top-level key replaces its value; a view record merges per id. An invalid result writes nothing.
func (s *Server) patchSettings(r *http.Request, c auth.Resolved) (any, error) {
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	patchValue := getValue(w.body, "patch")
	patch, _ := patchValue.(*jsjson.Object)
	fill := getValue(w.body, "fill") == true
	if !s.trustedHuman(r) {
		if _, err := s.mayAskSettings(r.Context(), c); err != nil {
			return nil, err
		}
		if patch == nil {
			return nil, Errorf(http.StatusBadRequest, "the patch must be an object")
		}
		change := config.Change{Kind: "patch", Patch: patch, Fill: fill}
		// On a non-home daemon an ask about a shared key is refused before it is made (S-398).
		if !s.isSettingsHome() {
			u, err := s.unredacted(change)
			if err != nil {
				return nil, err
			}
			if _, err := s.peerLocalOnly(u, fill); err != nil {
				return nil, err
			}
		}
		return s.askSettings(r.Context(), c, change)
	}
	if patch == nil {
		return nil, Errorf(http.StatusBadRequest, "the patch must be an object")
	}
	if !s.isSettingsHome() {
		// A peer's own page sends the local part of a change here and the shared part to the home (S-414): with
		// localOnly, the shared keys in it are the home's business, not a refusal.
		local, _ := config.SplitPatch(patch, false, s.settings.CachedSettings())
		if getValue(w.body, "localOnly") != true {
			if local, err = s.peerLocalOnly(patch, fill); err != nil {
				return nil, err
			}
		}
		return s.writeLocal(local)
	}
	// A peer's page changes only shared settings here; the home keeps its own local keys (S-414). MCP servers name
	// commands every machine runs, so they change only on the home's own page.
	peerUI := fromPeerUI(r)
	if peerUI {
		if _, ok := patch.Get("mcpServers"); ok {
			return nil, Errorf(http.StatusForbidden, "MCP servers change only on %s's own page", s.cfg.Machine)
		}
		if !fill {
			patch = config.SharedPatch(patch)
		}
	}
	var text string
	var problem *config.Problem
	before := s.settings.Get().PermissionModes
	err = s.settings.Update(func(current string) (string, error) {
		next, p := patched(current, patch, fill, s.registry())
		if p != nil {
			problem = p
			return "", p
		}
		// The patch's MCP client secrets are stored only once it passes on its plain values (S-2767), so a refused patch
		// leaves the stored secret as it was; the text written holds the references, and is checked again as TS's
		// checkedPatchText does, so a refusal there writes nothing either.
		stored, err := s.storeMcpSecretsInPatch(patch, fill)
		if err != nil {
			return "", err
		}
		if stored != patch {
			if next, p = patched(current, stored, fill, s.registry()); p != nil {
				problem = p
				return "", p
			}
		}
		if peerUI {
			// Only the shared part is the peer's: a mixed key (itsa) never takes the peer's local values, and the answer
			// shows only the shared part.
			next = config.WithLocalKeys(next, config.LocalPart(config.ParseObject(current)))
			text = config.Text(config.SharedPart(config.ParseObject(next)))
			return next, nil
		}
		text = next
		return next, nil
	})
	if problem != nil {
		return nil, s.refuseProblem(problem)
	}
	if err != nil {
		return nil, err
	}
	s.settingsWritten(before, humanName)
	return map[string]string{"text": text}, nil
}

// patched is config.Patched; a test swaps it to refuse the second pass, which no real patch reaches.
var patched = config.Patched

// getValue is a body field, nil when the body is no object or lacks it.
func getValue(body *jsjson.Object, key string) jsjson.Value {
	v, _ := body.Get(key)
	return v
}

// refuseProblem is the 400 of an invalid settings file; a cost problem is mailed to the human too (noteInvalid).
func (s *Server) refuseProblem(p *config.Problem) error {
	if p.Field == "cost" {
		s.noteInvalidCost(p.Problem)
	}
	return Errorf(http.StatusBadRequest, "%s", p.Error())
}

// settingsWritten is what follows a write of the settings by `by`: a change to the permission modes since before is
// logged (src/permission-modes.ts noteSettingsChange), and a raised or removed budget lifts its stop now.
func (s *Server) settingsWritten(before config.PermissionModes, by string) {
	if s.life != nil {
		s.life.NotePermissionModes(context.Background(), before, by)
		s.life.EvaluateAllBudgets(time.Now(), "")
	}
}

// costInvalid is src/accounts.ts noteInvalid's state: the error last mailed, the one still waiting, and whether a
// mail is on its way.
type costInvalid struct {
	mu       sync.Mutex
	sent     string
	pending  string
	inFlight bool
}

// noteInvalidCost is src/accounts.ts noteInvalid: the human gets one mail per distinct invalid cost config; a failed
// send stays pending, and the next call retries it.
func (s *Server) noteInvalidCost(problem string) {
	s.costBad.mu.Lock()
	if problem != s.costBad.sent && problem != s.costBad.pending {
		s.costBad.pending = problem
	}
	if s.costBad.pending == "" || s.costBad.inFlight || s.tpl == nil {
		s.costBad.mu.Unlock()
		return
	}
	pending := s.costBad.pending
	s.costBad.inFlight = true
	s.costBad.mu.Unlock()
	if !s.goBg(func() {
		body, err := s.tpl.Render("cost-config-rejected", map[string]string{"error": pending}, "")
		ok := err == nil
		if ok {
			_, ok = s.sendFromSystemMail(context.Background(), "cost", []string{humanName}, "[stam] Cost config rejected", body)
		}
		s.costBad.mu.Lock()
		defer s.costBad.mu.Unlock()
		s.costBad.inFlight = false
		if ok && s.costBad.pending == pending {
			s.costBad.pending, s.costBad.sent = "", pending
		}
	}) {
		s.costBad.mu.Lock()
		s.costBad.inFlight = false
		s.costBad.mu.Unlock()
	}
}
