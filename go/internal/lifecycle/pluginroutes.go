package lifecycle

import (
	"context"
)

// The routes an OpenCode agent's plugin calls for the session it runs (src/adapters/opencode-plugin/index.ts, GET
// /api/by-session/:sid/notice and /compact-instructions, S-4237). The plugin knows only the session id, so each is bound
// to that session: it acts only while the agent still runs it and no launch is in flight. A plugin of a server a relaunch
// replaced (the same session resumed included) finds itself stale and takes nothing: its notices and its compaction
// instructions are the current launch's.

// SessionNotice is the agent's in-turn notice for the plugin of session sid (src/mail.ts inTurnNotice through
// GET /api/by-session/:sid/notice): the text, "" when there is none or sid is not the session the agent runs. It is taken
// from the same queue as the Claude hook's (InTurnTake), so one delivery state serves both, and the notice is marked
// delivered (mail:notice) only when its text is returned and the binding still holds. An answer's row stays until an
// acknowledgement: the plugin gives up after two seconds and swallows its errors, so a returned response is no receipt,
// and a restart replays the row (RestoreAnswerNotices), as TS does. The plugin's own acknowledgement is S-4300.
func (l *Lifecycle) SessionNotice(ctx context.Context, id, sid string) string {
	o := l.ownerOf(id)
	turn := l.runningTurn(ctx, id)
	cur, gen, launching := o.bindSignal(turn)
	if sid == "" || launching || cur != sid {
		return ""
	}
	l.turnAt(id, "notice-bound")
	text, _ := l.inTurnTakeIf(ctx, id, func() bool { return o.still(gen, sid, turn) })
	if text == "" {
		return ""
	}
	l.turnAt(id, "notice-taken")
	l.turnBinding(ctx, id, sid, gen).event(ctx, "mail:notice", nil)
	return text
}

// SessionCompactInstructions is the instructions the plugin of session sid reads for the compaction the server is
// running (GET /api/by-session/:sid/compact-instructions): the agent's, once, and only when sid is the session the agent
// runs with no launch in flight. A refused take leaves them where they are.
func (l *Lifecycle) SessionCompactInstructions(ctx context.Context, id, sid string) string {
	o := l.ownerOf(id)
	turn := l.runningTurn(ctx, id)
	cur, gen, launching := o.bindSignal(turn)
	if sid == "" || launching || cur != sid {
		return ""
	}
	l.turnAt(id, "notes-bound")
	return o.takeNotesFor(gen, sid, func() string {
		l.turnAt(id, "notes-take")
		return turn()
	})
}
