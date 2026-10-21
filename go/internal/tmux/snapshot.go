package tmux

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Snapshot is every session's state from one tmux call (S-345), for a loop that would otherwise run tmux per agent.
type Snapshot struct {
	// Server is the server as ServerID gives it, "" when none runs on the socket.
	Server string
	// Dead is, per session, whether its window's panes are all dead (as IsDead).
	Dead map[string]bool
	// Activity is, per session, when its window last had output (S-349, #{window_activity}, in seconds).
	Activity map[string]int64
	// Pane is, per session, its active pane's id (%N; a new session or a switched window has another).
	Pane map[string]string
	// StartedAt is when the tmux call behind the snapshot started: what it says is true from then on, so a caller that
	// applies it later can tell the agents that changed since (S-2125).
	StartedAt time.Time
}

var listPanes = []string{"list-panes", "-a", "-F", "#{pid} #{start_time}\t#{session_name}\t#{window_active}\t#{pane_dead}\t#{window_activity}\t#{pane_active}\t#{pane_id}"}
var serverSessions = []string{"display-message", "-p", "#{pid} #{start_time}\t#{server_sessions}"}

var noServerRe = regexp.MustCompile(`(?m)^no server running on |^error connecting to .*\((No such file or directory|Connection refused)\)`)
var noTargetRe = regexp.MustCompile(`(?m)^no current target`)
var serverIDRe = regexp.MustCompile(`^\d+ \d+$`)

// noServer is whether a failed tmux call says no server runs on the socket (none started, or it went away), rather
// than failing for some other reason.
func noServer(stderr string) bool { return noServerRe.MatchString(stderr) }

func emptySnapshot() *Snapshot {
	return &Snapshot{Dead: map[string]bool{}, Activity: map[string]int64{}, Pane: map[string]string{}}
}

// parseSnapshot reads list-panes' result. It returns the snapshot, nil when nothing is known (a timeout, another
// error, output it can't read), or ask true when only the server's session count can tell (no panes listed).
func parseSnapshot(r Result) (s *Snapshot, ask bool) {
	s = emptySnapshot()
	// tmux 3.6 answers a server with no sessions with "no current target": no panes, as empty output.
	none := r.Status == 1 && noTargetRe.MatchString(r.Stderr)
	if r.Status != 0 && !none {
		if r.Status == 1 && noServer(r.Stderr) {
			return s, false
		}
		return nil, false
	}
	var lines []string
	if !none {
		for _, l := range strings.Split(r.Stdout, "\n") {
			if l != "" {
				lines = append(lines, l)
			}
		}
	}
	for _, line := range lines {
		f := strings.Split(line, "\t")
		if len(f) != 7 {
			return nil, false
		}
		session, active, paneDead, when, paneActive, id := f[1], f[2], f[3], f[4], f[5], f[6]
		if active != "1" {
			continue
		}
		prev, seen := s.Dead[session]
		s.Dead[session] = (!seen || prev) && paneDead == "1"
		// Number() in TS; a value it can't read is NaN there, 0 here.
		n, _ := strconv.ParseInt(when, 10, 64)
		s.Activity[session] = n
		if paneActive == "1" {
			s.Pane[session] = id
		}
	}
	if len(lines) > 0 {
		s.Server, _, _ = strings.Cut(lines[0], "\t")
		return s, false
	}
	return nil, true
}

// parseEmpty believes no panes only from a server that says it has no sessions; no panes names no server either.
func parseEmpty(r Result) *Snapshot {
	if r.Status != 0 {
		if r.Status == 1 && noServer(r.Stderr) {
			return emptySnapshot()
		}
		return nil
	}
	server, sessions, _ := strings.Cut(strings.TrimSpace(r.Stdout), "\t")
	sessions, _, _ = strings.Cut(sessions, "\t")
	if sessions != "0" || !serverIDRe.MatchString(server) {
		return nil
	}
	s := emptySnapshot()
	s.Server = server
	return s
}

// Snapshot is every session's state from one list-panes call (and a display-message when it lists none), or nil when
// nothing is known: the call failed without saying the server is gone, or listed no panes while the server holds
// sessions.
func (c *Client) Snapshot(ctx context.Context) *Snapshot {
	at := time.Now()
	s, ask := parseSnapshot(c.Run(ctx, nil, listPanes...))
	if ask {
		s = parseEmpty(c.Run(ctx, nil, serverSessions...))
	}
	if s != nil {
		s.StartedAt = at
	}
	return s
}

// SnapshotReuse is how long SharedSnapshot reuses a settled answer.
const SnapshotReuse = time.Second

// sharedSnapshot is the state behind SharedSnapshot.
type sharedSnapshot struct {
	mu       sync.Mutex
	inflight *snapshotCall
	settled  *Snapshot
	at       time.Time
}

type snapshotCall struct {
	done chan struct{}
	s    *Snapshot
}

// SharedSnapshot is one Snapshot shared by the loops that ask (banners, reconcile): a call while one is in flight joins
// it (however long it has run, so requests never overlap or finish out of order), and a settled answer is reused for
// SnapshotReuse after it arrived. A failed answer (nil) isn't kept. A joiner whose ctx ends stops waiting with nil; the
// call it joined runs on under its own deadline.
func (c *Client) SharedSnapshot(ctx context.Context) *Snapshot {
	sh := &c.shared
	sh.mu.Lock()
	if sh.inflight == nil && sh.settled != nil && time.Since(sh.at) < SnapshotReuse {
		s := sh.settled
		sh.mu.Unlock()
		return s
	}
	call := sh.inflight
	if call == nil {
		call = &snapshotCall{done: make(chan struct{})}
		sh.inflight = call
		go func() {
			// Detached from the first caller's ctx, so a joiner never gets a call its first caller cancelled.
			call.s = c.Snapshot(context.WithoutCancel(ctx))
			sh.mu.Lock()
			sh.inflight, sh.settled, sh.at = nil, call.s, time.Now()
			sh.mu.Unlock()
			close(call.done)
		}()
	}
	sh.mu.Unlock()
	select {
	case <-call.done:
		return call.s
	case <-ctx.Done():
		return nil
	}
}
