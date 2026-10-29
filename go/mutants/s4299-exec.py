#!/usr/bin/env python3
"""Mutations of the Go daemon's OpenCode execution binding (S-4299): each one breaks one guard of an execution's start,
end or credit (owner.startExec, endExec, creditExec), and the test named with it must fail on a test, not on the build or
a timeout.

    python3 go/mutants/s4299-exec.py [--equivalent] [NAME...]

MUTANT_COUNT=20 runs each mutant's test 20 times (the interleaving test's, which must fail on every run).

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.

Tally (2026-10-29, MUTANT_COUNT=20): 21 of 21 caught, each on 20 of 20 runs; no equivalents.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
OW, OD = 'internal/lifecycle/owner.go', 'internal/lifecycle/opencode.go'
L = './internal/lifecycle/'
OWN = 'TestOwnerExec$'
EARLIER = 'TestOpenCodeEndOfAnEarlierLaunch$'
END = '\tbinds = m.set && m.gen == gen && (m.sid == "" || m.sid == sid) && cur == sid && sid != "" && !launching'
CONSUME = '\tif binds && m.sid == "" {\n\t\to.exec = execMark{}\n\t}\n'
CREDIT = '\tif o.launched > o.launchEnd {\n\t\to.exec = execMark{}\n\t\treturn\n\t}\n\to.exec = execMark{set: true, gen: o.gen}'
START = 'ok = cur == sid && o.launched <= o.launchEnd'
CONNECT = '\tfor _, o := range owners {\n\t\to.creditExec()\n\t}'
FRESH = '\t\texec: execMark{set: true}}'
STARTEV = 'sid, gen, ok := l.ownerOf(a.ID).startExec(ocSession, l.runningTurn(ctx, a.ID))'
COMPACTEV = 'if _, _, ok := l.ownerOf(a.ID).startExec(ocSession, l.runningTurn(ctx, a.ID)); ok {'
WORKING = '\t\tif !ok {\n\t\t\treturn\n\t\t}\n\t\tset("working", nil)'
STALE = '\t\tif !binds {\n\t\t\tl.jobAt(a.ID, "ended")\n\t\t\treturn\n\t\t}'
PUSH = '\t\tl.SchedulePush(a.ID)\n\t\tl.PollCreditsAfterTurn(a)\n'
BOTH = 'TestOpenCodeEndOfAnEarlierLaunch$|TestOpenCodeCompactionEndsItsTurn$'

# name: (package, test, [(file, old, new)])
M = {
    # An end: the generation its execution started (or was credited) under, its session, the row's, no launch in flight.
    'endgen': (L, OWN + '|' + EARLIER, [(OW, END, END.replace('m.gen == gen && ', ''))]),
    # The interleaving test alone: an end queued on the owner's lock behind a launch that lands.
    'queuedgen': (L, 'TestOwnerExecEndQueuedBehindLaunch$', [(OW, END, END.replace('m.gen == gen && ', ''))]),
    'endsid': (L, OWN, [(OW, END, END.replace('(m.sid == "" || m.sid == sid) && ', ''))]),
    'endrow': (L, OWN, [(OW, END, END.replace('cur == sid && ', ''))]),
    'endempty': (L, OWN, [(OW, END, END.replace(' && sid != ""', ''))]),
    'endlaunch': (L, OWN, [(OW, END, END.replace(' && !launching', ''))]),
    # The credit is of the generation it was given under: a bump since leaves it stale; one credit or start, one end.
    'creditbump': (L, OWN + '|' + EARLIER, [(OW, END, END.replace('m.gen == gen', '(m.gen == gen || m.sid == "")'))]),
    'endonce': (L, OWN, [(OW, CONSUME, '')]),
    # A session's mark binds each end of its generation: a compaction's start and an execution's start, each with its end.
    'markconsume': (L, OWN + '|TestOpenCodeCompactionInsideAnExecution$', [(OW, CONSUME, CONSUME.replace(' && m.sid == ""', ''))]),
    # A start: the row runs its session, and no launch is in flight.
    'startrow': (L, OWN, [(OW, START, 'ok = o.launched <= o.launchEnd')]),
    'startlaunch': (L, OWN, [(OW, START, 'ok = cur == sid')]),
    # A reconnect's credit: none while a launch is in flight; given at each connect; a fresh owner's.
    'creditlaunch': (L, OWN, [(OW, CREDIT, '\to.exec = execMark{set: true, gen: o.gen}')]),
    'connectcredit': (L, 'TestOpenCodeEndWithItsStartUnseen$', [(OD, CONNECT, '\t_ = owners')]),
    'freshcredit': (L, 'TestOpenCodeEndWithItsStartUnseen$', [(OW, FRESH, '\t\texec: execMark{}}')]),
    # The event: an end that doesn't bind ends nothing of the turn; a start is recorded.
    'eventbinds': (L, EARLIER, [(OD, '\t\tif !binds {', '\t\tif false && !binds {')]),
    # A stale end runs no mail push and no credit poll: each moved above the binding's check.
    'pushstale': (L, EARLIER, [(OD, STALE, '\t\tl.SchedulePush(a.ID)\n' + STALE), (OD, PUSH, '\t\tl.PollCreditsAfterTurn(a)\n')]),
    'pollstale': (L, EARLIER, [(OD, STALE, '\t\tl.PollCreditsAfterTurn(a)\n' + STALE), (OD, PUSH, '\t\tl.SchedulePush(a.ID)\n')]),
    # A start refused writes no working state.
    'startworking': (L, 'TestOpenCodeRefusedStartWritesNothing$', [(OD, WORKING, '\t\tset("working", nil)\n\t\tif !ok {\n\t\t\treturn\n\t\t}')]),
    'compactworking': (L, 'TestOpenCodeRefusedStartWritesNothing$', [(OD, COMPACTEV, '_, _, ok := l.ownerOf(a.ID).startExec(ocSession, l.runningTurn(ctx, a.ID))\n\t\t_ = ok\n\t\tif true {')]),
    'compactstart': (L, 'TestOpenCodeCompactionEndsItsTurn$', [(OD, COMPACTEV, 'if true {')]),
    'eventstart': (L, EARLIER, [(OD, STARTEV, 'sid, gen := l.ownerOf(a.ID).bind(l.runningTurn(ctx, a.ID))\n\t\tok := true')]),
}


# Equivalent mutations, not in M: each is applied and run with --equivalent, and must SURVIVE; the reason is why.
EQUIV = {}


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
        r = subprocess.run(['go', '-C', GO, 'test', '-count=' + os.environ.get('MUTANT_COUNT', '1'), '-timeout', '120s', '-run', test, pkg], capture_output=True, text=True, env=env, timeout=300)
        out = r.stdout + r.stderr
        if r.returncode == 0:
            return 'SURVIVED'
        if '[build failed]' in out or 'setup failed' in out:
            return 'BUILD FAILED ' + out[-300:]
        if 'panic: test timed out' in out:
            return 'TIMEOUT'
        fails = [l.strip() for l in out.splitlines() if l.strip().startswith('--- FAIL') or '_test.go:' in l][:3]
        runs = sum(1 for l in out.splitlines() if l.startswith('--- FAIL: ' + test.split('|')[0].rstrip('$') + ' ('))
        return 'CAUGHT %d failing runs: ' % runs + ' | '.join(fails)
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
