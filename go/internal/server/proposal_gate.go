package server

import (
	"regexp"
	"strings"

	"stam/internal/jsfmt"
)

// The part of src/retro-loop.ts a process proposal meets (S-1084): which ITSA is one, what the human last did to it, and the gate on
// anyone else. The rest of the retro loop (the steward, the memory-block and growth proposals, closeAnswered) is not ported, so
// every other ITSA of kind `proposal` still answers 501 (refusedKinds).

const (
	proposalKind     = "proposal"
	proposalApproval = "needs_approval"
)

// applyStatuses are the statuses that apply a proposal: only after the human approved it (retro-loop.ts APPLY_STATUSES).
var applyStatuses = []string{"ready_to_merge", "merging", "deploying", "done"}

// reProcessProposal is processProposalOf's body line. Go's \s is ASCII only, so \p{Z} adds the Unicode spaces JS's \s has, and the
// line breaks JS's ^ honours are turned into \n first (reBreaks).
var reProcessProposal = regexp.MustCompile(`(?m)^Process proposal: ([a-z][a-z0-9_-]*)[\s\p{Z}\x{feff}]*$`)

// processProposalOf is retro-loop.ts processProposalOf: the process a proposal changes when it is a process change, else "".
func processProposalOf(kind, body string) string {
	if kind != proposalKind {
		return ""
	}
	if m := reProcessProposal.FindStringSubmatch(reBreaks.Replace(body)); m != nil {
		return m[1]
	}
	return ""
}

// gateCur is the ITSA a change starts from.
type gateCur struct{ key, kind, body string }

// proposalGate is retro-loop.ts gate for a process proposal: the human can do anything; anyone else can't change the body that
// names the commit to merge (only the system sender that filed it), drop the proposal kind, or create or move one into a status
// that applies it before the human approved it. events are the ITSA's, oldest first (none for a create, where cur is nil).
func proposalGate(events []jsfmt.Value, cur *gateCur, nextKind, nextStatus, nextBody, actor string) error {
	if actor == humanBox {
		return nil
	}
	if cur != nil && processProposalOf(cur.kind, cur.body) != "" && nextBody != cur.body && !strings.HasPrefix(actor, "system:") {
		return itsaErr("%s is a process proposal: its body is written by the system, and only your user may change it", cur.key)
	}
	if cur != nil && cur.kind == proposalKind && nextKind != proposalKind {
		return itsaErr("%s is a proposal: only your user can change its kind", cur.key)
	}
	if nextKind != proposalKind || !contains(applyStatuses, nextStatus) {
		return nil
	}
	if cur == nil || cur.kind != proposalKind || !proposalApproved(events) {
		key := "A new proposal"
		if cur != nil {
			key = cur.key
		}
		return itsaErr("%s is a proposal your user hasn't approved: set it to %s with the diff and wait for Approve before you apply it", key, proposalApproval)
	}
	return nil
}

// proposalApproved is retro-loop.ts approved without the chief of staff's own approval (a process proposal carries a diff, which
// that path never accepts): the human's latest action since the proposal last entered needs_approval, by a status change or by
// being created in it, is Approve. A kind change since then needs a new approval. events are oldest first.
func proposalApproved(events []jsfmt.Value) bool {
	asked := -1
	for i, e := range events {
		d := eventData(e)
		to, _ := d.Get("to")
		status, _ := d.Get("status")
		if (e.Text("type") == "status" && to.Kind == jsfmt.String && to.Str == proposalApproval) ||
			(e.Text("type") == "created" && status.Kind == jsfmt.String && status.Str == proposalApproval) {
			asked = i
		}
		if e.Text("type") == "kind" {
			asked = -1
		}
	}
	if asked < 0 {
		return false
	}
	return humanAction(events[asked+1:]) == "approve"
}

// humanAction is the id of the human's last action in the events, "" for none (retro-loop.ts lastAction on a window of events).
func humanAction(events []jsfmt.Value) string {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Text("type") == "action" && events[i].Text("actor") == humanBox {
			id, _ := eventData(events[i]).Get("id")
			if id.Kind == jsfmt.String {
				return id.Str
			}
			return ""
		}
	}
	return ""
}

// eventData is an event's data, an empty object when it has none or it is not an object.
func eventData(e jsfmt.Value) jsfmt.Value {
	if v, err := jsfmt.Parse([]byte(e.Text("data"))); err == nil && v.Kind == jsfmt.Object {
		return v
	}
	return jsfmt.Value{Kind: jsfmt.Object}
}
