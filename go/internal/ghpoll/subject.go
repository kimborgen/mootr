// Package ghpoll is the GitHub event source (src/sources/github.ts, S-4329): a poller that turns changes on the
// repositories, pull requests and issues that agents and ITSAs watch into external events on the events service. It keeps
// one snapshot per subject in watch_state (the table TS keeps, so a rollback finds it) and one event per change, with
// stable dedupe keys, so a poll that changes nothing emits nothing. Polling only. The `gh` login's token (or
// STAM_GITHUB_TOKEN) authorizes the calls and goes nowhere else: not to disk, a log, an error, an event or the snapshot.
package ghpoll

import (
	"regexp"
	"strconv"
)

// Subject is a polled subject key: a repository (`github:OWNER/REPO`), or a pull request or issue
// (`github:OWNER/REPO#N`).
type Subject struct {
	Owner, Repo string
	// Number is the pull request or issue number; 0 for a repository subject.
	Number  int
	IsRepo  bool
	Key     string
	RepoKey string
}

var reSubject = regexp.MustCompile(`^github:([^/#\s*]+)/([^/#\s*]+)(?:#(\d+))?$`)

// ParseSubject is the subject key as GitHub names it, or ok false when stam can't poll it. Globs are skipped.
func ParseSubject(subject string) (Subject, bool) {
	m := reSubject.FindStringSubmatch(subject)
	if m == nil {
		return Subject{}, false
	}
	s := Subject{Owner: m[1], Repo: m[2], Key: subject, RepoKey: "github:" + m[1] + "/" + m[2], IsRepo: m[3] == ""}
	if m[3] != "" {
		n, err := strconv.Atoi(m[3])
		if err != nil {
			return Subject{}, false
		}
		s.Number = n
	}
	return s, true
}
