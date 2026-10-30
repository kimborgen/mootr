#!/usr/bin/env python3
"""Mutations of the Go GitHub poller (S-4329): each one breaks one rule of the poll, the commit, the cleanup or watch_pr,
and the test named with it must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4329-github.py [--equivalent] [NAME...]

MUTANT_COUNT=20 runs each mutant's test 20 times (the interleaving mutants, which need every schedule to fail).

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
PO, CL, PL, ST = 'internal/ghpoll/poller.go', 'internal/ghpoll/client.go', 'internal/ghpoll/poll.go', 'internal/db/watch_state.go'
WP = 'internal/mcp/tools_watchpr.go'
G = './internal/ghpoll/'
MC = './internal/mcp/'

# name: (package, test, [(file, old, new)])
M = {
    # The apply: the check that the subject is still watched, the events and the snapshot are one transaction, queued behind an unwatch.
    'applynocheck': (G, 'TestAnApplyQueuedBehindAnUnwatchStoresNothing', [(ST, '\t\tif err != nil || !w[subject] {\n\t\t\treturn err\n\t\t}\n\t\tfor _, e := range evs {', '\t\tif err != nil {\n\t\t\treturn err\n\t\t}\n\t\t_ = w\n\t\tfor _, e := range evs {')]),
    'applysplit': (G, 'TestAnApplyQueuedBehindAnUnwatchStoresNothing', [
        (ST, '''	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		outs, written = nil, false
		w, err := watchedConn(conn, nowMs, of)
		if err != nil || !w[subject] {
			return err
		}
		for _, e := range evs {''', '''	var w map[string]bool
	err = d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		w, err = watchedConn(conn, nowMs, of)
		return err
	})
	if err != nil || !w[subject] {
		return nil, false, wrap("apply poll", err)
	}
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		outs, written = nil, false
		for _, e := range evs {''')]),
    'applyafter': (G, 'TestAMergeThatEndsTheWatchStoresTheFinalSnapshot|TestAnEventThatClearsTheOnlyWaitStoresTheSnapshot', [
        (ST, '''		w, err := watchedConn(conn, nowMs, of)
		if err != nil || !w[subject] {
			return err
		}
		for _, e := range evs {
			out, err := d.ingestConn(conn, e.In, e.Hooks)
			if err != nil {
				return err
			}
			outs = append(outs, out)
		}''', '''		for _, e := range evs {
			out, err := d.ingestConn(conn, e.In, e.Hooks)
			if err != nil {
				return err
			}
			outs = append(outs, out)
		}
		w, err := watchedConn(conn, nowMs, of)
		if err != nil || !w[subject] {
			return err
		}''')]),
    # The cleanup reads the watchers itself in its delete, keeps every PR's row, and keeps a young row.
    'dropnocheck': (G, 'TestCleanupRechecksTheWatchersInsideItsDelete', [(ST, '\t\t\tif w[s] {\n\t\t\t\tcontinue\n\t\t\t}\n', '\t\t\t_ = w\n')]),
    'dropsplit': (G, 'TestCleanupRechecksTheWatchersInsideItsDelete', [
        (ST, '''	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		dropped = nil
		w, err := watchedConn(conn, nowMs, of)
		if err != nil {
			return err
		}
		for _, s := range subjects {''', '''	var w map[string]bool
	if err = d.Read(ctx, func(conn *sqlite.Conn) (err error) {
		w, err = watchedConn(conn, nowMs, of)
		return err
	}); err != nil {
		return nil, wrap("drop watch state", err)
	}
	err = d.Write(ctx, func(conn *sqlite.Conn) error {
		dropped = nil
		for _, s := range subjects {''')]),
    'dropkeep': (G, 'TestCleanupKeepsFreshRowsDropsOldOnesAndKeepsMergedPRsAndWatchedRows', [(ST, 'subject = ? AND updated_at < ? AND NOT', 'subject = ? AND ? != \'\' AND NOT')]),
    'dropcoalesce': (G, 'TestCleanupKeepsFreshRowsDropsOldOnesAndKeepsMergedPRsAndWatchedRows', [(ST, "NOT COALESCE(json_extract(state, '$.type') = 'pr', 0)", "NOT (json_extract(state, '$.type') = 'pr')")]),
    'dropmerged': (G, 'TestCleanupKeepsFreshRowsDropsOldOnesAndKeepsMergedPRsAndWatchedRows', [(ST, " AND NOT COALESCE(json_extract(state, '$.type') = 'pr', 0)", '')]),
    'dropnothing': (G, 'TestCleanupKeepsFreshRowsDropsOldOnesAndKeepsMergedPRsAndWatchedRows', [(PO, '\tif _, err := p.o.Store.Drop(ctx, stale, p.o.Now().Add(-p.o.Keep)); err != nil {', '\tif _, err := p.o.Store.Drop(ctx, nil, p.o.Now().Add(-p.o.Keep)); err != nil {')]),
    'cleanupinflight': (G, 'TestCleanupWaitsForTheInFlightPoll', [(PO, '\tif !p.running.CompareAndSwap(false, true) {\n\t\treturn 0, ErrBusy\n\t}', '\tif p.running.Load() {\n\t\tp.cleanup(ctx, map[string]bool{})\n\t\treturn 0, ErrBusy\n\t}\n\tp.running.Store(true)')]),
    # Ticks never overlap; Close waits for the tick in flight.
    'overlap': (G, 'TestTicksNeverOverlapAndCloseWaitsForTheTickInFlight', [(PO, 'if !p.running.CompareAndSwap(false, true) {', 'if false {')]),
    'closenowait': (G, 'TestTicksNeverOverlapAndCloseWaitsForTheTickInFlight', [(PO, '\tif cancel != nil {\n\t\tcancel()\n\t}\n\tp.wg.Wait()', '\tif cancel != nil {\n\t\tcancel()\n\t}')]),
    # Statuses: only 200/304 succeed; a 403 that is the subject's own does not stop the others; a rate limit does.
    'anystatus': (G, 'TestAnyOtherStatusFailsTheWholePollForThatSubject', [(PL, '\tif r.Status == 200 || r.Status == 304 {\n\t\treturn nil\n\t}\n\tfor', '\tif r.Status != 429 && r.Status != 403 {\n\t\treturn nil\n\t}\n\tfor')]),
    'repopage': (G, 'TestARepositoryPollThatFailsOnAPageStoresNothing', [(PO.replace('poller', 'repo'), '\t\tif err := tr.check(r, path); err != nil {\n\t\t\treturn PollResult{}, err\n\t\t}\n\t\tv, err := jsjson.Parse(r.Body)', '\t\tif r.Status != 200 {\n\t\t\tbreak\n\t\t}\n\t\tv, err := jsjson.Parse(r.Body)')]),
    'global403': (G, 'TestAPermissionForbiddenFailsOnlyThatSubjectAndTheRateLimitStopsAll', [(PL, 'e.Global = r.Status == 429 || (r.Status == 403 && (r.Remaining == 0 || r.RetryAfter > 0 || secondaryLimit(r.Body)))', 'e.Global = r.Status == 429 || r.Status == 403')]),
    'noglobal': (G, 'TestAPermissionForbiddenFailsOnlyThatSubjectAndTheRateLimitStopsAll', [(PL, 'e.Global = r.Status == 429 || (r.Status == 403 && (r.Remaining == 0 || r.RetryAfter > 0 || secondaryLimit(r.Body)))', 'e.Global = false')]),
    'nosubjectbackoff': (G, 'TestAPermissionForbiddenFailsOnlyThatSubjectAndTheRateLimitStopsAll', [(PO, 'p.subjectUntil[subject] = p.o.Now().Add(p.o.SubjectBackoff)', '_ = subject')]),
    # A failed poll stores nothing; a rate limit backs off.
    'lowlimit': (G, 'TestLowRateLimitBacksOffThenResumes', [(PO, 'if remaining >= 0 && remaining < 200 {', 'if false {')]),
    'backoffignored': (G, 'TestLowRateLimitBacksOffThenResumes', [(PO, 'if p.o.Now().Before(p.BackoffUntil()) {', 'if false {')]),
    # ETags with the secret in them are dropped.
    'etagtoken': (G, 'TestAnETagWithTheTokenInItIsDropped', [(CL, 'if token != "" && strings.Contains(r.ETag, token) {', 'if false {')]),
    # A stored ETag is sent only after a poll with this process's token; a secondary limit backs everyone off.
    'etagstart': (G, 'TestStoredETagsAreNotSentWithAnotherToken', [(PO, '\treturn p.fresh[subject]', '\treturn true')]),
    'etagswap': (G, 'TestStoredETagsAreNotSentWithAnotherToken', [(PO, '\tif id != p.tokenID {\n\t\tp.tokenID = id\n\t\tp.fresh = map[string]bool{}\n\t}', '\tp.tokenID = id')]),
    'etagfreshset': (G, 'TestStoredETagsAreNotSentWithAnotherToken', [(PO, '\tp.fresh[subject] = true\n', '')]),
    'secondary': (G, 'TestASecondaryRateLimitBacksTheWholePollerOff', [(PL, ' || secondaryLimit(r.Body)))', '))')]),
    # The secret.
    'tokenleak': (G, 'TestTheTokenGoesOnlyInTheHeader', [(CL, 'if err == nil || token == "" {', 'if true {'), (PO, '\tif token == "" {\n\t\treturn msg\n\t}', '\tif true {\n\t\treturn msg\n\t}')]),
    # ETags and the first poll.
    'noetag': (G, 'TestFirstPollIsSilentAndAnUnchangedPollTakesTheNotModifiedPath', [(CL, 'if etag != "" {', 'if false {')]),
    'firstloud': (G, 'TestFirstPollIsSilentAndAnUnchangedPollTakesTheNotModifiedPath|TestTickSurvivesARestart', [(PL, '\tfirst := prev == nil\n\tvar state Snapshot\n\tif prev != nil {', '\tfirst := false\n\tvar state Snapshot\n\tif prev != nil {')]),
    'statusunknown': (G, 'TestANewHeadWhoseStatusFetchFailsKeepsNothingOfTheOldHeadAndIsNoPass', [(PL, 'if !known && c == "success" {', 'if false {')]),
    'mirrorfirst': (G, 'TestMirrorsHead', [(PO, 'if prev == nil && r.State.Type == "pr"', 'if false && prev == nil && r.State.Type == "pr"')]),
    # watch_pr: the ending types always join, and only watches that end on that one PR are replaced.
    'endtypes': (MC, 'TestWatchPrMatchesTS', [(WP, 'for _, t := range prEndTypes {\n\t\tif !seen[t]', 'for _, t := range prEndTypes[:0] {\n\t\tif !seen[t]')]),
    'dropplain': (MC, 'TestWatchPrMatchesTS', [(WP, 'if ends.Kind != jsfmt.Array || len(ends.Items) == 0 || subjects.Kind', 'if _, _ = ends, 0; subjects.Kind')]),
    'dropmulti': (MC, 'TestWatchPrMatchesTS', [(WP, 'len(subjects.Items) != 1 || jsString(subjects.Items[0]) != key', 'jsString(subjects.Items[0]) != key')]),
    'dropother': (MC, 'TestWatchPrMatchesTS', [(WP, 'jsString(subjects.Items[0]) != key {', 'false {')]),
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
