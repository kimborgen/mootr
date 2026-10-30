#!/usr/bin/env python3
"""Mutations of the Go daemon's re-stop of an orphaned OpenCode turn (S-4254): each one breaks one contract line, and
the test named with it must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4254-restop.py [--equivalent] [NAME...]

MUTANT_COUNT=20 runs each mutant's test 20 times.

A mutant is CAUGHT only when its test fails in every run; else PARTIAL, a miss.

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
RC, RS, OW = 'internal/lifecycle/reconcile.go', 'internal/lifecycle/restop.go', 'internal/lifecycle/owner.go'
TS = 'internal/lifecycle/turnstop.go'
L = './internal/lifecycle/'

# name: (package, test, [(file, old, new)])
M = {
    # Reconcile asks after every stopped OpenCode agent with no pane: a failed quit stop, and one a restart cut short.
    'nopass': (L, 'TestRestopAfter(AFailedQuitStop|ARestartMidStop)', [(RC, '''		if orphanCandidate(a, gone) {
			l.restopOrphan(ctx, a, &listing)
		}''', '''''')]),
    # The harness-exit branch stops the turn it shuts down.
    'noexit': (L, 'TestRestopOnHarnessExit', [(RC, '''			if a.Harness == "opencode" {
				if fresh, err := l.db.GetAgent(ctx, a.ID); err == nil {
					l.restopOrphan(ctx, fresh, &listing)
				}
			}''', '''''')]),
    # Only a shut-down agent with no pane: a paused agent's push turn, or a TUI that runs, is left alone.
    'paused': (L, 'TestRestopPicksOnlyOrphans|TestRestopLeavesAPausedAgentsPushTurn', [(RS, '''a.Harness == "opencode" && a.Lifecycle == "shut_down"
}''', '''a.Harness == "opencode" && (a.Lifecycle == "shut_down" || a.Lifecycle == "paused")
}'''), (RS, '''cur.Lifecycle != "shut_down" ||''', '''(cur.Lifecycle != "shut_down" && cur.Lifecycle != "paused") ||''')]),
    # A session that never stops is tried again ever more rarely, and forgotten once the server no longer runs it.
    'nobackoff': (L, 'TestRestopBacksOff', [(OW, '''	if now.Before(try.next) {
		return nil, nil, false
	}''', '''''')]),
    'nodouble': (L, 'TestRestopBacksOff', [(OW, '''wait = min(restopFirstWait<<try.n, restopMaxWait)''', '''wait = restopFirstWait''')]),
    'noforget': (L, 'TestRestopBacksOff', [(RS, '''	if !active {
		o.restopped(sid)
		return
	}''', '''	if !active {
		return
	}''')]),
    # An unreadable listing is no answer.
    'failopen': (L, 'TestRestopUnreadableListing', [(RS, '''	if list.err != nil {
		return false, false
	}''', '''	if list.err != nil {
		return true, true
	}''')]),
    # The row read again decides: still stopped, the same session.
    'norow': (L, 'TestRestopRereadsTheRow', [(RS, '''err != nil || cur.Lifecycle != "shut_down" || l.serverTurn(cur) != sid || cur.UpdatedAt != a.UpdatedAt''', '''err != nil''')]),
    # The row unchanged since the pass read it, and no live pane now.
    'noupdated': (L, 'TestRestopRereadsTheRow', [(RS, ''' || cur.UpdatedAt != a.UpdatedAt {''', ''' {''')]),
    'nopane': (L, 'TestRestopRereadsTheRow', [(RS, '''	if l.tmux.HasSession(ctx, a.ID) && !l.tmux.IsDead(ctx, a.ID) {
		return
	}''', '''''')]),
    # The harness-exit branch re-stops on the row its own write left, not the pass's.
    'exitstale': (L, 'TestRestopOnHarnessExit', [(RC, '''				if fresh, err := l.db.GetAgent(ctx, a.ID); err == nil {
					l.restopOrphan(ctx, fresh, &listing)
				}''', '''				l.restopOrphan(ctx, a, &listing)''')]),
    # A failure is reported once per session until a stop is confirmed.
    'reportall': (L, 'TestRestopBacksOff', [(TS, '''			if o.noteFailureLocked(sid) {
				l.stopFailed(a.ID, err)
			}''', '''			l.stopFailed(a.ID, err)''')]),
    'noconfirm': (L, 'TestRestopBacksOff', [(TS, '''			o.confirmedLocked(sid)
''', '''''')]),
    # No launch in flight, checked before and again with the listing.
    # A launch that landed after the row read: restop refuses it before it is listed.
    'laterlaunch': (L, 'TestRestopRefusedForALaunchAfterItsRead/landed', [(OW, '''if o.launched > gen || o.launchEnd < o.launched {''', '''if o.launchEnd < o.launched {''')]),
    'inflight': (L, 'TestRestopSkipsALaunchInFlight', [(OW, '''	return o.gen, o.launchEnd >= o.launched''', '''	return o.gen, true'''), (OW, '''if o.launched > gen || o.launchEnd < o.launched {''', '''if o.launched > gen {''')]),
    # A launch after the read: the stop's keep gives it up before it sends anything.
    'nokeep': (L, 'TestRestopGivesUpForALaunchAfterItsListing|TestRestopRefusedForALaunchAfterItsRead/landed', [(OW, '''if o.launched > gen || o.launchEnd < o.launched {''', '''if o.launchEnd < o.launched {'''), (OW, '''	if o.launched > gen {
		op.cancelled.Store(true)
	}
	return !op.cancelled.Load()''', '''	return true''')]),
    # A launch after the stop is listed queues on the session's slot until the stop publishes.
    'nodrain': (L, 'TestLaunchQueuesBehindARestop', [(OW, '''	if !o.waitSlot(ctx, s, nil) {
		return ctx.Err()
	}
	o.leaveSlot(s, nil)
	return nil''', '''	return nil''')]),
}


# Equivalent mutations, not in M: each is applied and run with --equivalent, and must SURVIVE; the reason is why.
EQUIV = {
    # The snapshot's no-pane test only spares a row read: restopOrphan asks tmux again (HasSession && !IsDead) before it
    # lists the stop, and that refuses the same agents.
    'nogone': (L, 'TestRestopPicksOnlyOrphans', [(RS, '''return gone && a.Harness == "opencode"''', '''return a.Harness == "opencode"''')]),
    # The idle check before the listing only saves its GET: restop checks again under the owner's lock with the listing.
    'idlefirst': (L, 'TestRestopSkipsALaunchInFlight', [(OW, '''	return o.gen, o.launchEnd >= o.launched''', '''	return o.gen, true''')]),
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
        r = subprocess.run(['go', '-C', GO, 'test', '-count=' + os.environ.get('MUTANT_COUNT', '1'), '-timeout', '120s', '-run', test, pkg], capture_output=True, text=True, env=env, timeout=600)
        out = r.stdout + r.stderr
        if r.returncode == 0:
            return 'SURVIVED'
        if '[build failed]' in out or 'setup failed' in out:
            return 'BUILD FAILED ' + out[-300:]
        if 'panic: test timed out' in out:
            return 'TIMEOUT'
        fails = [l.strip() for l in out.splitlines() if l.strip().startswith('--- FAIL') or '_test.go:' in l][:3]
        # A run fails when any test the pattern names fails in it: the best test's count of failed runs.
        per = {}
        for l in out.splitlines():
            if l.startswith('--- FAIL: '):
                name = l.split()[2]
                per[name] = per.get(name, 0) + 1
        runs, count = max(per.values(), default=0), int(os.environ.get('MUTANT_COUNT', '1'))
        verdict = 'CAUGHT' if runs >= count else 'PARTIAL'
        tally = ', '.join('%s %d/%d' % (n, c, count) for n, c in sorted(per.items()))
        return '%s %d/%d runs failed (%s): ' % (verdict, runs, count, tally) + ' | '.join(fails)
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
