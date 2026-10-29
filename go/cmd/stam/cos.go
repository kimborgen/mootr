package main

import (
	"context"
	"fmt"

	"stam/internal/client"
)

// cos is `stam cos [AGENT]` (src/cli.ts): names the chief of staff, or clears the name with none. It takes the role in
// its prompt at its next restart.
func cos(ctx context.Context, args []string, e env) error {
	var agent any
	if len(args) > 0 {
		agent = args[0]
	}
	r, err := getJSON(ctx, client.New(e.getenv), "POST", "/api/chief-of-staff", map[string]any{"agent": agent}, 0)
	if err != nil {
		return err
	}
	if name := r.Text("chiefOfStaff"); name != "" {
		fmt.Fprintf(e.stdout, "chief of staff: %s\n", name)
		return nil
	}
	fmt.Fprintln(e.stdout, "no chief of staff")
	return nil
}
