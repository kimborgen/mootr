package main

import (
	"errors"
	"fmt"
	"os"
	"time"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// settingsCmd is `stam settings migrate [--apply] [--json]` (src/cli.ts, src/settings-migrate.ts): a peer's settings.json
// compared with the home's shared cache, and with --apply rewritten with only its local keys. Local only: no daemon.
func settingsCmd(args []string, e env) error {
	const usageLine = "usage: stam settings migrate [--apply] [--json]"
	if len(args) == 0 || args[0] != "migrate" {
		return errors.New(usageLine)
	}
	apply, asJSON := false, false
	for _, a := range args[1:] {
		switch a {
		case "--apply":
			apply = true
		case "--json":
			asJSON = true
		default:
			return errors.New(usageLine)
		}
	}
	home := e.getenv("MOOTR_HOME")
	if home == "" {
		home = e.getenv("STAM_HOME")
	}
	if home == "" {
		return errors.New("STAM_HOME is not set")
	}
	machine := e.getenv("MOOTR_MACHINE")
	if machine == "" {
		machine = e.getenv("STAM_MACHINE")
	}
	if machine == "" {
		var err error
		if machine, err = os.Hostname(); err != nil {
			return err
		}
	}
	code, text, result := config.Migrate(home, machine, apply, time.Now())
	if asJSON {
		fmt.Fprintln(e.stdout, jsjson.Stringify(result, "  "))
	} else {
		fmt.Fprintln(e.stdout, text)
	}
	if code != 0 {
		return &exitError{code: code}
	}
	return nil
}
