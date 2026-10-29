package claude

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"stam/internal/api"
	"stam/internal/db"
	"stam/internal/jsjson"
)

// TestHookMatchesTS runs hook payloads through onHook in TS (src/adapters/claude.ts, in a test home) and in Go, and
// wants the same agent fields written, and the same tool and turn ends.
func TestHookMatchesTS(t *testing.T) {
	type state struct {
		Lifecycle string  `json:"lifecycle"`
		Activity  string  `json:"activity"`
		Detail    *string `json:"activity_detail"`
	}
	type tc struct {
		Agent   state           `json:"agent"`
		Payload json.RawMessage `json:"payload"`
	}
	working := state{"active", "working", nil}
	idle := state{"active", "idle", strp("turn finished")}
	starting := state{"active", "starting", strp("with prompt")}
	resuming := state{"active", "starting", strp("resuming")}
	compacting := state{"active", "working", strp("compacting (manual)")}
	paused := state{"paused", "idle", nil}
	cases := []tc{
		{starting, json.RawMessage(`{"hook_event_name":"SessionStart","session_id":"s-1","transcript_path":"/t/1.jsonl","source":"startup"}`)},
		{resuming, json.RawMessage(`{"hook_event_name":"SessionStart","session_id":"s-1","transcript_path":"/t/1.jsonl","source":"resume"}`)},
		{idle, json.RawMessage(`{"hook_event_name":"SessionStart","session_id":"s-2","source":"clear"}`)},
		{idle, json.RawMessage(`{"hook_event_name":"SessionStart","session_id":"","transcript_path":""}`)},
		{idle, json.RawMessage(`{"hook_event_name":"SessionStart","source":null}`)},
		{idle, json.RawMessage(`{"hook_event_name":"SessionStart","source":7}`)},
		{starting, json.RawMessage(`{"hook_event_name":"UserPromptSubmit","prompt":"hi"}`)},
		{idle, json.RawMessage(`{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}`)},
		{idle, json.RawMessage(`{"hook_event_name":"PreToolUse"}`)},
		{idle, json.RawMessage(`{"hook_event_name":"PreToolUse","tool_name":null}`)},
		{working, json.RawMessage(`{"hook_event_name":"PostToolUse","tool_name":"Bash"}`)},
		{working, json.RawMessage(`{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion"}`)},
		{working, json.RawMessage(`{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Which colour?","options":[{"label":"Red"},{"label":"Blue"}]}]},"session_id":"s-7"}`)},
		{idle, json.RawMessage(`{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Pick?","multiSelect":true,"options":[{"label":"A"}]}]},"session_id":null}`)},
		{working, json.RawMessage(`{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":null}`)},
		{working, json.RawMessage(`{"hook_event_name":"PermissionRequest","tool_name":"Read","tool_input":{"file_path":"/x"}}`)},
		{working, json.RawMessage(`{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"m"}`)},
		{working, json.RawMessage(`{"hook_event_name":"Notification","notification_type":"permission_prompt","session_id":"s-9"}`)},
		{working, json.RawMessage(`{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/x","description":"clean"},"session_id":"s-9"}`)},
		{working, json.RawMessage(`{"hook_event_name":"PermissionRequest","tool_name":"Write","session_id":null}`)},
		{working, json.RawMessage(`{"hook_event_name":"PermissionRequest","tool_input":{"url":"https://x"}}`)},
		{working, json.RawMessage(`{"hook_event_name":"PermissionRequest","tool_name":null,"tool_input":null}`)},
		{working, json.RawMessage(`{"hook_event_name":"Notification","notification_type":"elicitation_dialog"}`)},
		{idle, json.RawMessage(`{"hook_event_name":"Notification","notification_type":"idle_prompt"}`)},
		{working, json.RawMessage(`{"hook_event_name":"Notification","notification_type":"auth_success"}`)},
		{working, json.RawMessage(`{"hook_event_name":"Notification"}`)},
		{working, json.RawMessage(`{"hook_event_name":"Stop","last_assistant_message":"DONE"}`)},
		{working, json.RawMessage(`{"hook_event_name":"Stop","last_assistant_message":""}`)},
		{working, json.RawMessage(`{"hook_event_name":"Stop","last_assistant_message":42}`)},
		{working, json.RawMessage(`{"hook_event_name":"Stop"}`)},
		{working, json.RawMessage(`{"hook_event_name":"StopFailure","error":"rate_limit"}`)},
		{working, json.RawMessage(`{"hook_event_name":"StopFailure"}`)},
		{idle, json.RawMessage(`{"hook_event_name":"SessionEnd","reason":"logout"}`)},
		{idle, json.RawMessage(`{"hook_event_name":"SessionEnd","reason":"clear"}`)},
		{paused, json.RawMessage(`{"hook_event_name":"SessionEnd","reason":"other"}`)},
		{starting, json.RawMessage(`{"hook_event_name":"SessionEnd","reason":"other"}`)},
		{compacting, json.RawMessage(`{"hook_event_name":"SessionEnd","reason":"other"}`)},
		{working, json.RawMessage(`{"hook_event_name":"PreCompact","trigger":"auto"}`)},
		{working, json.RawMessage(`{"hook_event_name":"PreCompact"}`)},
		{compacting, json.RawMessage(`{"hook_event_name":"PostCompact"}`)},
		{working, json.RawMessage(`{"hook_event_name":"SubagentStop"}`)},
		{working, json.RawMessage(`{}`)},
	}
	home := filepath.Join(t.TempDir(), "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	in, _ := json.Marshal(cases)
	cmd := exec.Command("node", "testdata/ts-hook.mjs", home)
	cmd.Stdin = strings.NewReader(string(in))
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("ts-hook.mjs: %v\n%s", err, stderr.String())
	}
	type result struct {
		Fields    map[string]any `json:"fields"`
		AfterTool bool           `json:"afterTool"`
		TurnEnded bool           `json:"turnEnded"`
		Dialog    *Dialog        `json:"dialog"`
	}
	var want []result
	if err := json.Unmarshal(out, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(cases) {
		t.Fatalf("TS answered %d cases of %d", len(want), len(cases))
	}
	for i, c := range cases {
		p, err := jsjson.Parse(c.Payload)
		if err != nil {
			t.Fatal(err)
		}
		po, _ := p.(*jsjson.Object)
		a := db.Agent{ID: "ahook", Lifecycle: api.AgentLifecycle(c.Agent.Lifecycle), Activity: api.AgentActivity(c.Agent.Activity), ActivityDetail: c.Agent.Detail}
		r := OnHook(a, po, func() (string, bool) { return "", false })
		// As go/internal/lifecycle OnHook turns the result into the agent's fields.
		got := result{Fields: map[string]any{}, AfterTool: r.AfterTool, TurnEnded: r.TurnEnded, Dialog: r.Dialog}
		if r.Activity != "" {
			got.Fields["activity"] = r.Activity
		}
		if r.SetDetail {
			if r.Detail == nil {
				got.Fields["activity_detail"] = nil
			} else {
				got.Fields["activity_detail"] = *r.Detail
			}
		}
		if r.SessionID != "" {
			got.Fields["session_id"] = r.SessionID
		}
		if r.TranscriptPath != "" {
			got.Fields["transcript_path"] = r.TranscriptPath
		}
		if r.LastMessage != "" {
			got.Fields["last_message"] = r.LastMessage
		}
		if !reflect.DeepEqual(got, want[i]) {
			t.Errorf("case %d %s on %+v:\n Go %+v\n TS %+v", i, c.Payload, c.Agent, got, want[i])
		}
	}
}

// TestHookPendingDialog: a tool event while a dialog waits leaves the agent blocked on it, and the dialog is asked
// about only for the tool events.
func TestHookPendingDialog(t *testing.T) {
	asked := 0
	pending := func() (string, bool) { asked++; return `{"tool":"Read","input":{"file_path":"/x"}}`, true }
	a := db.Agent{Lifecycle: "active", Activity: "blocked"}
	parse := func(s string) *jsjson.Object {
		v, err := jsjson.Parse([]byte(s))
		if err != nil {
			t.Fatal(err)
		}
		return v.(*jsjson.Object)
	}
	if r := OnHook(a, parse(`{"hook_event_name":"PreToolUse","tool_name":"Bash"}`), pending); !reflect.DeepEqual(r, HookResult{}) {
		t.Errorf("PreToolUse with a dialog = %+v, want nothing", r)
	}
	if r := OnHook(a, parse(`{"hook_event_name":"PostToolUse","tool_name":"Bash"}`), pending); !reflect.DeepEqual(r, HookResult{AfterTool: true}) {
		t.Errorf("PostToolUse with a dialog = %+v, want only the tool end", r)
	}
	// The dialog's own tool finishing says it was answered in the terminal; another target or tool doesn't.
	if r := OnHook(a, parse(`{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/x"}}`), pending); r.Activity != "working" || !r.AfterTool {
		t.Errorf("PostToolUse of the dialog's own tool = %+v, want working", r)
	}
	if r := OnHook(a, parse(`{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/y"}}`), pending); r.Activity != "" {
		t.Errorf("PostToolUse of another target = %+v, want nothing", r)
	}
	// A Notification's dialog names no tool: it waits for the turn to end.
	noTool := func() (string, bool) { return `{"message":"m"}`, true }
	if r := OnHook(a, parse(`{"hook_event_name":"PostToolUse","tool_name":"Read","tool_input":{"file_path":"/x"}}`), noTool); r.Activity != "" {
		t.Errorf("PostToolUse with a Notification's dialog = %+v, want nothing", r)
	}
	OnHook(a, parse(`{"hook_event_name":"Stop"}`), pending)
	if asked != 4 {
		t.Errorf("the dialog was asked about %d times, want 4", asked)
	}
}

// TestStopFailureSignal: StopFailure's cost signal by its error, as src/adapters/claude.ts CLAUDE_ERROR_CLASS classes
// it; an error no class covers, a null one and none are no signal.
func TestStopFailureSignal(t *testing.T) {
	for payload, want := range map[string]string{
		`{"hook_event_name":"StopFailure","error":"rate_limit"}`:            "limit:rate_limit",
		`{"hook_event_name":"StopFailure","error":"billing_error"}`:         "credits:billing_error",
		`{"hook_event_name":"StopFailure","error":"oauth_org_not_allowed"}`: "auth:oauth_org_not_allowed",
		`{"hook_event_name":"StopFailure","error":"server_error"}`:          "transient:server_error",
		`{"hook_event_name":"StopFailure","error":"max_output_tokens"}`:     "",
		`{"hook_event_name":"StopFailure","error":null}`:                    "",
		`{"hook_event_name":"StopFailure"}`:                                 "",
		`{"hook_event_name":"Stop","error":"rate_limit"}`:                   "",
	} {
		v, err := jsjson.Parse([]byte(payload))
		if err != nil {
			t.Fatal(err)
		}
		r := OnHook(db.Agent{}, v.(*jsjson.Object), func() (string, bool) { return "", false })
		got := ""
		if r.CostSignal != nil {
			got = r.CostSignal.Class + ":" + r.CostSignal.Error
		}
		if got != want {
			t.Errorf("%s: %q, want %q", payload, got, want)
		}
	}
}
