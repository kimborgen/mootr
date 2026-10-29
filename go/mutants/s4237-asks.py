#!/usr/bin/env python3
"""Mutations of the Go daemon's OpenCode asks (S-4237, PR 4b): each one breaks one contract line or interleaving, and
the test named with it must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4237-asks.py [NAME...]

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
A, OW, OC, TS = 'internal/lifecycle/ask.go', 'internal/lifecycle/owner.go', 'internal/lifecycle/opencode.go', 'internal/lifecycle/turnstop.go'
LC = 'internal/lifecycle/lifecycle.go'
AD, SP = 'internal/adapters/opencode/ask.go', 'internal/server/permissions.go'
L, O, S = './internal/lifecycle/', './internal/adapters/opencode/', './internal/server/'

# name: (package, test, [(file, old, new)])
M = {
    # Exactly once: a duplicate event keeps the one request, TS's row after a restart too.
    'dupkeep': (S, 'TestOpenCodeAskFromTSAcrossARestart', [(SP, '''	if ok && (!d.Replaces || (pending.Action == d.Action && pending.Details == d.Details)) {''',
                                            '''	if ok && !d.Replaces {''')]),
    # Exactly once across replaced asks: A, B, A leaves B and one A.
    'dedup': (L, 'TestOpenCodeAskDuplicateAfterAnother', [(OW, '''	if o.answered(ask.pid) || o.asked[askKey{ask.sid, ask.pid}] || o.parkedAt(ask.pid) >= 0 {''',
                                                           '''	if o.answered(ask.pid) || o.parkedAt(ask.pid) >= 0 {''')]),
    # The asks raised are forgotten by a launch.
    'dedupclear': (L, 'TestOpenCodeAskDuplicateAfterAnother', [(OW, '''	clear(o.replied)
	clear(o.asked)''', '''	clear(o.replied)''')]),
    # An outside reply before the raise, during its listing, or while it is shown.
    'replied': (L, 'TestOpenCodeAskRepliedOutside', [(OW, '''	return o.replied[pid] || o.answering[pid] != 0''', '''	return o.answering[pid] != 0''')]),
    # Answered by stam: a raise reads the answer where it reads the request standing, and checks it again once shown.
    'answeredchoose': (L, 'TestOpenCodeAskAnsweredWhileShown', [(A, '''		if o.answeredNow(ask.pid) {''', '''		if false {''')]),
    'answeredshown': (L, 'TestOpenCodeAskAnsweredOnceShown', [(OW, '''	return o.replied[pid] || o.answering[pid] != 0''', '''	return o.replied[pid]''')]),
    # Ask vs launch: a launch during the listing or while it is shown (a real release).
    'launchduring': (L, 'TestOpenCodeAskMidLaunch', [(OW, '''	if turn() != ask.sid || (gen >= 0 && o.gen != gen) {''', '''	if turn() != ask.sid {''')]),
    # A session change before the raise began: the raise binds the row's session.
    'raisebind': (L, 'TestOpenCodeAskAfterASessionChange', [(OW, '''	if turn() != ask.sid || (gen >= 0 && o.gen != gen) {''', '''	if gen >= 0 && o.gen != gen {''')]),
    # An ask mid-stop is parked, never raised then.
    'midstop': (L, 'TestOpenCodeAskMidStop', [(OW, '''	if e := o.stops[ask.sid]; e != nil && !e.cancelled.Load() {''', '''	if e := o.stops[ask.sid]; false && e != nil {''')]),
    # A stop given up keeps its parked asks (a real Resume's launch).
    'parkgivenup': (L, 'TestOpenCodeAskParkedForAStop/given_up_by_a_Resume', [(OW, '''	case err == nil && !e.cancelled.Load():
		parked = nil''', '''	case err == nil:
		parked = nil''')]),
    # A stop that failed hands its parked asks back.
    'parkfailed': (L, 'TestOpenCodeAskParkedForAStop/failed', [(OW, '''	case err == nil && !e.cancelled.Load():
		parked = nil''', '''	case !e.cancelled.Load():
		parked = nil''')]),
    # The asks handed back are raised.
    'parkraise': (L, 'TestOpenCodeAskParkedForAStop/failed', [(TS, '''		l.queueAsks(a.ID, parked)''', '''		_ = parked''')]),
    # A stop a Resume gave up hands its asks to the launch, not back while the row is still shut down.
    'resumehandback': (L, 'TestOpenCodeAskParkedForAStop/given_up_by_a_Resume', [(OW, '''	case o.launched > e.gen && o.launchEnd < o.launched:''', '''	case false:''')]),
    # The launch that lands raises the asks handed to it.
    'launchland': (L, 'TestOpenCodeAskParkedForAStop/given_up_by_a_Resume', [(LC, '''	l.queueAsks(a.ID, l.ownerOf(a.ID).settleLaunch(gen, true))''', '''	_ = l.ownerOf(a.ID).settleLaunch''')]),
    # A launch that never lands drops them.
    'launchdrop': (L, 'TestOpenCodeAskParkedForAStop/a_Resume_superseded', [(LC, '''		l.ownerOf(a.ID).settleLaunch(gen, false)
''', '')]),
    # A stop begun during the listing: the check before the ask is shown.
    'parklisting': (L, 'TestOpenCodeAskParkedForAStop/begun_at_listed', [(A, '''	if o.mayShow(ask, gen, turn) != raiseGo {
		return
	}''', '''	_ = o.mayShow''')]),
    # A stop begun while the ask was shown: the check after.
    'parkshown': (L, 'TestOpenCodeAskParkedForAStop/begun_at_shown', [(A, '''	if o.shown(ask, gen, turn) != raiseGo {
		l.closeAsk(ctx, d, id, ask.pid)
	}''', '''	_ = o.shown''')]),
    # A stale server event arriving late: a permission no longer listed raises nothing.
    'latelisted': (L, 'TestOpenCodeAskRaise', [(A, '''	case !pending:
		return
	}
	l.askAt(id, "listed")''', '''	}
	_ = pending
	l.askAt(id, "listed")''')]),
    # A listing that fails parks the ask (it raised it before, as TS does).
    'listfail': (L, 'TestOpenCodeAskListingFails', [(A, '''	case err != nil:
		if o.parkUnlisted(ask) {
			l.retryAsksAfter(id)
		}
		return''', '''	case err != nil:''')]),
    # The parked ask is listed again on the agent's next event.
    'listretry': (L, 'TestOpenCodeAskListingFails', [(OC, '''	l.retryAsks(a.ID)
''', '')]),
    # With no event, the timer lists it again.
    'retrytimer': (L, 'TestOpenCodeAskRetriedByTheTimer', [(A, '''		if o.parkUnlisted(ask) {
			l.retryAsksAfter(id)
		}''', '''		o.parkUnlisted(ask)''')]),
    # The whole listing has one budget.
    'listbudget': (L, 'TestOpenCodeAskListingOffTheStream', [(A, '''	lctx, cancel := context.WithTimeout(ctx, askListing.budget)''', '''	lctx, cancel := context.WithCancel(ctx)''')]),
    # The event stream never waits on a raise.
    'offstream': (L, 'TestOpenCodeAskListingOffTheStream', [(A, '''	l.queueAsks(a.ID, []parkedAsk{{sid: sid, pid: opencode.AskOf(details).Permission, action: action, details: details}})''',
                                                            '''	l.raiseAsk(l.ctx, a.ID, parkedAsk{sid: sid, pid: opencode.AskOf(details).Permission, action: action, details: details})''')]),
    # A retry against a stop, a launch, an archive: a launch during its listing drops it.
    'retrylaunch': (L, 'TestOpenCodeAskRetryInterleavings/a_launch_during', [(OW, '''	if turn() != ask.sid || (gen >= 0 && o.gen != gen) {''', '''	if turn() != ask.sid {''')]),
    # A retry finds a stop in flight: parked for it, raised when it fails.
    'retrystop': (L, 'TestOpenCodeAskRetryInterleavings/a_stop_before', [(OW, '''	if e := o.stops[ask.sid]; e != nil && !e.cancelled.Load() {''', '''	if e := o.stops[ask.sid]; false && e != nil {''')]),
    # The listing is retried within the call.
    'listattempts': (L, 'TestOpenCodeAskListingFails', [(A, '''	for i := 0; i < askListing.attempts; i++ {''', '''	for i := 0; i < 1; i++ {''')]),
    # stam's own reply, in flight, closes nothing.
    'ownreply': (L, 'TestOpenCodeAskRepliedOutside', [(OW, '''	if o.answering[pid] != 0 {
		return false
	}
	o.replied[pid] = true''', '''	o.replied[pid] = true''')]),
    # stam's own reply, told of after it returned, closes nothing.
    'answersent': (L, 'TestOpenCodeAskRepliedOutside', [(OW, '''	if sent {
		o.answering[pid] = answerSent
	} else {
		delete(o.answering, pid)
	}''', '''	_ = sent
	delete(o.answering, pid)''')]),
    # The answer binds the row's session to the generation (a launch before the bind).
    'answerbind': (L, 'TestOpenCodeAnswerSnapshot/a_launch_before_the_bind', [(A, '''	sid, gen := o.bind(turn)''', '''	sid := l.serverTurn(a)
	gen := o.now()''')]),
    # The first keep, once the slot is taken: no listing for a cancelled answer.
    'answerfirstkeep': (L, 'TestOpenCodeAnswerSnapshot/a_launch_as_the_slot_is_taken', [(A, '''	l.askAt(a.ID, "answer-slot")
	if !keep() {
		return "failed"
	}''', '''	l.askAt(a.ID, "answer-slot")''')]),
    # The keep before the reply: an answer for a superseded launch is refused.
    'answerkeep': (L, 'TestOpenCodeAnswerAcrossALaunch', [(A, '''	l.askAt(a.ID, "answer-listed")
	if !keep() {
		return "failed"
	}''', '''	l.askAt(a.ID, "answer-listed")''')]),
    # The row read again: archived while the answer holds the slot.
    'answerstillrow': (L, 'TestOpenCodeAnswerSnapshot/a_row_archived_while_it_holds_the_slot', [(OW, '''	return o.gen == gen && turn() == sid''', '''	return o.gen == gen''')]),
    # The generation checked again: a real Archive while the answer holds the slot.
    'answerstillgen': (L, 'TestOpenCodeAnswerSnapshot/an_Archive_while_it_holds_the_slot', [(OW, '''	return o.gen == gen && turn() == sid''', '''	return turn() == sid''')]),
    # The answer holds the session's slot (a release waits for it).
    'answerslot': (L, 'TestOpenCodeAnswerAcrossALaunch', [(A, '''	if !o.waitSlot(ctx, slot, &op) {
		return "failed"
	}
	defer o.leaveSlot(slot, &op)''', '''	_ = slot''')]),
    # Only under the agent's current session.
    'answersession': (L, 'TestOpenCodeAnswer', [(A, ''' || (ask.Session != "" && ask.Session != sid) {
		return "gone"''', ''' {
		return "gone"''')]),
    # After archive or shutdown: the agent no longer runs.
    'answerarchived': (L, 'TestOpenCodeAnswer', [(A, '''		if err != nil || (a.Lifecycle != "active" && a.Lifecycle != "paused") {''', '''		if err != nil {''')]),
    # After a restart: a permission the server no longer lists is gone.
    'answerlisted': (S, 'TestOpenCodeAskRepliedWhileDown', [(A, '''	case !pending:
		o.goneOutside(ask.Permission, gen, sid, turn)
		return "gone"
	}''', '''	}
	_ = pending''')]),
    # A 404 on the listing is gone, not failed.
    'answer404': (L, 'TestOpenCodeAnswer', [(AD, '''		return false, ErrSessionGone''', '''		return false, err''')]),
    # Allowed answers: a yes to a question is unsafe.
    'question': (L, 'TestOpenCodeAnswer', [(A, '''	if ask.Permission == "" || (approve && ask.Action == "question") {''', '''	if ask.Permission == "" {''')]),
    # The decision sent.
    'decision': (L, 'TestOpenCodeAnswer', [(AD, '''	decision := "reject"
	if approve {
		decision = "once"
	}''', '''	decision := "once"
	_ = approve''')]),
    # A denial writes no idle over the events' state.
    'denyidle': (S, 'TestOpenCodeAskLive', [(SP, '''	if !approve && a.Harness != "opencode" {''', '''	if !approve {''')]),
    # A close is for its own permission only.
    'closematch': (L, 'TestOpenCodeAskRepliedOutside', [(A, '''func(details string) bool { return opencode.AskOf(details).Permission == pid }''', '''func(string) bool { return true }''')]),
    # The close withdraws the human's copy of the mail (go-mgr's point 1).
    'closemail': (S, 'TestOpenCodeAskLive', [(SP, '''	if err != nil || !ok || !match(r.Details) {
		return err
	}
	return s.withdrawDialog(ctx, a, r, "closed outside stam")''', '''	if err != nil || !ok || !match(r.Details) {
		return err
	}
	_, err = s.db.WithdrawPermissionRequest(ctx, r.ID, "closed outside stam")
	return err''')]),
    # Restore from the stored row: TS's details, byte for byte, and read back.
    'details': (S, 'TestOpenCodeAskFromTSAcrossARestart', [(AD, '''	fields := []any{"tool", act, "input", jsjson.NewObject(key, strings.Join(resources, "\\n")), "action", act, "permission", id}''',
                                                            '''	fields := []any{"action", act, "tool", act, "input", jsjson.NewObject(key, strings.Join(resources, "\\n")), "permission", id}''')]),
    'rowread': (S, 'TestOpenCodeAskFromTSAcrossARestart', [(AD, '''Permission: str("permission")''', '''Permission: str("permissionID")''')]),
    # Security: nothing else of the event goes in.
    'metadata': (S, 'TestOpenCodeAskLive', [(AD, '''	if sid != "" {
		fields = append(fields, "session", sid)
	}''', '''	if sid != "" {
		fields = append(fields, "session", sid)
	}
	fields = append(fields, "metadata", ocGet(data, "metadata"))''')]),
    # An answer that finds the permission gone records it, so a raise listed before shows nothing; for the launch and
    # session it bound only.
    'gonelisted': (L, 'TestOpenCodeAskGoneWhileShown/not_listed', [(A, '''	case !pending:
		o.goneOutside(ask.Permission, gen, sid, turn)''', '''	case !pending:''')]),
    'gonesession': (L, 'TestOpenCodeAskGoneWhileShown/the_session_gone', [(A, '''		o.goneOutside(ask.Permission, gen, sid, turn)
		return "gone"
	case err != nil:''', '''		return "gone"
	case err != nil:''')]),
    'gonegen': (L, 'TestOpenCodeAskGoneOfAnOlderLaunch', [(OW, '''	if o.gen != gen || turn() != sid {
		return
	}
	o.replied[pid] = true''', '''	_, _ = gen, sid
	o.replied[pid] = true''')]),
    # Every waiter returns: an answer waiting for the slot ends with the daemon.
    'daemonstop': (L, 'TestOpenCodeAnswerEndsWithTheDaemon', [(A, '''	if !o.waitSlot(ctx, slot, &op) {''', '''	if !o.waitSlot(context.Background(), slot, &op) {''')]),
}


def run(name):
    pkg, test, edits = M[name]
    files = []
    for f, old, new in edits:
        p = os.path.join(GO, f)
        src = open(p).read()
        if src.count(old) != 1:
            return 'APPLY FAILED (%s: %d matches)' % (f, src.count(old))
        open(p, 'w').write(src.replace(old, new))
        files.append('go/' + f)
    try:
        top, _, sub = test.partition('/')
        pat = '^' + top + '$' + ('/^' + sub + '$' if sub else '')
        env = dict(os.environ, PATH=os.path.expanduser('~/.local/go/bin') + ':' + os.environ['PATH'])
        r = subprocess.run(['go', '-C', GO, 'test', '-count=1', '-run', pat, pkg], capture_output=True, text=True, env=env, timeout=300)
        out = r.stdout + r.stderr
        if r.returncode == 0:
            return 'SURVIVED'
        if '[build failed]' in out or 'setup failed' in out:
            return 'BUILD FAILED ' + out[-300:]
        if 'panic: test timed out' in out:
            return 'TIMEOUT'
        fails = [l.strip() for l in out.splitlines() if l.strip().startswith('--- FAIL') or '_test.go:' in l][:3]
        return 'CAUGHT ' + ' | '.join(fails)
    except subprocess.TimeoutExpired:
        return 'TIMEOUT'
    finally:
        subprocess.run(['git', '-C', ROOT, 'restore', '--'] + files)


if __name__ == '__main__':
    bad = 0
    for name in sys.argv[1:] or list(M):
        out = run(name)
        bad += not out.startswith('CAUGHT')
        print(name, out, flush=True)
    sys.exit(1 if bad else 0)
