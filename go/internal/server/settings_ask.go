package server

import (
	"context"
	"errors"
	"fmt"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsfmt"
	"stam/internal/jsjson"
)

// errNotApplied stops a settings write whose approval can't be applied; result says why.
var errNotApplied = errors.New("not applied")

// answerSettings is src/permissions.ts answerSettings: only the human approves a settings change; anyone who may answer
// can deny it. An approval applies the change as the human's own save would, in the same read-modify-write, unless what
// it touches changed since the ask or it no longer passes the checks. A non-home daemon writes only the change's local
// keys, and applies nothing when it would change a shared one (S-398). An approval that isn't applied is recorded as
// denied, so the list never says a change happened that didn't. A registry change is applied on the settings home only,
// unless registry.json changed since the ask (answerRegistry).
func (s *Server) answerSettings(ctx context.Context, r db.PermissionRequest, a db.Agent, approve bool, by, text, who string) (jsfmt.Value, error) {
	if approve && by != humanBox {
		return jsfmt.Value{}, errors.New("only the human approves a change to stam's settings; deny it, or leave it to the human")
	}
	result, applied := "denied", false
	if approve {
		parsed, err := jsjson.Parse([]byte(*r.Payload))
		payload, ok := parsed.(*jsjson.Object)
		if err != nil || !ok {
			return jsfmt.Value{}, fmt.Errorf("request %s holds a payload that isn't a JSON object", r.ID)
		}
		raw, _ := payload.Get("change")
		ro, _ := raw.(*jsjson.Object)
		kind, _ := ro.Get("kind")
		change, ok := config.ParseChange(raw)
		home := s.isSettingsHome()
		switch {
		case kind == "registry":
			rt, _ := ro.Get("text")
			t, isStr := rt.(string)
			if !isStr {
				return jsfmt.Value{}, fmt.Errorf("request %s holds a registry change with no text", r.ID)
			}
			if result, applied, err = s.answerRegistry(payload, t); err != nil {
				return jsfmt.Value{}, err
			}
		case !ok:
			return jsfmt.Value{}, fmt.Errorf("request %s holds a change this daemon can't read", r.ID)
		default:
			if result, applied, err = s.applySettingsAnswer(payload, change, home, a.Name+", approved by "+by); err != nil {
				return jsfmt.Value{}, err
			}
		}
	}
	// The change is written before the request is decided. A withdrawal in between (forgetAgentOn, when the asker is
	// forgotten) leaves the human's approved change written and this answer a not-pending error; TS runs both in one
	// turn of its event loop, so it has no such window. It is a few statements wide, and the change is one the human
	// approved, so nothing is written that they didn't.
	decided, err := s.db.DecidePermissionRequest(ctx, r.ID, applied, by, text, nil)
	if err != nil {
		return jsfmt.Value{}, err
	}
	if !decided {
		return jsfmt.Value{}, s.notPending(ctx, r.ID)
	}
	notice, err := s.render("permission-settings", map[string]string{"id": r.ID, "result": result, "who": who, "note": text})
	if err != nil {
		return jsfmt.Value{}, err
	}
	s.queueNotice(ctx, a.ID, notice)
	if err := s.db.AddEvent(ctx, a.ID, "permission:answered", answeredEvent{ID: r.ID, Approve: applied, By: by, Typed: false}); err != nil {
		return jsfmt.Value{}, err
	}
	s.orgResync(ctx, a.ID)
	return s.publicRequest(ctx, r.ID)
}

// applySettingsAnswer applies an approved settings change as the human's own save would, in one read-modify-write,
// unless what it touches changed since the ask or it no longer passes the checks. It returns the result the asker is
// told and whether it was applied. noteBy names the change in the permission-modes log.
func (s *Server) applySettingsAnswer(payload *jsjson.Object, change config.Change, home bool, noteBy string) (string, bool, error) {
	result := "approved and applied"
	before := s.settings.Get().PermissionModes
	err := s.settings.Update(func(file string) (string, error) {
		current := s.settings.EffectiveFrom(file)
		if !config.UnchangedSince(payload, change, current) {
			result = "approved, but not applied: a setting it changes changed after you asked, so read the settings again and ask again"
			return "", errNotApplied
		}
		next, problem, err := config.ResultOf(change, current, s.registry())
		if err != nil {
			if problem != nil && problem.Field == "cost" {
				s.noteInvalidCost(problem.Problem)
			}
			result = "approved, but not applied: " + err.Error()
			return "", errNotApplied
		}
		if !home {
			// A non-home daemon splits the change itself, as its route did when the agent asked.
			u, err := config.UnredactedChange(change, current)
			if err != nil {
				result = "approved, but not applied: " + err.Error()
				return "", errNotApplied
			}
			local, shared := config.SplitPatch(u, change.Kind == "patch" && change.Fill, s.settings.CachedSettings())
			if shared.Len() > 0 {
				result = "approved, but not applied: shared settings live on " + s.settings.Get().Home + "; change them there"
				return "", errNotApplied
			}
			return config.WithLocalKeys(file, local), nil
		}
		// As the human's whole-file save: the MCP client secrets move into the secret store, and a store that refuses
		// writes nothing.
		stored, err := s.storeMcpSecretsInText(next)
		if err != nil {
			result = "approved, but not applied: " + err.Error()
			return "", errNotApplied
		}
		return stored, nil
	})
	switch {
	case err == nil:
		if home {
			s.settingsWritten(before, noteBy)
		}
		return result, true, nil
	case errors.Is(err, errNotApplied):
		return result, false, nil
	}
	return "", false, err
}
