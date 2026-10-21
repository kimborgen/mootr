package server

import (
	"context"
	"encoding/json"
	"net/http"

	"stam/internal/db"
)

// The observers src/ registers on an ITSA change (itsa.onChange, itsa.onStatus, itsa.guardChange) and what each does when
// it acts. The Go daemon carries none of them, so a write one of them would act on answers 501 and writes nothing:
//
//	steps.watch          a decision step on itsa-created or itsa-status runs (enabled steps only)
//	req-check.watch      requirement checks on a created, status or edit change run after the write (afterItsaChange); the check
//	                     of a linked branch at ready_to_merge answers 501
//	itsa-owners          a child that is closed, blocked or waits on the human tells its parent's owner: carried
//	                     (itsa_owners.go)
//	lifecycle            an owner that is resting is woken with a notice
//	process answer       process.run on: a human's answer moves the stage (answerRefusal); in dry-run it is recorded (onAnswer)
//	itsa-human           the ask mail on a human status: carried (itsa_ask.go), except an ITSA created into one (refused in itsa.go)
//	retro-loop           the gate and closeAnswered (retroGate), proposals (kind refused); a process proposal's gate is ported (proposal_gate.go)
//	process-proposal     ported (process_proposal.go); req-approval: requirement-approvals (kind refused)
//	stageGuard, onStage  a stage field write: guarded and recorded (process_run.go); what the runner would do live is refused there
//	watch.syncItsa       links to followed subjects (refused in db/itsa_links.go)
//
// Left out without an error, because nothing observable depends on it: the search index (itsa-vectors queues the ITSAs its
// periodic scan finds unindexed anyway) and the nudges of the auto-archive and notices sweeps, which also run on a timer.

// observed is a create or a set, as the observers see it after it is made.
type observed struct {
	id                                           string
	created, statusChanged, edited, ownerChanged bool
	// fromStatus is the status before ("" for a create), status the one after.
	fromStatus, status string
	parentID, owner    string
	actor              string
}

func unported(format string, args ...any) error {
	return Errorf(http.StatusNotImplemented, format, args...)
}

// observedRefusal answers 501 when an observer of TS would act on the change.
func (s *Server) observedRefusal(tx db.ItsaTx, o observed) error {
	if o.created || o.statusChanged {
		for _, ev := range []struct {
			on    bool
			event string
		}{{o.created, "itsa-created"}, {o.statusChanged && !o.created, "itsa-status"}} {
			if !ev.on {
				continue
			}
			if has, err := tx.StepOn(ev.event); err != nil {
				return err
			} else if has {
				return unported("a decision step runs on %s, and decision steps are not ported to the Go daemon yet", ev.event)
			}
		}
	}
	if o.ownerChanged && o.owner != "" && o.owner != humanBox {
		life, pausedBy, found, err := tx.AgentState(o.owner)
		if err != nil {
			return err
		}
		var owners []string
		if found && life == "paused" && json.Unmarshal([]byte(pausedBy), &owners) == nil && len(owners) == 1 && owners[0] == "standing-idle" {
			return unported("an ITSA given to a resting agent wakes it with a notice, which is not ported to the Go daemon yet")
		}
	}
	return nil
}

// mailObserverRefusal answers 501 where an observer of a stored mail would act (src/mail.ts storeMail): an enabled decision
// step on `mail-to-human` looks at an agent's mail to the human. It is not ported, so no such mail is stored. (The requirement
// checks of a stored mail run after the write: afterMail.)
func (s *Server) mailObserverRefusal(ctx context.Context, from string, toHuman bool) error {
	if from == humanBox {
		return nil
	}
	if !toHuman {
		return nil
	}
	return s.db.Inspect(ctx, func(tx db.ItsaTx) error {
		if has, err := tx.StepOn("mail-to-human"); err != nil {
			return err
		} else if has {
			return unported("a decision step runs on mail-to-human, and decision steps are not ported to the Go daemon yet")
		}
		return nil
	})
}
