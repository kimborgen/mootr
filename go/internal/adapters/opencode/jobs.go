package opencode

import (
	"context"
	"net/url"

	"stam/internal/jsjson"
)

// What the server runs for an agent besides its own turn (src/adapters/opencode.ts readJobs, S-4237): background shells
// and child sessions (sub-agents), read when the event stream connects.

// Shell is a running shell: its id, the session that started it and its command.
type Shell struct{ ID, Session, Command string }

// Child is a child session: its id and title (its id when the server sends none).
type Child struct{ ID, Title string }

// RunningShells is the shells the server runs in dir (GET /api/shell?location[directory]=DIR): those with the status
// running and a session.
func (s *Server) RunningShells(ctx context.Context, dir string) ([]Shell, error) {
	q := url.Values{"location[directory]": {dir}}
	v, err := s.Call(ctx, "GET", "/api/shell?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	list, _ := v.([]jsjson.Value)
	var out []Shell
	for _, e := range list {
		o, _ := e.(*jsjson.Object)
		meta, _ := ocGet(o, "metadata").(*jsjson.Object)
		id, _ := ocGet(o, "id").(string)
		status, _ := ocGet(o, "status").(string)
		session, _ := ocGet(meta, "sessionID").(string)
		if status != "running" || session == "" || id == "" {
			continue
		}
		command, _ := ocGet(o, "command").(string)
		out = append(out, Shell{ID: id, Session: session, Command: command})
	}
	return out, nil
}

// ChildSessions is the sessions whose parent is parent (GET /api/session?parentID=PARENT), as a list or `{items}`.
func (s *Server) ChildSessions(ctx context.Context, parent string) ([]Child, error) {
	v, err := s.Call(ctx, "GET", "/api/session?"+url.Values{"parentID": {parent}}.Encode(), nil)
	if err != nil {
		return nil, err
	}
	list, ok := v.([]jsjson.Value)
	if !ok {
		list, _ = ocGet(asObject(v), "items").([]jsjson.Value)
	}
	var out []Child
	for _, e := range list {
		o, _ := e.(*jsjson.Object)
		id, _ := ocGet(o, "id").(string)
		if id == "" {
			continue
		}
		title, ok := ocGet(o, "title").(string)
		if !ok {
			title = id
		}
		out = append(out, Child{ID: id, Title: title})
	}
	return out, nil
}

func asObject(v jsjson.Value) *jsjson.Object {
	o, _ := v.(*jsjson.Object)
	return o
}
