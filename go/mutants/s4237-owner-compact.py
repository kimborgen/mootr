#!/usr/bin/env python3
"""Mutations of the Go daemon's OpenCode compaction and MCP reconnect through the per-agent owner (S-4237, PR 4e): each
one breaks one binding check or one case of the model test, and the test named with it must fail on a test, not on the
build or a timeout.

    python3 go/mutants/s4237-owner-compact.py [NAME...]

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
OW, OD = 'internal/lifecycle/owner.go', 'internal/lifecycle/opencode.go'
OO, OC, TE, CX, PE, CP, SV = ('internal/lifecycle/owner_oc.go', 'internal/lifecycle/occompact.go', 'internal/lifecycle/turnend.go',
                              'internal/lifecycle/context.go', 'internal/lifecycle/pending.go', 'internal/lifecycle/compact.go',
                              'internal/adapters/opencode/server.go')
L = './internal/lifecycle/'
MODEL = 'TestOpenCodeModel$'

HELD = '''	if !o.held(b) {
		return false
	}
	o.notes ='''
HELD_MARK = '''	if !o.held(b) {
		return false, nil
	}
	if err := write()'''

# name: (package, test, [(file, old, new)])
M = {
    # The owner's transitions (owner_oc.go): refused for a binding that does not hold.
    'heldgen': (L, 'TestOwnerReserve', [(OO, 'o.gen == b.gen && b.turn() == b.sid', 'b.turn() == b.sid')]),
    'heldsession': (L, 'TestOwnerReserve', [(OO, 'o.gen == b.gen && b.turn() == b.sid', 'o.gen == b.gen')]),
    'reservegone': (L, 'TestOwnerReserve', [(OO, 'case !o.held(b):\n\t\treturn reserveGone', 'case false:\n\t\treturn reserveGone')]),
    'reservebusy': (L, 'TestOwnerReserve', [(OO, 'case o.busyLocked(b):\n\t\treturn reserveBusy', 'case false:\n\t\treturn reserveBusy')]),
    'busysid': (L, 'TestOwnerReserve', [(OO, 'return c != nil && c.b.sid == b.sid && (', 'return c != nil && (')]),
    'unreserveid': (L, 'TestOwnerReserve', [(OO, 'if o.comp != nil && o.comp.b == b {', 'if o.comp != nil {')]),
    'finishid': (L, 'TestOwnerReserve', [(OO, 'if o.comp == nil || o.comp.b != b {', 'if o.comp == nil {')]),
    'notesheld': (L, 'TestOwnerNotes', [(OO, HELD, '	o.notes =')]),
    'clearid': (L, 'TestOwnerNotes', [(OO, 'if o.notes.by == b {', 'if true {')]),
    'markheld': (L, 'TestOwnerMark', [(OO, HELD_MARK, '	if err := write()')]),
    'measuresid': (L, 'TestOwnerMark', [(OO, 'if o.mark == nil || o.mark.sid != b.sid || !o.held(b) {', 'if o.mark == nil || !o.held(b) {')]),
    'measureheld': (L, 'TestOwnerMark', [(OO, 'if o.mark == nil || o.mark.sid != b.sid || !o.held(b) {', 'if o.mark == nil || o.mark.sid != b.sid {')]),
    'measurewrite': (L, 'TestOwnerMark', [(OO, 'if wrote, err := write(); err != nil || !wrote {', 'if _, err := write(); err != nil {')]),
    # A binding made from a row its caller read: the row's start, and no launch begun since.
    'epoch': (L, MODEL, [(TE, 'epochOf(cur) != epoch || o.launched > o.launchEnd', 'o.launched > o.launchEnd')]),
    'inflight': (L, MODEL, [(TE, 'epochOf(cur) != epoch || o.launched > o.launchEnd', 'epochOf(cur) != epoch')]),
    'rowtxn': (L, MODEL, [(TE, 'running(cur) && l.serverTurn(cur) == sid && epochOf(cur) == epoch', 'running(cur) && l.serverTurn(cur) == sid')]),
    'sigtxn': (L, MODEL, [(TE, 'running(a) && l.serverTurn(a) == sid && epochOf(a) == epoch }}', 'running(a) && l.serverTurn(a) == sid }}')]),
    # The claim: in the owner's step and on the row.
    'claimtxn': (L, MODEL, [(OC, '"compacting: "+pstr(p, "reason"), b.ok)', '"compacting: "+pstr(p, "reason"), nil)')]),
    # Post-call steps: the marks and the prompt only while the binding holds.
    'markheld2': (L, MODEL, [(OO, HELD_MARK, '	if err := write()')]),
    'prompt': (L, MODEL, [(OC, 'prompt != "" && b.still()', 'prompt != ""')]),
    'notescall': (L, MODEL, [(OO, HELD, '	o.notes =')]),
    # A pending compaction stays on the row until a claim runs it, and is the agent's: taken under the binding of the
    # signal, whose generation is read before the row.
    'pendinggen': (L, MODEL, [(PE, '''	sid, gen, launching := l.ownerOf(id).bindSignal(l.runningTurn(ctx, id))
	l.turnAt(id, "pending-gen")''', '''	l.turnAt(id, "pending-gen")
	sid, gen, launching := l.ownerOf(id).bindSignal(l.runningTurn(ctx, id))''')]),
    'pendingrowbind': (L, MODEL, [(PE, 'return l.ocRunPending(ctx, a, p, l.rowBinding(ctx, a))', 'return l.ocRunPending(ctx, a, p, l.turnBinding(ctx, a.ID, l.serverTurn(a), l.genOf(a.ID)))')]),
    'pendingtake': (L, MODEL, [(OC, 'if taken, e = l.db.TakePendingAction(ctx, a.ID, take); e == nil && !taken {', 'if e == nil && !taken {')]),
    'dispatchidle': (L, MODEL, [(PE, 'if p := pendingOf(a); p != nil && pstr(p, "type") == "compact" {', 'if p := pendingOf(a); false && p != nil {')]),
    # The request: bound before anything is reserved, claimed or left pending.
    'requestpending': (L, MODEL, [(OC, '''	if !b.update(ctx, db.Field{Col: "pending_action", Val: text(p)}) {
		return ocGone(a), nil
	}
	b.event(ctx, "pending", raw(p))''', '''	if err := l.db.UpdateAgent(ctx, a.ID, db.Field{Col: "pending_action", Val: text(p)}); err != nil {
		return "", err
	}
	b.event(ctx, "pending", raw(p))''')]),
    'dispatchrequest': (L, 'TestOpenCodeCompact$', [(CP, 'if a.Harness == "opencode" && a.Lifecycle != "shut_down" {\n\t\treturn l.ocRequest', 'if false {\n\t\treturn l.ocRequest')]),
    'measure': (L, 'TestOpenCodeCompact$', [(CX, '} else if b.o.measure(b, func() (bool, error) {', '} else if false && b.o.measure(b, func() (bool, error) {')]),
    # The reconnect: the row's session, its directory, the start, and the call only while they hold.
    'reconnectcwd': (L, 'TestOpenCodeReconnect$', [(OC, '''	if fresh.Cwd != a.Cwd {
		return false, nil
	}''', '	_ = fresh')]),
    'reconnectstill': (L, MODEL, [(OC, '''	if !b.still() {
		return false, nil
	}
	return true, l.opencode.ConnectMCP(ctx, a.Cwd)''', '	return true, l.opencode.ConnectMCP(ctx, a.Cwd)')]),
    'reconnectproceed': (L, 'TestOpenCodeReconnectGuards', [(OC, '''	if proceed != nil && !proceed() {
		return false, nil
	}''', '')]),
    # Ring 1 of #1327: the idle signal is bound where it happens (generation and session, before it is dispatched), a
    # launch in flight refuses a signal-bound action, the generic take leaves an OpenCode compaction to the owner-bound
    # path, the claim checks the owner's generation, and a stale request's dropped event is guarded.
    'idlebind': (L, MODEL, [(PE, 'l.onIdleBound(l.ctx, id, sid, gen)', 'l.OnIdle(l.ctx, id)')]),
    # A launch in flight at the signal is decided at the bind, under the owner's lock (owner.bindSignal): a check made where
    # the binding is used passes once the launch has settled, so it is the three uses that are cut, each alone.
    'idlelazy': (L, 'TestOpenCodeIdle', [(OW, 'return turn(), o.gen, o.launched > o.launchEnd', 'return turn(), o.gen, false')]),
    'idlesid': (L, 'TestOpenCodeIdleBeforeLaunchSettles', [(OW, '''	if launching {
		return ""
	}
	return sid''', '''	return sid''')]),
    # 'idlereads' (the reads' launch check) moved into owner.endExec with S-4299: its mutants are go/mutants/s4299-exec.py's.
    'generictake': (L, 'TestOpenCodeIdleWriterBetweenReads', [(PE, 'return !l.leftForTS(a, p) && !(a.Harness == "opencode" && pstr(p, "type") == "compact")', 'return !l.leftForTS(a, p)')]),
    'claimowner': (L, MODEL, [(OC, '''	_, err := b.write(func() error {
		l.turnAt(a.ID, "compact-claim")''', '''	_, err := b.o.writeIf(b.o.now(), b.sid, b.turn, func() error {
		l.turnAt(a.ID, "compact-claim")''')]),
    # The two layers that keep a stale request from recording a dropped event, the early check and the guarded event: each
    # alone is equivalent (EQUIV requeststill), both removed are not.
    'droppedunguarded': (L, MODEL, [(OC, '	b.event(ctx, "compact:dropped", reasonEvent{Reason: reason})', '	l.event(ctx, a.ID, "compact:dropped", reasonEvent{Reason: reason})'), (OC, '''	l.turnAt(a.ID, "request-bound")
	if !b.still() {
		return ocGone(a), nil
	}''', '''	l.turnAt(a.ID, "request-bound")''')]),
    # Nothing the server answered reaches an error.
    'errorbody': ('./internal/adapters/opencode/', 'TestTurnEndErrorBody', [(SV, '''		return nil, &CallError{Method: method, Path: path, Status: res.StatusCode}''', '''		return nil, fmt.Errorf("OpenCode %s %s: %d %s", method, path, res.StatusCode, text)''')]),
    # A pending runner leaves its pending action where it is: rewriting it overwrites a different one a concurrent writer
    # put there since it read the row.
    'pendingrewrite': (L, 'TestOpenCodePendingReplacedWhileUnclaimed', [(OC, 'return take != "" || b.update(', 'return b.update(')]),
}


# Equivalent mutations, not in M: each is applied and run with --equivalent, and must SURVIVE; the reason is why.
EQUIV = {
    # ocRequest's early check. A stale request that gets past it ends at the owner's reserve (reserveGone), at the busy
    # check (the dropped event is the binding's own, ocDropped: none for a stale one, only another message), or at the
    # pending write (b.update refuses); nothing is changed either way.
    'requeststill': (L, MODEL, [(OC, '''	l.turnAt(a.ID, "request-bound")
	if !b.still() {
		return ocGone(a), nil
	}''', '''	l.turnAt(a.ID, "request-bound")''')]),
    # reconnectOpenCode's first check: the second, right before the call, refuses the same binding.
    'reconnectfirst': (L, MODEL, [(OC, '''	b := l.rowBinding(ctx, a)
	if !b.still() {
		return false, nil
	}
	fresh, err''', '''	b := l.rowBinding(ctx, a)
	fresh, err''')]),
}


def run(name):
    pkg, test, edits = (M if name in M else EQUIV)[name]
    files = []
    for f, old, new in edits:
        p = os.path.join(GO, f)
        src = open(p).read()
        if src.count(old) != 1:
            return 'APPLY FAILED (%s: %d matches)' % (f, src.count(old))
        open(p, 'w').write(src.replace(old, new))
        files.append('go/' + f)
    try:
        env = dict(os.environ, PATH=os.path.expanduser('~/.local/go/bin') + ':' + os.environ['PATH'])
        r = subprocess.run(['go', '-C', GO, 'test', '-count=1', '-timeout', '120s', '-run', test, pkg], capture_output=True, text=True, env=env, timeout=300)
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
    names = sys.argv[1:]
    equivalent = '--equivalent' in names
    names = [n for n in names if n != '--equivalent'] or list(EQUIV if equivalent else M)
    for name in names:
        out = run(name)
        bad += not out.startswith('SURVIVED' if equivalent else 'CAUGHT')
        print(name, out, flush=True)
    sys.exit(1 if bad else 0)
