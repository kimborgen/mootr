#!/usr/bin/env python3
"""Mutations of the Go daemon's requested rest, its wake and the remote wait's sender (S-4332): each one breaks one rule of
the rest's checks, its re-check before the kill, the wake, the cleanup or the forwarded reply, and the test named with it
must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4332-rest.py [--equivalent] [NAME...]

MUTANT_COUNT=20 runs each mutant's test 20 times.

Tally (2026-10-29, S-4332 after its review): all 24 CAUGHT at MUTANT_COUNT=1; the interleaving ones (pokedundo,
pokeflight, wakeserial, seamblocked, wakerecheck, archivewaits, archivetimers) CAUGHT 20 failing runs of 20 at
MUTANT_COUNT=20. Round 2: ocstarting and octurn CAUGHT 20 of 20 at MUTANT_COUNT=20.

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
RE, DR, PU, OR = 'internal/lifecycle/rest.go', 'internal/db/rest.go', 'internal/lifecycle/push.go', 'internal/lifecycle/org.go'
CT, SD, SS = 'internal/db/control.go', 'internal/db/send.go', 'internal/server/send.go'
OC, PA = 'internal/lifecycle/opencode.go', 'internal/lifecycle/pause.go'
L = './internal/lifecycle/'
S = './internal/server/'

# name: (package, test, [(file, old, new)])
M = {
    # The rest's transaction reads the wait it was asked with, the unpushed mail and the turn's drop.
    'txwait': (L, 'TestRestRefusals', [(DR, '\tif !requested {\n', '\tif false {\n')]),
    'txmail': (L, 'TestRestRefusals', [(DR, 'err != nil || len(mail) > 0 {', 'err != nil || len(mail) > 99 {')]),
    'turndrop': (L, 'TestRestRefusals', [(RE, '\tif _, err := l.db.DropRestRequests(ctx, id); err != nil {', '\tif _, err := l.db.DropRestRequests(ctx, id+"x"); err != nil {')]),
    # An OpenCode execution that starts is a new turn: it drops the request too.
    'octurn': (L, 'TestRestDroppedOnOpenCodeTurnStart', [(OC, '\t\t\tl.restTurnStarted(ctx, a.ID)\n', '')]),
    # Any start not on a working agent drops it, a woken (starting) one too, not only an idle or waiting one.
    'ocstarting': (L, 'TestRestDroppedOnOpenCodeTurnStart', [(OC, 'if a.Activity != "working" {', 'if a.Activity == "idle" || a.Activity == "waiting" {')]),
    # The request is stamped only while the wait's until is the one its creation returned.
    'requntil': ('./internal/db/', 'TestRequestRestUntilMoved', [(DR, '|| deref(ws[0].Until) != deref(until) || (ws[0].Until == nil) != (until == nil) {', '{')]),
    'noticecheck': (L, 'TestRestRefusals', [(RE, '\tif len(l.notices[id]) > 0 {\n\t\tl.mu.Unlock()', '\tif false {\n\t\tl.mu.Unlock()')]),
    # The re-check after the commit, before the kill: a poked flight takes the rest back.
    'pokedundo': (L, 'TestNoticeBetweenRestCommitAndKill', [(RE, '\tcase poked:\n', '\tcase false && poked:\n')]),
    'pokeflight': (L, 'TestNoticeBetweenRestCommitAndKill', [(RE, 'if f := l.rest.flights[id]; f != nil {', 'if f := l.rest.flights[id]; f != nil && false {')]),
    # Every mail and notice reaches the waker; the wake re-reads the rest in serial, so two wakes launch once.
    'pushpoke': (L, 'TestRestAndWakeOnMail', [(PU, '\tl.restPoke(id)\n', '')]),
    # A wake runs in the agent's serial, so mail that finds it resting queues behind the rest's kill.
    'wakeserial': (L, 'TestMailBetweenRestLandAndKill', [(RE, 'why string) (string, error) {\n\tout := ""\n\terr := l.serial(ctx, id, func(ctx context.Context) error {', 'why string) (string, error) {\n\tout := ""\n\terr := func(fn func(context.Context) error) error { return fn(ctx) }(func(ctx context.Context) error {')]),
    'wakerecheck': (L, 'TestTwoWakesLaunchOnce', [(RE, '\t\tif err != nil || !isResting(a) {\n\t\t\tout = "not resting"', '\t\tif err != nil {\n\t\t\tout = "not resting"')]),
    'waitnothing': (L, 'TestFailedWakeStaysResting', [(RE, '\t\tif len(mail) == 0 && notices == 0 {', '\t\tif len(mail) < 0 && notices < 0 {')]),
    'failedowner': (L, 'TestFailedWakeStaysResting', [(RE, '\t\t\t\tl.update(ctx, id, db.Field{Col: "paused_by", Val: db.RestOwnerJSON})\n', '')]),
    # The request outlives a restart: the sweep rests what the old daemon's timer would have.
    'sweeprequest': (L, 'TestRestSurvivesARestart', [(RE, '\t\t\tl.restIfRequested(ctx, id)\n', '\t\t\t_ = id\n')]),
    # The archive drops the waits and the rest's timers.
    'archivewaits': (L, 'TestArchiveDuringRestKill', [(CT, '\t\tif err := runSQL(conn, "DELETE FROM waits WHERE agent_id = ?", a.ID); err != nil {\n\t\t\treturn err\n\t\t}\n', '')]),
    'archivetimers': (L, 'TestArchiveDuringRestKill', [(OR, '\tl.restForget(id)\n', '')]),
    # A forwarded reply clears a wait only when it is from its sender.
    'foreign': (S, 'TestForwardedReplyClearsOnlyItsOwnSendersWait', [(SD, 'target == m.From && !m.ForeignSender', 'target == m.From')]),
    'localsender': (S, 'TestForwardedReplyClearsOnlyItsOwnSendersWait', [(SS, '\t\treturn in.itsa != nil && ok && home.Name', '\t\treturn true || in.itsa != nil && ok && home.Name')]),
    # (a) An itsa_id alone isn't enough: the ITSA home must be a peer, not this machine.
    'localhome': (S, 'TestForwardedReplyClearsOnlyItsOwnSendersWait', [(SS, 'in.itsa != nil && ok && home.Name != s.cfg.Machine &&', 'in.itsa != nil && (ok || true) &&')]),
    # (b) A peer sender needs a row on a configured peer, read without error, from the peer that sent it once known.
    'peerheld': (S, 'TestForwardedReplyClearsOnlyItsOwnSendersWait', [(SS, '\tif err != nil || !ok || !s.isPeer(ref.Machine) {', '\tif (err != nil || !ok || !s.isPeer(ref.Machine)) && false {')]),
    'peerconfigured': (S, 'TestForwardedReplyClearsOnlyItsOwnSendersWait', [(SS, '\tif err != nil || !ok || !s.isPeer(ref.Machine) {', '\tif err != nil || !ok {')]),
    'peerlookuperr': (S, 'TestForwardedReplyClearsOnlyItsOwnSendersWait', [(SS, '\tif err != nil || !ok || !s.isPeer(ref.Machine) {', '\tif (err != nil && false) || !ok || !s.isPeer(ref.Machine) {')]),
    'peerknown': (S, 'TestForwardedReplyClearsOnlyItsOwnSendersWait', [(SS, '\treturn !in.peerKnown || ref.Machine == in.peerSender', '\treturn true')]),
    # The seam: a call counts as blocked on serial only once it waits for the lock another holds.
    'seamblocked': (L, 'TestMailBetweenRestLandAndKill', [(PA, '\t\tm.blocked++\n', '')]),
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
        count = int(os.environ.get('MUTANT_COUNT', '1'))
        # A mutant the tests catch by an until's 20 s deadline takes that long per run.
        r = subprocess.run(['go', '-C', GO, 'test', '-count=%d' % count, '-timeout', '%ds' % (120 + 30 * count), '-run', test, pkg], capture_output=True, text=True, env=env, timeout=300 + 30 * count)
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
    equivalent = '--equivalent' in names
    names = [n for n in names if n != '--equivalent'] or list(EQUIV if equivalent else M)
    for name in names:
        out = run(name)
        bad += not out.startswith('SURVIVED' if equivalent else 'CAUGHT')
        print(name, out, flush=True)
    sys.exit(1 if bad else 0)
