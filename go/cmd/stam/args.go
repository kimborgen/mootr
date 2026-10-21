package main

import (
	"fmt"
	"strings"
)

// optSpec names a command's options: strings take a value, bools don't, and multi ones may repeat.
type optSpec struct {
	str   []string
	multi []string
	bools []string
}

type parsed struct {
	str   map[string]string
	multi map[string][]string
	bools map[string]bool
	pos   []string
}

func has(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// parseArgs is the part of Node's strict parseArgs the CLI uses: `--name value`, `--name=value`, flags and positionals
// in any order, and `--` before positionals only. An unknown option is an error, as in strict mode.
func parseArgs(args []string, spec optSpec) (parsed, error) {
	p := parsed{str: map[string]string{}, multi: map[string][]string{}, bools: map[string]bool{}}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			p.pos = append(p.pos, args[i+1:]...)
			break
		}
		if a == "-h" {
			a = "--help"
		}
		if !strings.HasPrefix(a, "--") {
			if strings.HasPrefix(a, "-") && len(a) > 1 {
				return p, fmt.Errorf("unknown option '%s'", a)
			}
			p.pos = append(p.pos, a)
			continue
		}
		name, val, hasVal := strings.Cut(a[2:], "=")
		switch {
		case has(spec.bools, name):
			if hasVal {
				return p, fmt.Errorf("option '--%s' does not take an argument", name)
			}
			p.bools[name] = true
		case has(spec.str, name) || has(spec.multi, name):
			if !hasVal {
				if i+1 >= len(args) {
					return p, fmt.Errorf("option '--%s <value>' argument missing", name)
				}
				i++
				val = args[i]
			}
			if has(spec.multi, name) {
				p.multi[name] = append(p.multi[name], val)
			} else {
				p.str[name] = val
			}
		default:
			return p, fmt.Errorf("unknown option '--%s'", name)
		}
	}
	return p, nil
}
