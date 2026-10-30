#!/usr/bin/env python3
"""Mutations of the Go Linear source (S-4331): each one breaks one rule of the poller, the MCP client or the transactions
under them, and the test named with it must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4331-linear.py [--equivalent] [NAME...]

MUTANT_COUNT=20 runs each mutant's test 20 times (the interleaving mutants, which need every schedule to fail).

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
PL, CL, ST = 'internal/linearpoll/poller.go', 'internal/linearpoll/mcpclient.go', 'internal/db/watch_state_write.go'
L = './internal/linearpoll/'

INSERT = 'runSQL(conn, "INSERT INTO watch_state (subject, state, etags, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET state = excluded.state, etags = excluded.etags, updated_at = excluded.updated_at", subject, state, etags, now)'

# name: (package, test, [(file, old, new)])
M = {
    # Unsubscribe: the apply checks its watchers inside its own transaction, and the check, the events and the row are one.
    'commitcheck': (L, 'TestAnApplyQueuedBehindAnUnwatch', [(ST, 'if err != nil || !w[watched] {', 'if err != nil || false && !w[watched] {')]),
    'applysplit': (L, 'TestAnApplyAndItsCheckAreOneTransaction', [(ST, '\t\tfor _, e := range evs {\n',
                                                                    '\t\twritten = true\n\t\treturn nil\n\t})\n\tif err != nil || !written {\n\t\treturn outs, written, wrap("apply poll", err)\n\t}\n\terr = d.Write(ctx, func(conn *sqlite.Conn) error {\n\t\tfor _, e := range evs {\n')]),
    'eventsrowsplit': (L, 'TestAStopBetweenTheEventsAndTheSnapshot', [(ST, '\t\twritten = true\n\t\treturn ' + INSERT + '\n\t})\n\treturn outs, written,',
                                                                      '\t\twritten = true\n\t\treturn nil\n\t})\n\tif err == nil && written {\n\t\terr = d.Write(ctx, func(conn *sqlite.Conn) error { return ' + INSERT + ' })\n\t}\n\treturn outs, written,')]),
    'dropcheck': (L, 'TestCleanupRechecksTheWatchersInsideItsDelete', [(ST, '\t\t\tif w[s] {\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\tif err := runSQL(conn, "DELETE', '\t\t\tif false && w[s] {\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\tif err := runSQL(conn, "DELETE')]),
    'droptree': (L, 'TestAnUnwatchedSubjectIsDropped', [(ST, '(subject = ? OR substr(subject, 1, ?) = ?)', '(subject = ? AND substr(subject, 1, ?) != ?)')]),
    'retention': (L, 'TestAnUnwatchedSubjectIsDropped|TestARowIsKeptForAWeek', [(ST, " AND COALESCE((SELECT updated_at FROM watch_state WHERE subject = ?), '') < ?\", s, len(s)+1, s+\"/\", s, olderThan)", '", s, len(s)+1, s+"/")')]),
    'retentionnow': (L, 'TestARowIsKeptForAWeek', [(PL, 'p.o.Now().Add(-stateRetention)', 'p.o.Now()')]),
    'dropunwatched': (L, 'TestTeamLastSubscriptionGoneAWeek', [(PL, '\t\tp.dropUnwatched(ctx)\n', '')]),
    'issuewritten': (L, 'TestIssueUnwatchedDuringAPollPostsAndStoresNothing', [(PL, '\t_, written, err := p.o.Store.Apply(ctx, subject, subject, inputs(evs), state)\n\tif err != nil || !written {', '\t_, written, err := p.o.Store.Apply(ctx, subject, subject, inputs(evs), state)\n\t_ = written\n\tif err != nil {')]),
    'teamwritten': (L, 'TestTeamUnwatchedDuringAPoll', [(PL, '\t\t\tif err != nil || !written {\n\t\t\t\treturn err\n\t\t\t}\n\t\t\tingested += len(evs)', '\t\t\t_ = written\n\t\t\tif err != nil {\n\t\t\t\treturn err\n\t\t\t}\n\t\t\tingested += len(evs)')]),
    # Polling: ticks do not overlap, Close waits, an error never moves the cursor, a rate limit pauses.
    'overlap': (L, 'TestATickNeverOverlapsThePreviousOne', [(PL, 'if !p.running.CompareAndSwap(false, true) {', 'if false && !p.running.CompareAndSwap(false, true) {')]),
    'closewait': (L, 'TestCloseWaitsForTheTickInFlight|TestCloseBeforeTheDatabase', [(PL, '\tp.wg.Wait()\n}', '}')]),
    'failedlistcursor': (L, 'TestTeamAListThatIgnoresAfter|TestTeamAListThatNeverRunsOut', [(PL, '\tissues, err := p.listTeamIssues(ctx, key, tr.Cursor)\n\tif err != nil {\n\t\treturn 0, err\n\t}',
                                                                                                  '\tissues, err := p.listTeamIssues(ctx, key, tr.Cursor)\n\tif err != nil {\n\t\t_, _, _ = p.o.Store.Apply(ctx, subject, subject, nil, marshal(teamRow{Cursor: iso(p.o.Now()), Baseline: tr.Baseline}))\n\t\treturn 0, err\n\t}')]),
    'backoff': (L, 'TestTeamARateLimitPausesThePollAndKeepsTheCursor', [(PL, 'func (p *Poller) setBackoff() {\n', 'func (p *Poller) setBackoff() {\n\tif true {\n\t\treturn\n\t}\n')]),
    'backoffstops': (L, 'TestTeamARateLimitPausesThePollAndKeepsTheCursor', [(PL, '\tif p.o.Now().Before(p.BackoffUntil()) {', '\tif false && p.o.Now().Before(p.BackoffUntil()) {')]),
    'cursoronerror': (L, 'TestTeamAFailedCommentCall', [(PL, '\tif _, _, err := p.o.Store.Apply(ctx, subject, subject, nil, marshal(teamRow{Cursor: next, Baseline: baseline})); err != nil && loopErr == nil {', '\tif loopErr != nil {\n\t\treturn ingested, loopErr\n\t}\n\tif _, _, err := p.o.Store.Apply(ctx, subject, subject, nil, marshal(teamRow{Cursor: next, Baseline: baseline})); err != nil && loopErr == nil {')]),
    'quietcursor': (L, 'TestAQuietTeamKeepsItsCursor', [(PL, '\tif _, _, err := p.o.Store.Apply(ctx, subject, subject, nil, marshal(teamRow{Cursor: next, Baseline: baseline})); err != nil && loopErr == nil {', '\tif next == tr.Cursor {\n\t\treturn ingested, loopErr\n\t}\n\tif _, _, err := p.o.Store.Apply(ctx, subject, subject, nil, marshal(teamRow{Cursor: next, Baseline: baseline})); err != nil && loopErr == nil {')]),
    'issueid429': (L, 'TestAFailingIssueWhoseIdHas429|TestRateLimitedMatches', [(PL, r'\bHTTP 429\b|rate.?limit', r'\b429\b|rate.?limit')]),
    'commentcap': (L, 'TestTeamAtMostTenCommentCallsATick', [(PL, '\t\t\tif calls >= teamCommentsPerTick {', '\t\t\tif false && calls >= teamCommentsPerTick {')]),
    'teamsort': (L, 'TestTeamEveryPageIsRead', [(PL, '\tsort.SliceStable(kept,', '\t_ = sort.SliceStable\n\tif false {\n\tsort.SliceStable(kept,'), (PL, 'return strVal(kept[a].UpdatedAt) < strVal(kept[b].UpdatedAt) })', 'return strVal(kept[a].UpdatedAt) < strVal(kept[b].UpdatedAt) })\n\t}')]),
    'sametimeskip': (L, 'TestTeamManyIssuesAtOneUpdatedAt', [(PL, 'if prev != nil && upd != "" && prev.UpdatedAt != nil && *prev.UpdatedAt == upd {', 'if false {')]),
    'pagemoves': (L, 'TestTeamAListThatIgnoresAfter', [(PL, 'if end == "" || end == after {', 'if end == "" {')]),
    # Secret and the client's transport rules.
    'scrub': (L, 'TestClientErrorsAndToolFailuresNameNoSecret|TestNoSecret', [(CL, '\tif token == "" {\n\t\treturn msg\n\t}', '\tif true {\n\t\treturn msg\n\t}')]),
    'toolerrsecret': (L, 'TestClientErrorsAndToolFailuresNameNoSecret', [(CL, '\t\treturn nil, fail("%s %s: %s", name, tool, t)', '\t\treturn nil, fmt.Errorf("%s %s: %s", name, tool, t)')]),
    'redirect': (L, 'TestClientFollowsNoRedirect', [(CL, '\tc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }\n', '')]),
    'refresh': (L, 'TestClientRetriesA401OnToolsCall', [(CL, 'cred, err := c.auth.TokenFor(ctx, name, attempt > 0)', 'cred, err := c.auth.TokenFor(ctx, name, false)')]),
    'timeout': (L, 'TestClientTimesOutARequest', [(CL, '\tif c.Timeout == 0 {\n\t\tc.Timeout = requestTimeout\n\t}\n', '')]),
    'sessionreset': (L, 'TestClientStartsAgainOnAnExpiredSession', [(CL, '\t\t\tdelete(c.sessions, name)\n', '')]),
    # Subjects and types are TS's.
    'dedupekey': (L, 'TestDiffOfATeamNamesTheTeamAndTheIssue', [('internal/linearpoll/issue.go', 'return typ + ":" + team + ":" + subject + ":" + tail', 'return typ + ":" + subject + ":" + tail')]),
}

# Equivalent mutations, not in M: each is applied and run with --equivalent, and must SURVIVE; the reason is why.
EQUIV = {
    # The state view's field order is the JSON struct's; the tests read the fields by name.
    'viewfieldorder': (L, 'TestStateForShowsTheIssueAndAnUnpolledSubject', [('internal/linearpoll/poller.go', '\tAssignee  *string `json:"assignee"`\n\tPriority  *string `json:"priority"`', '\tPriority  *string `json:"priority"`\n\tAssignee  *string `json:"assignee"`')]),
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
        runs = sum(1 for l in out.splitlines() if l.startswith('--- FAIL: ' + test.split('|')[0]) and '/' not in l.split(' (')[0])
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
