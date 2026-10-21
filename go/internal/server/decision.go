package server

import (
	"regexp"
	"strings"
	"unicode"
)

// src/decision-mail.ts: whether a mail's body has a decision block, and whether a human reply only defers one. Both are
// read the way the web reads a mail, so the lines are walked the way the TS does.

var decisionTags = map[string]bool{"decision": true, "yesno": true, "question": true, "pick": true, "multi": true, "choose": true, "rank": true}

var (
	reQuote      = regexp.MustCompile(`^ {0,3}>[ \t]?`)
	reCloseFence = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})[ \t]*$")
	reListItem   = regexp.MustCompile(`^( {0,3})([-+*]|\d{1,9}[.)])( +|$)`)
	reOpenFence  = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})(.*)$")
	reStartBlock = regexp.MustCompile("^ {0,3}(>|`{3,}|~{3,}|#{1,6}([ \t]|$)|[-+*]([ \t]|$)|\\d{1,9}[.)]([ \t]|$))")
	reDeferral   = regexp.MustCompile(`^Deferring this one(?:: still open, I'll decide later\.(?: Keep working on what doesn't depend on it\.)?|\. Go with your recommendation, \*\*[^*]+\*\*, for now\.)$`)
)

type mdContainer struct {
	quote bool
	width int
}

func indentOf(s string) int { return len(s) - len(strings.TrimLeftFunc(s, unicode.IsSpace)) }

// hasDecisionBlock is whether the body has a fenced block with one of the tags the web renders as a choice. A fence is 3
// or more backticks or tildes, inside any nesting of block quotes and list items, and its info string must be exactly
// the tag (trimmed, any case). Nothing inside another open fence counts, and a fence ends with its container.
func hasDecisionBlock(body string) bool {
	var containers []mdContainer
	var fenceCh byte
	fenceLen := 0
	para := false
	for _, raw := range strings.Split(body, "\n") {
		rest := strings.TrimSuffix(raw, "\r")
		lead := rest[:len(rest)-len(strings.TrimLeft(rest, " \t"))]
		rest = strings.ReplaceAll(lead, "\t", "    ") + rest[len(lead):]
		matched := 0
		for _, c := range containers {
			if c.quote {
				m := reQuote.FindString(rest)
				if m == "" {
					break
				}
				rest = rest[len(m):]
			} else if strings.TrimSpace(rest) != "" {
				if indentOf(rest) < c.width {
					break
				}
				rest = rest[c.width:]
			}
			matched++
		}
		if fenceLen > 0 {
			if matched == len(containers) {
				// A closing fence is the same character, at least as long, and has no info string.
				if cl := reCloseFence.FindStringSubmatch(rest); cl != nil && cl[1][0] == fenceCh && len(cl[1]) >= fenceLen {
					fenceLen = 0
				}
				continue
			}
			// The line left the container the fence was in, which ends it.
			fenceLen = 0
			containers = containers[:matched]
		} else if matched < len(containers) {
			if para && strings.TrimSpace(rest) != "" && !reStartBlock.MatchString(rest) {
				continue // a lazy continuation line keeps every container open
			}
			containers = containers[:matched]
			para = false
		}
		// Open the containers this line starts.
		for {
			if m := reQuote.FindString(rest); m != "" {
				rest = rest[len(m):]
				containers = append(containers, mdContainer{quote: true})
				continue
			}
			li := reListItem.FindStringSubmatch(rest)
			if li == nil {
				break
			}
			// The text starts 1-4 columns after the marker; with more, or none, it is one column.
			gap := 1
			if n := len(li[3]); n >= 1 && n <= 4 && strings.TrimSpace(rest) != li[2] {
				gap = n
			}
			width := len(li[1]) + len(li[2]) + gap
			containers = append(containers, mdContainer{width: width})
			rest = rest[min(width, len(rest)):]
		}
		if strings.TrimSpace(rest) == "" {
			para = false
			continue
		}
		// JS `.` stops at a line terminator, so a line holding one has no fence info string.
		var f []string
		if !strings.ContainsAny(rest, "\r  ") {
			f = reOpenFence.FindStringSubmatch(rest)
		}
		// A backtick fence's info string can't contain a backtick, so such a line is text.
		if f != nil && !(f[1][0] == '`' && strings.Contains(f[2], "`")) {
			if decisionTags[strings.ToLower(strings.TrimSpace(f[2]))] {
				return true
			}
			fenceCh, fenceLen = f[1][0], len(f[1])
			para = false
		} else {
			// Indented code, unlike indented text after a paragraph, is not a paragraph.
			para = !(indentOf(rest) >= 4 && !para)
		}
	}
	return false
}

// isDeferralOnly is whether a human mail defers its thread: every answer in it is one of the replies the web writes for
// "Decide later", and it has at least one. Quoted lines don't count; attachments mean it is not a deferral.
func isDeferralOnly(body string, attachments int) bool {
	if attachments > 0 {
		return false
	}
	any := false
	for _, l := range strings.Split(body, "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, ">") {
			continue
		}
		if !reDeferral.MatchString(l) {
			return false
		}
		any = true
	}
	return any
}
