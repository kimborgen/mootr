#!/usr/bin/env python3
"""Mutations of the OpenCode ask sweep (S-4280): each one breaks one guard of the connect sweep, of the owner transition that
queues its ask, or of the gone answer's marker, and the test named with it must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4237-sweep.py [NAME...]

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
OW, SW, AS, PA = 'internal/lifecycle/owner.go', 'internal/lifecycle/asksweep.go', 'internal/lifecycle/ask.go', 'internal/adapters/opencode/ask.go'
L, O = './internal/lifecycle/', './internal/adapters/opencode/'
MODEL = 'TestOpenCodeSweepModel'
UNIT = 'TestOpenCodeSweep|TestOpenCodeGoneAnswer'

# name: (package, test, [(file, old, new)])
M = {
    # The binding: a launch in flight owns the agent.
    'bindlaunch': (L, MODEL, [(OW, 'return sid, o.gen, o.askSeq, sid != "" && o.launched <= o.launchEnd', 'return sid, o.gen, o.askSeq, sid != ""')]),
    # The queueing re-reads the generation, and the newer ask's count, under the owner's lock.
    'querygen': (L, MODEL, [(OW, '	if o.gen != gen || turn() != sid {\n		return false\n	}\n	var pick', '	if turn() != sid {\n		return false\n	}\n	var pick')]),
    'raiseseq': (L, MODEL, [(OW, '	if ask.swept && o.askSeq != ask.seen {', '	if ask.swept && false {')]),
    # What is the dialog's already is never replaced.
    'queryasked': (L, 'TestOpenCodeSweepNeverReplacesARaisedAsk', [(OW, '		if o.asked[askKey{a.sid, a.pid}] || o.parkedAt(a.pid) >= 0 || o.raisingAt(a.pid) {', '		if o.parkedAt(a.pid) >= 0 || o.raisingAt(a.pid) {')]),
    'queryparked': (L, UNIT, [(OW, '		if o.asked[askKey{a.sid, a.pid}] || o.parkedAt(a.pid) >= 0 || o.raisingAt(a.pid) {', '		if o.asked[askKey{a.sid, a.pid}] || o.raisingAt(a.pid) {')]),
    'queryraising': (L, UNIT, [(OW, '		if o.asked[askKey{a.sid, a.pid}] || o.parkedAt(a.pid) >= 0 || o.raisingAt(a.pid) {', '		if o.asked[askKey{a.sid, a.pid}] || o.parkedAt(a.pid) >= 0 {')]),
    # An event for a permission already answered, raised, parked, queued or being raised is neither queued nor counted.
    'eventanswered': (L, 'TestOpenCodeSweepModelPairs|TestOpenCodeSweepModel', [(OW, '		if o.answered(a.pid) || o.asked[askKey{a.sid, a.pid}] || o.parkedAt(a.pid) >= 0 {', '		if o.asked[askKey{a.sid, a.pid}] || o.parkedAt(a.pid) >= 0 {')]),
    'eventdup': (L, 'TestOpenCodeSweepSurvivesARepeatOfAnAskedEvent|TestOpenCodeSweepAndItsOwnEvent|TestOpenCodeAskLive|TestOpenCodeAskListingFails', [(OW, '		if o.answered(a.pid) || o.asked[askKey{a.sid, a.pid}] || o.parkedAt(a.pid) >= 0 {', '		if o.answered(a.pid) {')]),
    'eventcount': (L, 'TestOpenCodeSweepModel', [(OW, '	o.askSeq++\n	return o.queueRaiseLocked(fresh)', '	return o.queueRaiseLocked(fresh)')]),
    'replay': (L, 'TestOpenCodeSweepSameSessionAndItsEvent|TestOpenCodeRaiseFailsWhileItsEventComes|TestOpenCodeSweepModelPairs', [(OW, '			o.replay[a.pid] = a\n			continue', '			continue')]),
    'inflight': (L, 'TestOpenCodeSweepWhileAnAskIsInFlight', [(OW, '	o.raisingNow = ask.pid\n', '')]),
    # An answered ask is never reopened; the newest is the pick.
    'queryanswered': (L, UNIT + '|TestOpenCodeSweepModel', [(OW, '		if o.answered(a.pid) {\n			continue\n		}', '')]),
    'querynewest': (L, UNIT, [(OW, '		pick = &listed[i]', '		if pick == nil {\n			pick = &listed[i]\n		}')]),
    # The gone answer's marker.
    'gonemark': (L, UNIT, [(AS, 'sid, gen, gone := o.bindAnswer(turn, ask.Permission, ask.Session)', 'sid, gen := o.bind(turn)\n	gone := sid == "" || (ask.Session != "" && ask.Session != sid)')]),
    'goneparked': (L, UNIT, [(OW, '		if i := o.parkedAt(pid); i >= 0 {\n			o.parked = append(o.parked[:i], o.parked[i+1:]...)\n		}\n	}\n	return sid, gen, true', '	}\n	return sid, gen, true')]),
    # The sweep itself: one at a time, retried once when its listing fails, nothing for a session the server lost.
    'coalesce': (L, 'TestOpenCodeSweepCoalescesAndEnds', [(SW, '	if l.sweep.running {\n		l.sweep.again = true', '	if l.sweep.running && false {\n		l.sweep.again = true')]),
    'retry': (L, 'TestOpenCodeSweepRetriesAFailedListing', [(SW, '\t\tif o.armSweepRetry() {\n\t\t\tl.sweepAgainAfter(a.ID)\n\t\t}', '\t\t_ = o.armSweepRetry\n\t\t_ = l.sweepAgainAfter')]),
    'goneretry': (L, 'TestOpenCodeSweepRetriesAFailedListing', [(SW, '	case errors.Is(err, opencode.ErrSessionGone) || ctx.Err() != nil:', '	case (errors.Is(err, opencode.ErrSessionGone) && false) || ctx.Err() != nil:')]),
    'cleanup': (L, 'TestOpenCodeSweepCleanupWaitsForTheListing', [(SW, '	l.bg.Add(1)\n	go func() {\n		defer l.bg.Done()\n		for {\n			l.sweepAllAsks(l.ctx)', '	go func() {\n		for {\n			l.sweepAllAsks(l.ctx)')]),
    # The listing: another session's item, and a session the server has no more.
    'othersession': (O, 'TestPendingAsksFromTheCapture', [(PA, 'own != "" && own != sid', 'own != "" && own != sid && false')]),
    'sessiongone': (O, 'TestPendingAsksFromTheCapture', [(PA, 'ce.Status == http.StatusNotFound {\n		return nil, ErrSessionGone', 'ce.Status == 0 {\n		return nil, ErrSessionGone')]),
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
    for name in sys.argv[1:] or list(M):
        out = run(name)
        bad += not out.startswith('CAUGHT')
        print(name, out, flush=True)
    sys.exit(1 if bad else 0)
