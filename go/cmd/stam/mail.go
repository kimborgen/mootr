package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"stam/internal/client"
	"stam/internal/jsfmt"
)

// mail is `stam mail send|inbox|read` (src/cli.ts, S-2824).
func mail(ctx context.Context, args []string, e env) error {
	if len(args) == 0 {
		return errors.New("usage: stam mail send --to AGENT [--to AGENT] --subject TEXT BODY | stam mail inbox AGENT")
	}
	sub, rest := args[0], args[1:]
	c := client.New(e.getenv)
	switch sub {
	case "send":
		p, err := parseArgs(rest, optSpec{str: []string{"subject", "from", "system", "itsa", "override"}, multi: []string{"to"}})
		if err != nil {
			return err
		}
		// --system NAME sends as a local script (no agent behind it); it replaces --from. --itsa links a script's notice to
		// an ITSA, so it can count as read when it closes (S-717).
		body := jsfmt.Value{Kind: jsfmt.Object}
		if s, ok := p.str["system"]; ok && s != "" {
			body.Set("system", jsfmt.StringValue(s))
		} else {
			// parseArgs' default applies only when --from is absent: an empty --from is sent as is, and the daemon refuses it.
			from, given := p.str["from"]
			if !given {
				from = "human"
			}
			body.Set("from", jsfmt.StringValue(from))
		}
		if to := p.multi["to"]; len(to) > 0 {
			items := make([]jsfmt.Value, 0, len(to))
			for _, t := range to {
				items = append(items, jsfmt.StringValue(t))
			}
			body.Set("to", jsfmt.ArrayValue(items))
		}
		for _, k := range []string{"subject"} {
			if v, ok := p.str[k]; ok {
				body.Set(k, jsfmt.StringValue(v))
			}
		}
		body.Set("body", jsfmt.StringValue(strings.Join(p.pos, " ")))
		for _, k := range []string{"itsa", "override"} {
			if v, ok := p.str[k]; ok {
				body.Set(k, jsfmt.StringValue(v))
			}
		}
		m, err := getJSON(ctx, c, "POST", "/api/mail", body, 0)
		if err != nil {
			return err
		}
		if truthyMember(m, "queued") {
			fmt.Fprintf(e.stdout, "queued %s: storage is unreachable; it is delivered when storage answers\n", displayField(m, "id"))
			return nil
		}
		fmt.Fprintf(e.stdout, "sent %s\n", displayField(m, "id"))
		return nil
	case "inbox":
		who := "undefined"
		if len(rest) > 0 {
			who = rest[0]
		}
		rows, err := getJSON(ctx, c, "GET", "/api/agents/"+url.PathEscape(who)+"/inbox?unread=0", nil, 0)
		if err != nil {
			return err
		}
		for _, m := range rows.Items {
			state := "UNREAD"
			if truthyMember(m, "read_at") {
				state = "read  "
			}
			fmt.Fprintf(e.stdout, "%s  %s  %s  %s\n", displayField(m, "id"), state, displayField(m, "from_id"), displayField(m, "subject"))
		}
		return nil
	case "read":
		who := "human"
		var ids []jsfmt.Value
		if len(rest) > 0 {
			who = rest[0]
			for _, id := range rest[1:] {
				ids = append(ids, jsfmt.StringValue(id))
			}
		}
		body := jsfmt.Value{Kind: jsfmt.Object}
		body.Set("ids", jsfmt.ArrayValue(append([]jsfmt.Value{}, ids...)))
		mails, err := getJSON(ctx, c, "POST", "/api/agents/"+url.PathEscape(who)+"/read", body, 0)
		if err != nil {
			return err
		}
		for _, m := range mails.Items {
			note := ""
			if truthyMember(m, "note") {
				note = "\n\n[stam] " + displayField(m, "note")
			}
			fmt.Fprintf(e.stdout, "## %s: %s\nFrom: %s · %s\n\n%s%s\n\n", displayField(m, "id"), displayField(m, "subject"), displayField(m, "from_id"), displayField(m, "created_at"), displayField(m, "body"), note)
		}
		return nil
	}
	return errors.New("usage: stam mail send --to AGENT [--to AGENT] --subject TEXT BODY | stam mail inbox AGENT")
}
