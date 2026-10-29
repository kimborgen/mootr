#!/usr/bin/env python3
"""Mutations of the Go compaction's continue prompt (S-4319): each one breaks one rule, and the test named with it must
fail on a test, not on the build or a timeout.

    python3 go/mutants/s4319-compact-continue.py [NAME...]

MUTANT_COUNT=20 runs each mutant's test 20 times. Each mutant is applied to the working tree, its test run, and the
file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
LC, CP, OC = 'internal/lifecycle/lifecycle.go', 'internal/lifecycle/compact.go', 'internal/lifecycle/occompact.go'
L = './internal/lifecycle/'
RC = 'internal/lifecycle/recover.go'

# name: (package, test, [(file, old, new)])
M = {
    # A compaction's prompt is kept at the first held check and at the late one.
    'keepstart': (L, 'TestCompactPromptHeldAtStart', [(LC, '		l.keepCompactPrompt(ctx, a.ID, kind, prompt)\n', '')]),
    'keeplate': (L, 'TestCompactPromptHeldLate', [(LC, '\t\t\tl.keepCompactPrompt(ctx, now.ID, kind, prompt)\n', '')]),
    'keepany': (L, 'TestCompactPromptHeldAtStart', [(LC, 'if kind == "compact" {', 'if kind != "" {')]),
    # The default continue prompt, for the interrupting reasons only, on both harnesses.
    'ocdefault': (L, 'TestOpenCodeCompactContinue', [(OC, 'prompt := compactPrompt(p)', 'prompt := pstr(p, "prompt")')]),
    'claudedefault': (L, 'TestCompactPrompt', [(CP, 'case "requested by the agent", "enforcement threshold":', 'case "never":')]),
    'idledefault': (L, 'TestCompactPrompt', [(CP, 'case "requested by the agent", "enforcement threshold":', 'case "requested by the agent", "enforcement threshold", "requested":')]),
    # A surviving compactor is killed on restart (the first match is the shut-down recovery's, which the test passes through).
    'nokill': (L, 'TestSurvivingCompactorKilledOnRestart', [(RC, 'left := proctree.CompactorProcesses(a.ID, *a.SessionID, a.Cwd)\n\t\t\tif len(left) > 0 {', 'left := proctree.CompactorProcesses(a.ID, *a.SessionID, a.Cwd)\n\t\t\tif len(left) > 99 {')]),
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
        runs = sum(1 for l in out.splitlines() if l.startswith('--- FAIL: ' + test.split('|')[0] + ' ('))
        return 'CAUGHT %d failing runs: ' % runs + ' | '.join(fails)
    except subprocess.TimeoutExpired:
        return 'TIMEOUT'
    finally:
        subprocess.run(['git', '-C', ROOT, 'restore', '--'] + files)


if __name__ == '__main__':
    bad = 0
    names = sys.argv[1:]
    equivalent = False
    names = [n for n in names if n != '--equivalent'] or list(M)
    for name in names:
        out = run(name)
        bad += not out.startswith('SURVIVED' if equivalent else 'CAUGHT')
        print(name, out, flush=True)
    sys.exit(1 if bad else 0)
