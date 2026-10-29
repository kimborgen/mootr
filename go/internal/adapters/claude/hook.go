package claude

import (
	"strings"
	"time"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// HookResult is what one Claude Code hook says about the agent (src/adapters/types.ts HookResult): the activity and its
// detail to set, the session it reports, the turn's last message, and whether a tool call or the turn just ended.
type HookResult struct {
	// Activity is the activity to set, "" for none.
	Activity string
	// Detail is the activity detail to set (nil sets NULL) when SetDetail is true.
	Detail    *string
	SetDetail bool
	// SessionID and TranscriptPath are the session the hook reports, "" when it reports none.
	SessionID, TranscriptPath string
	// LastMessage is the turn's last assistant message, "" for none.
	LastMessage string
	AfterTool   bool
	TurnEnded   bool
	// Waits is what the hook does to the agent's hook waits (background jobs and session crons).
	Waits HookWaits
	// Dialog is the harness dialog that blocks the agent, nil for none.
	Dialog *Dialog
	// CostSignal is the cost signal a StopFailure reports (src/adapters/claude.ts costSignal), nil for none.
	CostSignal *CostSignal
}

// CostSignal is a provider error the cost policy acts on: its class (limit, credits, auth or transient) and the
// harness's error value.
type CostSignal struct {
	Class, Error string
}

// errorClass is src/adapters/claude.ts CLAUDE_ERROR_CLASS: StopFailure's error values the cost policy acts on.
// max_output_tokens, invalid_request, model_not_found and unknown are none.
var errorClass = map[string]string{
	"rate_limit":             "limit",
	"billing_error":          "credits",
	"authentication_failed":  "auth",
	"oauth_org_not_allowed":  "auth",
	"account_on_hold":        "auth",
	"verification_required":  "auth",
	"cloud_credential_error": "auth",
	"overloaded":             "transient",
	"server_error":           "transient",
}

// now is the clock a Stop's one-shot timers count from.
var now = time.Now

func set(activity string, detail *string) HookResult {
	return HookResult{Activity: activity, Detail: detail, SetDetail: true}
}

func strp(s string) *string { return &s }

// OnHook is src/adapters/claude.ts onHook for one payload: what the event means for the agent. pendingDialog gives the
// details of the harness dialog that waits for an answer (src/db.ts pendingDialog), asked only for the tool events.
//
// Ported: every event's activity, detail, session and turn end, the waits the hooks keep (background jobs and session
// crons), the dialogs a PermissionRequest or a permission Notification reports, and StopFailure's cost signal. Not yet:
// the account probe's turn, and the cold-cache mark after a compaction.
func OnHook(a db.Agent, p *jsjson.Object, pendingDialog func() (string, bool)) HookResult {
	event, _ := get(p, "hook_event_name").(string)
	switch event {
	case "SessionStart":
		r := HookResult{SessionID: truthyText(get(p, "session_id")), TranscriptPath: truthyText(get(p, "transcript_path"))}
		if src := get(p, "source"); src == "startup" || src == "resume" {
			r.Waits.Clear = true
		}
		if a.Activity == "starting" && a.ActivityDetail != nil && *a.ActivityDetail == "with prompt" {
			return r
		}
		// S-3250: a launch's SessionStart that lands late (it retried while the daemon restarted), after reconcile
		// settled the agent and a turn began, doesn't end that turn.
		src := get(p, "source")
		if (src == "startup" || src == "resume") && (a.Activity == "working" || a.Activity == "blocked") {
			return r
		}
		source := "start"
		if src != nil {
			source = JSString(src)
		}
		r.Activity, r.Detail, r.SetDetail = "idle", strp("session "+source), true
		return r
	case "UserPromptSubmit":
		r := set("working", nil)
		if prompt, ok := get(p, "prompt").(string); ok {
			r.Waits.Prompt = &prompt
		}
		return r
	case "PreToolUse":
		// A tool the model runs in parallel starts while a dialog waits; the agent stays blocked on the dialog (S-320).
		if _, ok := pendingDialog(); ok {
			return HookResult{}
		}
		return set("working", strp("tool "+tmpl(p, "tool_name")))
	case "PostToolUse":
		// Only the dialog's own tool finishing says the dialog was answered (yes, in the terminal).
		if waitsOnOtherDialog(p, pendingDialog) {
			return HookResult{AfterTool: true}
		}
		r := set("working", nil)
		r.AfterTool = true
		return r
	case "PermissionRequest":
		action, state := "Claude Code asks to allow "+tmpl(p, "tool_name"), "permission "+tmpl(p, "tool_name")
		// A question's dialog is an ask too: its card shows the question and options, and the human's choice is typed back
		// (S-3978). Auto mode still shows some dialogs, such as a read outside the working directories.
		if get(p, "tool_name") == "AskUserQuestion" {
			action, state = "Claude Code asks a question", "question"
		}
		r := set("blocked", strp(state))
		input := get(p, "tool_input")
		if input == nil {
			input = jsjson.NewObject()
		}
		details := jsjson.NewObject("tool", get(p, "tool_name"), "input", input, "session", hookSession(a, p))
		if _, ok := p.Get("tool_name"); !ok {
			details = jsjson.NewObject("input", input, "session", hookSession(a, p))
		}
		r.Dialog = &Dialog{Action: action, Details: jsjson.Stringify(details, ""), Replaces: true}
		return r
	case "Notification":
		kind := get(p, "notification_type")
		switch {
		case kind == "permission_prompt":
			// Claude Code also sends this for a dialog no PermissionRequest announced.
			r := set("blocked", strp("permission prompt"))
			msg := get(p, "message")
			if msg == nil {
				msg = ""
			}
			r.Dialog = &Dialog{Action: "Claude Code shows a permission dialog", Details: jsjson.Stringify(jsjson.NewObject("message", msg, "session", hookSession(a, p)), "")}
			return r
		case strings.HasPrefix(nullishText(kind), "elicitation"):
			return set("blocked", strp("elicitation"))
		case kind == "idle_prompt":
			return set("idle", strp("waiting for input"))
		}
		return HookResult{}
	case "Stop":
		r := set("idle", strp("turn finished"))
		r.TurnEnded = true
		r.Waits.Jobs, r.Waits.Timers = stopWaits(p, now())
		if v := get(p, "last_assistant_message"); jsjson.Truthy(v) {
			r.LastMessage = JSString(v)
		}
		return r
	case "StopFailure":
		e := "unknown error"
		if v := get(p, "error"); v != nil {
			e = JSString(v)
		}
		r := set("errored", strp(e))
		// CLAUDE_ERROR_CLASS[String(p.error)]: an absent or null error has no class.
		if v := get(p, "error"); v != nil {
			if cls := errorClass[JSString(v)]; cls != "" {
				r.CostSignal = &CostSignal{Class: cls, Error: JSString(v)}
			}
		}
		return r
	case "SessionEnd":
		// SessionEnd also fires on /clear, which starts a new session in the same harness, and a harness stam takes down
		// itself keeps the state stam gave it. Any other reason ends the harness.
		if get(p, "reason") == "clear" || a.Lifecycle != "active" || a.Activity == "starting" ||
			(a.ActivityDetail != nil && strings.HasPrefix(*a.ActivityDetail, "compacting")) {
			return HookResult{}
		}
		return set("unknown", strp(db.SessionEnded))
	case "PreCompact":
		return set("working", strp("compacting ("+tmpl(p, "trigger")+")"))
	case "PostCompact":
		r := set("idle", strp("compacted"))
		r.TurnEnded = true
		return r
	}
	return HookResult{}
}

// StatusLine is what a status-line report says about the agent (src/adapters/claude.ts onStatusLine): its context size
// and window, nil when the report doesn't give one, its session, and what the usage tables read: the session's cost and
// the subscription windows. The token totals and the cache window come from the transcript (Transcripts).
type StatusLine struct {
	// ContextTokens is the size, nil when unknown.
	ContextTokens jsjson.Value
	// ContextWindow is context_window_size as the report gives it, when HasWindow (null included, as TS's
	// `!== undefined` counts it).
	ContextWindow jsjson.Value
	HasWindow     bool
	// Session is the report's transcript_path, the session's identity, when it is a string; HasSession is false when
	// the report gives none (missing or null), and the agent's own transcript path stands in, as TS's `??` does.
	Session    string
	HasSession bool
	// Cost is cost.total_cost_usd, the session's cost so far, when it is a number.
	Cost *float64
	// RateLimits is rate_limits, the subscription windows (five_hour, seven_day), nil when the report has none.
	RateLimits jsjson.Value
}

// OnStatusLine reads a status-line payload. Before its first model call the usage is missing or all zeros: the size is
// unknown (nil), not 0.
func OnStatusLine(p *jsjson.Object) StatusLine {
	cw, _ := get(p, "context_window").(*jsjson.Object)
	var out StatusLine
	if tp := get(p, "transcript_path"); tp != nil {
		out.Session, _ = tp.(string)
		out.HasSession = true
	}
	cost, _ := get(p, "cost").(*jsjson.Object)
	if n, ok := get(cost, "total_cost_usd").(float64); ok {
		out.Cost = &n
	}
	out.RateLimits = get(p, "rate_limits")
	if cw == nil {
		return out
	}
	if u, _ := cw.Get("current_usage"); jsjson.Truthy(u) {
		uo, _ := u.(*jsjson.Object)
		sum := 0.0
		for _, k := range []string{"input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"} {
			if n, ok := get(uo, k).(float64); ok {
				sum += n
			}
		}
		if sum != 0 {
			out.ContextTokens = sum
		}
	}
	out.ContextWindow, out.HasWindow = cw.Get("context_window_size")
	return out
}

// get is o[key], nil when o is nil or lacks key.
// hookSession is `p.session_id ?? agent.session_id`, null when neither is set.
func hookSession(a db.Agent, p *jsjson.Object) jsjson.Value {
	if v := get(p, "session_id"); v != nil {
		return v
	}
	if a.SessionID != nil {
		return *a.SessionID
	}
	return nil
}

// waitsOnOtherDialog is src/adapters/claude.ts waitsOnOtherDialog: a pending dialog request is for another call than
// this hook's tool, so the dialog still waits. A dialog request with no tool (a Notification's) waits for the turn to end.
func waitsOnOtherDialog(p *jsjson.Object, pendingDialog func() (string, bool)) bool {
	details, ok := pendingDialog()
	if !ok {
		return false
	}
	d := DialogDetails(details)
	name, isStr := get(p, "tool_name").(string)
	input, _ := get(p, "tool_input").(*jsjson.Object)
	// Two tools that aren't strings (both missing, say) are the same, as undefined === undefined.
	sameTool := d.HasTool == isStr && d.Tool == name
	return !sameTool || DialogTarget(d.Input) != DialogTarget(input)
}

func get(o *jsjson.Object, key string) jsjson.Value {
	if o == nil {
		return nil
	}
	v, _ := o.Get(key)
	return v
}

// JSString is JavaScript's String(v) for a parsed JSON value: a string as is, null and a missing value as
// "null"/"undefined" (both nil here, read as "undefined"), numbers and booleans printed, an object "[object Object]"
// and an array its items joined by commas.
func JSString(v jsjson.Value) string {
	switch x := v.(type) {
	case nil:
		return "undefined"
	case string:
		return x
	case bool:
		if x {
			return "true"
		}
		return "false"
	case float64:
		return jsjson.Number(x)
	case []jsjson.Value:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = JSString(e)
			}
		}
		return strings.Join(parts, ",")
	case *jsjson.Object:
		return "[object Object]"
	}
	return jsjson.Stringify(v, "")
}

// tmpl is `${o[key]}`: "undefined" for a missing key, "null" for null.
func tmpl(o *jsjson.Object, key string) string {
	if o == nil {
		return "undefined"
	}
	v, ok := o.Get(key)
	if !ok {
		return "undefined"
	}
	if v == nil {
		return "null"
	}
	return JSString(v)
}

// truthyText is v as text when it is truthy, else "".
func truthyText(v jsjson.Value) string {
	if !jsjson.Truthy(v) {
		return ""
	}
	return JSString(v)
}

// nullishText is String(v ?? ”): "" for a missing value.
func nullishText(v jsjson.Value) string {
	if v == nil {
		return ""
	}
	return JSString(v)
}

// InTurnNotice is src/adapters/claude.ts inTurnNotice: the PostToolUse hook's answer that hands the notice to the model
// as additional context.
func InTurnNotice(text string) string {
	return jsjson.Stringify(jsjson.NewObject("hookSpecificOutput", jsjson.NewObject("hookEventName", "PostToolUse", "additionalContext", text)), "")
}
