#!/usr/bin/env python3
"""Mutations of the Go daemon's launch pane replace (S-4269): a launch's kill of the old pane, its token and its new pane
are one kill in flight in the agent's owner. Each one breaks one rule, and the test named with it must fail on a test, not
on the build or a timeout.

    python3 go/mutants/s4269-launch-kill.py [NAME...]

MUTANT_COUNT=20 runs each mutant's test 20 times.

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.

Tally (MUTANT_COUNT=20, 2026-10-28): every mutant CAUGHT in 20 of 20 runs: endafterkill, rawkill, killnowait, mintguard,
abandoned, ownkill, ownkillcount.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
OW, LC = 'internal/lifecycle/owner.go', 'internal/lifecycle/lifecycle.go'
L = './internal/lifecycle/'

# name: (package, test, [(file, old, new)])
M = {
    # The replace counts as a kill in flight until its new session is made: ended after the kill, a newer launch goes on.
    'endafterkill': (L, 'TestNewerLaunchWaitsForTheReplace$', [(OW, '\tif err == nil {\n\t\tif l.paneMaking != nil {', '\to.endPane()\n\tended = true\n\tif err == nil {\n\t\tif l.paneMaking != nil {')]),
    # The launch's raw kill again (the bug): the replace isn't counted, so a newer launch never waits.
    'rawkill': (L, 'TestNewerLaunchWaitsForTheReplace$', [(OW, '\t\t\t\to.kills++\n\t\t\t\to.replacing = true\n', '\t\t\t\to.replacing = true\n'), (OW, '\to.replacing = false\n\to.kills--\n\tif o.kills == 0 {\n\t\to.paneFree.Broadcast()\n\t}\n', '\to.replacing = false\n\to.paneFree.Broadcast()\n')]),
    # A kill waits for the replace in flight.
    'killnowait': (L, 'TestStopWaitsForTheReplace$', [(OW, 'for o.replacing {', 'for false && o.replacing {')]),
    # The token hash is written only while the launch is current, in one step with the check.
    'mintguard': (L, 'TestStopWaitsForTheReplace$', [(LC, 'wrote, err := l.ownerOf(id).whileCurrent(gen, nil, func() (bool, error) {', 'wrote, err := func(f func() (bool, error)) (bool, error) { return f() }(func() (bool, error) {')]),
    # A superseded launch is abandoned, not failed.
    # Round 2 (F1): a replace superseded by its end kills what it made, before its count ends.
    'ownkill': (L, 'TestSupersededReplaceKillsItsPane$', [(OW, '\tif ended = o.endPaneIfCurrent(gen); ended {', '\to.endPane()\n\tif ended = true; ended {')]),
    'ownkillcount': (L, 'TestSupersededReplaceKillsItsPane$', [(OW, '\tif ended = o.endPaneIfCurrent(gen); ended {\n\t\treturn true, err\n\t}\n', '\tcurrent := o.current(gen)\n\to.endPane()\n\tended = true\n\tif current {\n\t\treturn true, err\n\t}\n')]),
    'abandoned': (L, 'TestNewerLaunchWaitsForTheReplace$|TestStopWaitsForTheReplace$', [(LC, '\t\tif !l.current(a.ID, gen) {\n\t\t\treturn nil, nil\n\t\t}\n\t\treturn nil, err\n', '\t\treturn nil, err\n')]),
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
