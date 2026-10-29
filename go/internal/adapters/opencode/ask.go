package opencode

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"stam/internal/jsjson"
)

// An OpenCode ask (S-3980, src/adapters/opencode.ts): a permission.asked event is a harness dialog in the human's
// thread, answered through the session's permission reply endpoint, never the TUI.

// Ask is an ask's details as the request row keeps them (TS OpenCodeAsk): the permission it was raised for, the session
// that asked, and the action.
type Ask struct {
	Permission string
	Session    string
	Action     string
}

// AskOf is src/adapters/opencode.ts askOf: the ask a request's details name, empty for details that don't parse.
func AskOf(details string) Ask {
	v, err := jsjson.Parse([]byte(details))
	if err != nil {
		return Ask{}
	}
	o, _ := v.(*jsjson.Object)
	str := func(k string) string { s, _ := ocGet(o, k).(string); return s }
	return Ask{Permission: str("permission"), Session: str("session"), Action: str("action")}
}

// AskDialog is the ask a permission.asked event raises: its action text and its details, in TS's shape and key order
// (`{tool, input, action, permission, session}`), so a row TS wrote and one Go writes for the same event match. The
// requested resources go in verbatim, as the agent asked for them, as input.command for a shell action and
// input.pattern otherwise: the human approves exactly that (S-3980). Nothing else of the event goes in. Unlike TS, an
// action stam doesn't know is no action (S-4237): the server's text reaches neither the action nor the details. ok is
// false for an event with no permission id.
func AskDialog(data *jsjson.Object) (action, details string, ok bool) {
	id, _ := ocGet(data, "id").(string)
	if id == "" {
		return "", "", false
	}
	act, _ := ocGet(data, "action").(string)
	if !KnownPermissionAction(act) {
		act = ""
	}
	switch act {
	case "question":
		action = "OpenCode asks a question"
	case "":
		action = "OpenCode asks to allow an action"
	default:
		action = "OpenCode asks to allow " + act
	}
	var resources []string
	if list, ok := ocGet(data, "resources").([]jsjson.Value); ok {
		for _, r := range list {
			if s, ok := r.(string); ok {
				resources = append(resources, s)
			}
		}
	}
	key := "pattern"
	if act == "shell" {
		key = "command"
	}
	sid, _ := ocGet(data, "sessionID").(string)
	fields := []any{"tool", act, "input", jsjson.NewObject(key, strings.Join(resources, "\n")), "action", act, "permission", id}
	if sid != "" {
		fields = append(fields, "session", sid)
	}
	return action, jsjson.Stringify(jsjson.NewObject(fields...), ""), true
}

// ErrSessionGone is a permission listing's 404: the server no longer has the session.
var ErrSessionGone = errors.New("OpenCode no longer has the session")

// Pending is whether the session still lists the permission as pending (GET /api/session/SESSION/permission): a 404 is
// ErrSessionGone, any other failure its error, which is never read as not pending.
func (s *Server) Pending(ctx context.Context, sid, pid string) (bool, error) {
	v, err := s.Call(ctx, "GET", "/api/session/"+url.PathEscape(sid)+"/permission", nil)
	var ce *CallError
	if errors.As(err, &ce) && ce.Status == http.StatusNotFound {
		return false, ErrSessionGone
	}
	if err != nil {
		return false, err
	}
	list, _ := v.([]jsjson.Value)
	for _, p := range list {
		o, _ := p.(*jsjson.Object)
		if id, _ := ocGet(o, "id").(string); id == pid {
			return true, nil
		}
	}
	return false, nil
}

// PendingAsk is one permission a session lists as pending, as the ask raised for it: the permission, the action text and
// the details (AskDialog's), made of the listing's id, session, action and resources only.
type PendingAsk struct{ Permission, Action, Details string }

// PendingAsks is the session's pending permissions in the order the server lists them (GET /api/session/SESSION/permission,
// shaped as test/fixtures/opencode-permissions.json records it from OpenCode 2.0.26): a 404 is ErrSessionGone, any other
// failure its error. An item with no id is left out. The item's own `sessionID` is the ask's session; one that names
// another session than sid is left out too.
func (s *Server) PendingAsks(ctx context.Context, sid string) ([]PendingAsk, error) {
	v, err := s.Call(ctx, "GET", "/api/session/"+url.PathEscape(sid)+"/permission", nil)
	var ce *CallError
	if errors.As(err, &ce) && ce.Status == http.StatusNotFound {
		return nil, ErrSessionGone
	}
	if err != nil {
		return nil, err
	}
	list, _ := v.([]jsjson.Value)
	var out []PendingAsk
	for _, p := range list {
		o, _ := p.(*jsjson.Object)
		if own, _ := ocGet(o, "sessionID").(string); own != "" && own != sid {
			continue
		}
		action, details, ok := AskDialog(o)
		if !ok {
			continue
		}
		out = append(out, PendingAsk{Permission: AskOf(details).Permission, Action: action, Details: details})
	}
	return out, nil
}

// Reply answers the session's permission: once for a yes, reject for a no.
func (s *Server) Reply(ctx context.Context, sid, pid string, approve bool) error {
	decision := "reject"
	if approve {
		decision = "once"
	}
	_, err := s.Call(ctx, "POST", "/api/session/"+url.PathEscape(sid)+"/permission/"+url.PathEscape(pid)+"/reply", jsjson.NewObject("decision", decision))
	return err
}
