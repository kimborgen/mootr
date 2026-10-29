#!/usr/bin/env python3
"""Mutations of the Go daemon's OpenCode job waits (S-4237, PR 4c): each one breaks one contract line or interleaving,
and the test named with it must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4237-jobs.py [NAME...]

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
J, OW, OC, DB = 'internal/lifecycle/jobs.go', 'internal/lifecycle/owner.go', 'internal/lifecycle/opencode.go', 'internal/db/waits.go'
L, D = './internal/lifecycle/', './internal/db/'

# name: (package, test, [(file, old, new)])
M = {
    # 1. The waits are written at an execution's end, before the idle write.
    'endsync': (L, 'TestJobWaitsExecutionEnd', [(OC, '''		l.syncJobWaits(ctx, a.ID, bound, gen)
		l.jobAt(a.ID, "ended")
		if wrote''', '''		_, _ = bound, gen
		l.jobAt(a.ID, "ended")
		if wrote''')]),
    # 1. An execution start replaces the waits from the tracking.
    'startsync': (L, 'TestJobWaitsExecutionEnd', [(OC, '''		set("working", nil)
		l.syncJobWaits(ctx, a.ID, sid, gen)''', '''		set("working", nil)
		_, _ = sid, gen''')]),
    # 2. Only the agent's session's shells; only running children.
    'sessionfilter': (L, 'TestJobWaitsExecutionEnd', [(J, '''		if s.session == session {''', '''		if true {''')]),
    'runningfilter': (L, 'TestJobWaitsExecutionEnd', [(J, '''		if c.parent == session && c.running {''', '''		if c.parent == session {''')]),
    # 2. A child's end starts its grace.
    'childend': (L, 'TestJobWaitsExecutionEnd', [(J, '''			c.running = false
			l.jobEnded(ctx, c.parent, id)''', '''			c.running = false''')]),
    # 3. The grace clears only while the agent is waiting, only that target, only a job not running again.
    'graceactivity': (D, 'TestClearHookWaitWhile', [(DB, '''string(a.Activity) != activity''', '''string(a.Activity) == "\\x00"''')]),
    'gracetarget': (L, 'TestJobWaitsGrace', [(DB, '''AND kind = ? AND target = ?", agentID, kind, target)''', '''AND kind = ? AND ? != ''", agentID, kind, target)''')]),
    'graceagain': (L, 'TestJobWaitsGraceStale/running_again', [(J, '''	if t.running(session, target) {
		return
	}''', '')]),
    # 3. A grace of an older launch or session never clears a newer one's.
    'gracegen': (L, 'TestJobWaitsGraceStale/a_new_launch', [(OW, '''	if o.gen != gen || turn() != sid {
		return false, nil
	}
	return true, write()''', '''	if turn() != sid {
		return false, nil
	}
	return true, write()''')]),
    'gracesession': (L, 'TestJobWaitsGraceStale/another_session', [(OW, '''	if o.gen != gen || turn() != sid {
		return false, nil
	}
	return true, write()''', '''	if o.gen != gen {
		return false, nil
	}
	return true, write()''')]),
    'gracestop': (L, 'TestJobWaitsGraceStale/a_stop', [(OW, '''	if o.gen != gen || turn() != sid {
		return false, nil
	}
	return true, write()''', '''	if turn() != sid {
		return false, nil
	}
	return true, write()''')]),
    'gracearchive': (L, 'TestJobWaitsGraceStale/an_archive', [(OW, '''	if o.gen != gen || turn() != sid {
		return false, nil
	}
	return true, write()''', '''	if o.gen != gen {
		return false, nil
	}
	return true, write()''')]),
    'gracenewlaunch': (L, 'TestJobWaitsGraceStale/a_new_launch', [(J, '''	fire := func() { l.expireJob(a.ID, session, gen, target) }''', '''	fire := func() { _ = gen; l.expireJob(a.ID, session, l.genOf(a.ID), target) }''')]),
    # 4. A seed keeps what an event touched since it began.
    'touchedkeep': (L, 'TestJobSeedEventsDuringReads', [(J, '''		if touched[s.id] {
			continue
		}''', '''		_ = touched''')]),
    'touchedkeepchild': (L, 'TestJobSeedEventsDuringReads', [(J, '''		if touched[c.id] {''', '''		if false {''')]),
    'touchedkeepdrop': (L, 'TestJobSeedEventsDuringReads', [(J, '''		if !nowShells[id] && !touched[id] {''', '''		if !nowShells[id] {''')]),
    'touchedkeepdropchild': (L, 'TestJobSeedEventsDuringReads', [(J, '''		if !nowChildren[id] && !touched[id] {''', '''		if !nowChildren[id] {''')]),
    'touchedexit': (L, 'TestJobSeedEventsDuringReads', [(J, '''	t.touch(touched...)''', '''	if ev.typ != "shell.exited" {
		t.touch(touched...)
	}''')]),
    # 4. Concurrent seeds coalesce, and a connect during one makes one more follow it.
    'coalesce': (L, 'TestJobSeedCoalescesAndFailsSafe', [(J, '''	if t.touched != nil {
		t.again = true
		t.mu.Unlock()
		return
	}''', '')]),
    'dirty': (L, 'TestJobSeedCoalescesAndFailsSafe', [(J, '''	if t.touched != nil {
		t.again = true''', '''	if t.touched != nil {''')]),
    'dirtyrun': (L, 'TestJobSeedCoalescesAndFailsSafe', [(J, '''	again := t.again && ctx.Err() == nil''', '''	again := false''')]),
    # 4. An event that changes no state never discards the seed's record of a job the tracker doesn't know.
    'touchany': (L, 'TestJobSeedKeepsListedJobsAnEventNamed', [(J, '''	d := ev.data
	info, _ :=''', '''	d := ev.data
	t.touch(ocStr(d, "id"), ocStr(d, "sessionID"))
	info, _ :=''')]),
    # 4. The seed's recheck of idle or waiting is in the write's transaction (db).
    'dbrecheck': (D, 'TestReplaceHookWaitsWhile', [(DB, '''			if !ok {
				return nil
			}
		}
		wrote = true''', '''			_ = ok
		}
		wrote = true''')]),
    # The ready write's predicate (a turn between the check and the write keeps its state).
    'readypred': (L, 'TestOpenCodeReadyKeepsATurn', [(OC, '''		return now.Activity == "starting" && deref(now.ActivityDetail) != "with prompt"''', '''		return true''')]),
    # 4. A child an event touched that nothing tracked is adopted with the event's state.
    'adopt': (L, 'TestJobSeedAdoptsAnUntrackedChild', [(J, '''			if ran, ok := ran[c.id]; ok && t.children[c.id] == nil {''', '''			if ran, ok := ran[c.id]; false && ok {''')]),
    'adoptstate': (L, 'TestJobSeedAdoptsAnUntrackedChild', [(J, '''				c.running = ran''', '''				c.running = true; _ = ran''')]),
    'adoptended': (L, 'TestJobSeedAdoptsAnUntrackedChild', [(J, '''		} else if c == nil && t.touched != nil {
			t.ran[id] = false
		}''', '''		}''')]),
    # 4. The resync's write rechecks idle or waiting in its transaction.
    'resyncrecheck': (L, 'TestJobSeedResyncRechecksActivity', [(J, '''l.syncLocked(ctx, a.ID, sid, gen, "idle", "waiting")''', '''l.syncLocked(ctx, a.ID, sid, gen)''')]),
    # 4. A failed seed leaves the tracking, and ends.
    'seedfail': (L, 'TestJobSeedCoalescesAndFailsSafe', [(J, '''	} else {
		l.applySeed(ctx, agents, shells, children)
	}''', '''	}
	l.applySeed(ctx, agents, shells, children)''')]),
    'seedend': (L, 'TestJobSeedCoalescesAndFailsSafe', [(J, '''		t.touched, t.ran = nil, nil
		if ctx.Err() == nil {''', '''		if ctx.Err() == nil {''')]),
    # 4. Applying resyncs the waits of agents that are idle or waiting, not of a working one.
    'resync': (L, 'TestJobSeedRestoresWaits', [(J, '''			l.syncLocked(ctx, a.ID, sid, gen, "idle", "waiting")''', '''			_ = gen''')]),
    'resyncworking': (L, 'TestJobSeedRestoresWaits', [(J, '''gen, "idle", "waiting")''', '''gen, "idle", "waiting", "working")''')]),
    # 5. Writes go through the agent's owner: a stale generation or session writes nothing.
    'writegen': (L, 'TestJobWaitsWriteIsCurrent', [(OW, '''	if o.gen != gen || turn() != sid {
		return false, nil
	}
	return true, write()''', '''	if turn() != sid {
		return false, nil
	}
	return true, write()''')]),
    'writesession': (L, 'TestJobWaitsWriteIsCurrent', [(OW, '''	if o.gen != gen || turn() != sid {
		return false, nil
	}
	return true, write()''', '''	if o.gen != gen {
		return false, nil
	}
	return true, write()''')]),
    # 5. A stop or launch between the waits and the idle: no idle over it.
    'idleguard': (L, 'TestJobWaitsStopBetweenWaitsAndIdle', [(OC, '''wrote, err := l.updateIfCurrent(ctx, a.ID, gen, nil, db.Field''', '''wrote, err := l.updateIfCurrent(ctx, a.ID, l.genOf(a.ID), nil, db.Field''')]),
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
        r = subprocess.run(['go', '-C', GO, 'test', '-count=1', '-timeout', '120s', '-run', pat, pkg], capture_output=True, text=True, env=env, timeout=300)
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
