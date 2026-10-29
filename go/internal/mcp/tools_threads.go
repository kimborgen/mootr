package mcp

import (
	"context"
	"fmt"

	"stam/internal/jsfmt"
)

// The thread tools of src/mcp.ts (S-3734): mail_attach, withdraw_ask and defer_thread. Their text is built as the TS
// template literals build it.

func init() {
	tools = append(tools,
		tool{name: "mail_attach", listing: mailListings["mail_attach"], run: mailAttach},
		tool{name: "withdraw_ask", listing: mailListings["withdraw_ask"], run: withdrawAsk},
		tool{name: "defer_thread", listing: mailListings["defer_thread"], run: deferThread},
	)
}

// orEmpty is `a[k] ?? []`: the member, or an empty array when it is missing or null.
func orEmpty(args jsfmt.Value, k string) jsfmt.Value {
	if v, ok := args.Get(k); ok && v.Kind != jsfmt.Null {
		return v
	}
	return jsfmt.ArrayValue([]jsfmt.Value{})
}

// arg is a member as JSON.stringify writes it into a body: a missing one is left out by the caller.
func arg(args jsfmt.Value, k string) (jsfmt.Value, bool) {
	v, ok := args.Get(k)
	return v, ok
}

func mailAttach(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	id := str(arg(args, "mail_id"))
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(me))
	body.Set("itsas", orEmpty(args, "itsas"))
	body.Set("agents", orEmpty(args, "agents"))
	r, err := s.apiJSON(ctx, "POST", "/api/mail/"+id+"/attach", raw(body))
	if err != nil {
		return "", err
	}
	att, _ := r.Get("attached")
	itsas, _ := att.Get("itsas")
	agents, _ := att.Get("agents")
	return fmt.Sprintf("Attached to %s: %d ITSA(s), %d new agent(s). No mail was sent.", id, len(itsas.Items), len(agents.Items)), nil
}

func withdrawAsk(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	id := str(arg(args, "mail_id"))
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(me))
	if note, ok := args.Get("note"); ok {
		body.Set("note", note)
	}
	if _, err := s.apiJSON(ctx, "POST", "/api/mail/"+id+"/withdraw-ask", raw(body)); err != nil {
		return "", err
	}
	return "Withdrawn from your user: " + id + ".", nil
}

func deferThread(ctx context.Context, s *Server, args jsfmt.Value) (string, error) {
	me, err := s.me(args)
	if err != nil {
		return "", err
	}
	tid := str(arg(args, "thread_id"))
	undo := truthyMember(args, "undo")
	verb := "defer"
	if undo {
		verb = "undefer"
	}
	body := jsfmt.Value{Kind: jsfmt.Object}
	body.Set("by", jsfmt.StringValue(me))
	if _, err := s.apiJSON(ctx, "POST", "/api/agents/"+me+"/threads/"+tid+"/"+verb, raw(body)); err != nil {
		return "", err
	}
	if undo {
		return "Thread " + tid + " is back in your list.", nil
	}
	return "Thread " + tid + " deferred.", nil
}
