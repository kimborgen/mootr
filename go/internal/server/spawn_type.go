package server

import (
	"context"
	"net/http"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"stam/internal/jsjson"
	"stam/internal/process"
)

// Spawning by agent type (src/daemon.ts spawnAgentIn, src/agent-types.ts, S-3782 6d): a type sets the preset (harness,
// model, effort), role, visibility, child notices, standing and brief of the agent; anything the spawn gives explicitly
// wins, and another harness drops the type's model and effort.

// spawnType is src/agent-types.ts agentType: the registry's type, or a 400.
func (s *Server) spawnType(name string) (*jsjson.Object, error) {
	types, _ := s.registry().Get("types")
	t, _ := at(types, name)
	o, ok := t.(*jsjson.Object)
	if !ok {
		return nil, Errorf(http.StatusBadRequest, "no agent type %s; see stam registry", name)
	}
	return o, nil
}

// at is `v?.[k]`.
func at(v jsjson.Value, k string) (jsjson.Value, bool) {
	o, _ := v.(*jsjson.Object)
	return o.Get(k)
}

// typeWantsWorktree is src/workspace.ts typeWantsWorktree: the type defaults its agents to a worktree of their own.
func typeWantsWorktree(t *jsjson.Object) bool {
	w, _ := t.Get("worktree")
	rv, _ := t.Get("review")
	return w == true || jsjson.Truthy(rv)
}

// inGitRepo is src/workspace.ts inGitRepo: dir is inside a git working tree.
func inGitRepo(ctx context.Context, dir string) bool {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "--show-toplevel")
	cmd.WaitDelay = time.Second
	return cmd.Run() == nil
}

var briefVar = regexp.MustCompile(`\{\{(\w+)\}\}`)

// renderBrief is src/agent-types.ts renderBrief: the type's brief with its {{vars}} filled in (an unknown one empty),
// trimmed, or the task alone when the type has none. Without a task there is no brief (false), so an agent spawned idle
// stays idle. nextSteps gives {{next_steps}} when the spawn passes none.
func renderBrief(t *jsjson.Object, vars map[string]string, nextSteps func() string) (string, bool) {
	if vars["task"] == "" {
		return "", false
	}
	b, _ := t.Get("brief")
	if !jsjson.Truthy(b) {
		return vars["task"], true
	}
	brief := jsjson.ToString(b)
	if strings.Contains(brief, "{{next_steps}}") {
		ns, ok := vars["next_steps"]
		if !ok {
			ns = nextSteps()
		}
		brief = strings.Replace(brief, "{{next_steps}}", ns, 1)
	}
	return jsjson.Trim(briefVar.ReplaceAllStringFunc(brief, func(m string) string { return vars[m[2:len(m)-2]] })), true
}

// typeNextSteps is src/process-brief-fallback.ts nextSteps: the type's lane steps from the loaded processes, else the
// fallback prose.
func (s *Server) typeNextSteps(typ string) string {
	loaded, err := s.processesHere()
	if err != nil {
		return process.FallbackNextSteps(typ)
	}
	return process.NextSteps(loaded.Processes, typ)
}

// briefVars is a spawn's brief_vars, each value as String(v); none when it isn't an object.
func briefVars(v jsjson.Value) map[string]string {
	out := map[string]string{}
	if o, ok := v.(*jsjson.Object); ok {
		for _, k := range o.Keys() {
			x, _ := o.Get(k)
			out[k] = jsjson.ToString(x)
		}
	}
	return out
}

// textOrNil is a text column's value: NULL for "".
func textOrNil(s string) any {
	if s == "" {
		return nil
	}
	return s
}
