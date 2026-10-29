package lifecycle

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sync"

	"stam/internal/config"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// StaleAgent is src/permission-modes.ts StaleAgent: an agent that follows the settings and runs another mode than the
// settings now give it.
type StaleAgent struct {
	ID, Name, Harness string
	Type              *string
	Mode, Want        string
	// InPlace is false for an OpenCode agent, which takes the new mode at its next launch (switchesInPlace).
	InPlace bool
	// Failed is why its last switch failed, which left it shut down on its old mode; nil otherwise.
	Failed *string
}

// JSON is the agent as GET /api/permission-modes lists it.
func (s StaleAgent) JSON() *jsjson.Object {
	var typ, failed jsjson.Value
	if s.Type != nil {
		typ = *s.Type
	}
	if s.Failed != nil {
		failed = *s.Failed
	}
	return jsjson.NewObject("id", s.ID, "name", s.Name, "harness", s.Harness, "type", typ, "mode", s.Mode, "want", s.Want, "inPlace", s.InPlace, "failed", failed)
}

// effectiveMode is the mode the settings give the agent's harness and type.
func (l *Lifecycle) effectiveMode(a db.Agent) string {
	typ := ""
	if a.Type != nil {
		typ = *a.Type
	}
	return l.settings.Get().PermissionModes.EffectiveMode(a.Harness, typ)
}

// failedSwitch is src/permission-modes.ts failedSwitch: the error of the agent's last mode switch when that switch
// failed, else nil.
func (l *Lifecycle) failedSwitch(ctx context.Context, id string) (*string, error) {
	e, err := l.db.LatestEvent(ctx, id, []string{"permission-mode", "permission-mode:failed"})
	if err != nil || e == nil || e.Type != "permission-mode:failed" {
		return nil, err
	}
	data := "{}"
	if e.Data != nil {
		data = *e.Data
	}
	v, _ := jsjson.Parse([]byte(data))
	msg := "failed"
	if o, ok := v.(*jsjson.Object); ok {
		if x, ok := o.Get("error"); ok && x != nil {
			msg = jsjson.ToString(x)
		}
	}
	return &msg, nil
}

// StaleAgents is src/permission-modes.ts staleAgents: the agents that follow the settings and run another mode than
// the settings now give them, the running ones and the ones a failed switch left shut down.
func (l *Lifecycle) StaleAgents(ctx context.Context) ([]StaleAgent, error) {
	agents, err := l.db.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	var out []StaleAgent
	for _, a := range agents {
		want := l.effectiveMode(a)
		if permissionSource(a) != "settings" || string(a.PermissionMode) == want {
			continue
		}
		var failed *string
		if a.Lifecycle == "shut_down" {
			if failed, err = l.failedSwitch(ctx, a.ID); err != nil {
				return nil, err
			}
		}
		if !running(a) && failed == nil {
			continue
		}
		out = append(out, StaleAgent{ID: a.ID, Name: a.Name, Harness: a.Harness, Type: a.Type, Mode: string(a.PermissionMode), Want: want, InPlace: a.Harness != "opencode", Failed: failed})
	}
	return out, nil
}

// Applied is one agent apply switched; Skipped one it left, and why.
type (
	Applied struct{ Name, Mode, Result string }
	Skipped struct{ Name, Reason string }
)

type appliedEvent struct {
	From string `json:"from"`
	Mode string `json:"mode"`
	By   string `json:"by"`
}

// ApplyPermissionModes is src/daemon.ts applyPermissionModes: the agents that follow the settings switch to the mode
// the settings now give them, each at the end of its step, and an agent a failed switch left shut down resumes on it.
// An OpenCode agent keeps its session's rules, so it is left for its next session.
func (l *Lifecycle) ApplyPermissionModes(ctx context.Context, by string) ([]Applied, []Skipped, error) {
	stale, err := l.StaleAgents(ctx)
	if err != nil {
		return nil, nil, err
	}
	var skipped []Skipped
	var inPlace []StaleAgent
	for _, s := range stale {
		if s.InPlace {
			inPlace = append(inPlace, s)
		} else {
			skipped = append(skipped, Skipped{s.Name, fmt.Sprintf("%s keeps a session's permission rules; it starts in %s at its next new session", s.Harness, s.Want)})
		}
	}
	type outcome struct {
		result string
		err    error
	}
	results := make([]outcome, len(inPlace))
	var wg sync.WaitGroup
	for i, s := range inPlace {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, err := l.db.GetAgent(ctx, s.ID)
			if err != nil {
				results[i].err = err
				return
			}
			r, err := l.SetPermissionMode(ctx, a, s.Want, by, "settings", s.Failed != nil)
			if err == nil {
				l.event(ctx, a.ID, "permission-mode:applied", appliedEvent{From: s.Mode, Mode: s.Want, By: by})
			}
			results[i] = outcome{r, err}
		}()
	}
	wg.Wait()
	var applied []Applied
	for i, r := range results {
		if r.err != nil {
			skipped = append(skipped, Skipped{inPlace[i].Name, r.err.Error()})
		} else {
			applied = append(applied, Applied{inPlace[i].Name, inPlace[i].Want, r.result})
		}
	}
	return applied, skipped, nil
}

// NotePermissionModes is src/permission-modes.ts noteSettingsChange: a change to Settings › permission modes is logged
// with who made it and the agents it leaves on their old mode; an unchanged write logs nothing.
func (l *Lifecycle) NotePermissionModes(ctx context.Context, before config.PermissionModes, by string) {
	after := l.settings.Get().PermissionModes
	if reflect.DeepEqual(before.Harness, after.Harness) && reflect.DeepEqual(before.Types, after.Types) {
		return
	}
	stale, err := l.StaleAgents(ctx)
	if err != nil {
		stale = nil
	}
	names := []jsjson.Value{}
	for _, s := range stale {
		names = append(names, s.Name)
	}
	data := jsjson.NewObject("by", by, "before", before.JSON(), "after", after.JSON(), "stale", names)
	l.event(ctx, "human", "permission-modes", json.RawMessage(jsjson.Stringify(data, "")))
}
