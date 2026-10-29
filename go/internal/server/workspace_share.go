package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"stam/internal/adapters/claude"
	"stam/internal/auth"
	"stam/internal/db"
)

// Workspace shares (src/workspace-share.ts, S-896): an agent with a personal workspace grants another agent on its
// machine read or write access to that folder, or revokes it. `read` is advisory, since every agent runs as one Unix
// user; the grant reaches the grantee's prompt block and, for Claude Code, its allowed directories at its next launch.

func (s *Server) workspaceShareRoutes() {
	s.handle("POST /api/agents/{id}/workspace-share", agentPath(s.workspaceShare))
}

// shareMessage is the route's reply: what the owner's tool result says.
type shareMessage struct {
	Message string `json:"message"`
}

// workspaceShare is POST /api/agents/:id/workspace-share (src/daemon.ts): the agent in the path shares its own
// workspace, self only. Every refusal of share is a 400.
func (s *Server) workspaceShare(r *http.Request, c auth.Resolved) (any, error) {
	ctx := r.Context()
	w, err := s.readWrite(r, c)
	if err != nil {
		return nil, err
	}
	a, err := s.mustAgent(ctx, r.PathValue("id"))
	if err != nil {
		return nil, err
	}
	// Self only: no other agent shares a workspace on the owner's behalf.
	if err := s.mayActAs(ctx, c.Caller, a.ID, true); err != nil {
		return nil, err
	}
	text := func(k string) string {
		if v := bodyField(w.body, k); v != nil {
			return claude.JSString(v)
		}
		return ""
	}
	msg, err := s.share(ctx, a.ID, text("agent"), text("access"))
	var refused shareRefusal
	if errors.As(err, &refused) {
		return nil, Errorf(http.StatusBadRequest, "%s", refused.Error())
	}
	if err != nil {
		return nil, err
	}
	return shareMessage{msg}, nil
}

// shareRefusal is a refusal of share, which the route answers with a 400; any other error is the daemon's own.
type shareRefusal struct{ error }

func refuse(format string, args ...any) error { return shareRefusal{fmt.Errorf(format, args...)} }

// share is src/workspace-share.ts share: grants (or with "none" revokes) the owner's workspace to granteeRef, idempotent
// per pair. The grantee gets a notice when its access changes.
func (s *Server) share(ctx context.Context, ownerRef, granteeRef, access string) (string, error) {
	if access != "read" && access != "write" && access != "none" {
		return "", refuse("access must be read, write or none, not %s", access)
	}
	owner, err := s.db.GetAgent(ctx, ownerRef)
	if errors.Is(err, db.ErrNotFound) {
		return "", refuse("no agent %s", ownerRef)
	} else if err != nil {
		return "", err
	}
	if owner.PersonalWorkspace == nil || *owner.PersonalWorkspace == "" {
		return "", refuse("%s has no personal workspace to share; spawn it with a workspace first", owner.Name)
	}
	found, err := s.db.GetAgent(ctx, granteeRef)
	if errors.Is(err, db.ErrNotFound) {
		return "", refuse("no agent %s on this machine: a workspace folder is local, so it can only be shared with an agent on %s", granteeRef, owner.Machine)
	} else if err != nil {
		return "", err
	}
	if hook := s.beforeShare; hook != nil {
		hook()
	}
	// A grantee that was cost-switched is its live successor (the predecessor is stopped). The write resolves it,
	// checks it and changes its grants at once, so a switch can't land in between.
	path := *owner.PersonalWorkspace
	out, err := s.db.ShareWorkspace(ctx, path, owner, found.ID, access)
	if err != nil {
		return "", err
	}
	grantee := out.Grantee
	switch out.Refusal {
	case "machine":
		return "", refuse("%s runs on %s, and the workspace folder is on %s", grantee.Name, grantee.Machine, owner.Machine)
	case "self":
		return "", refuse("an agent already has access to its own workspace")
	case "archived":
		return "", refuse("%s is archived", grantee.Name)
	}
	if access == "none" {
		if out.Removed == 0 {
			return fmt.Sprintf("%s wasn't shared with %s.", path, grantee.Name), nil
		}
		s.queueNotice(ctx, grantee.ID, revokeNotice(owner.Name, path, grantee.Harness, out.Held))
		return revokeMessage(grantee.Name, path, grantee.Harness, out.Held), nil
	}
	if out.Prev != access {
		s.queueNotice(ctx, grantee.ID, shareNotice(owner.Name, grantee.Harness, path, access))
	}
	return fmt.Sprintf("Shared %s with %s (%s).", path, grantee.Name, access), nil
}

// shareNotice is src/workspace-share.ts shareNotice: what the grantee is told. Claude Code reads its allowed
// directories at launch, so a read before then raises a permission dialog; Codex write roots apply at launch too.
func shareNotice(ownerName, harness, path, access string) string {
	note := "You may read there; please don't write (stam can't enforce it)."
	if access == "write" {
		note = "You may read and write there."
	}
	when := " Use it now."
	if harness == "claude" {
		when = " It becomes an allowed directory at your next launch; don't read it before then, since that raises a permission dialog."
	} else if harness == "codex" && access == "write" {
		when = " It becomes writable at your next launch; you can read it now."
	}
	return fmt.Sprintf("%s shared its workspace `%s` with you (%s). %s%s", ownerName, path, access, note, when)
}

// outlivesRevoke is src/workspace-share.ts outlivesRevoke: whether a revoked grant stays usable until the grantee's next
// launch (Claude Code's allowed directories, Codex write roots); other grants never had a launch gate.
func outlivesRevoke(harness, access string) bool {
	return harness == "claude" || (harness == "codex" && access == "write")
}

// revokeNotice is src/workspace-share.ts revokeNotice: what the grantee is told on revoke.
func revokeNotice(ownerName, path, harness, access string) string {
	tail := " Nothing enforced this access, so it isn't cut off: please just stop using the folder."
	if outlivesRevoke(harness, access) {
		tail = " The folder stays reachable until your next launch, so don't use it before then either."
	}
	return fmt.Sprintf("%s stopped sharing its workspace `%s` with you. Stop using it.%s", ownerName, path, tail)
}

// revokeMessage is src/workspace-share.ts revokeMessage: when the revoked access actually ends, for the owner.
func revokeMessage(granteeName, path, harness, access string) string {
	end := fmt.Sprintf("Nothing enforced this access, so %s must stop using the folder itself.", granteeName)
	if outlivesRevoke(harness, access) {
		end = fmt.Sprintf("Access ends at %s's next launch, not now.", granteeName)
	}
	return fmt.Sprintf("Stopped sharing %s with %s. %s", path, granteeName, end)
}
