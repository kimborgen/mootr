#!/usr/bin/env python3
"""Mutations of the Go daemon's OpenCode turn end (S-4237, PR 4d): each one breaks one
contract line, and the test named with it must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4237-turnend.py [NAME...]

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
CX, TE, US, SV = 'internal/lifecycle/context.go', 'internal/lifecycle/turnend.go', 'internal/lifecycle/usage.go', 'internal/adapters/opencode/server.go'
L = './internal/lifecycle/'


# name: (package, test, [(file, old, new)])
M = {
    # 1. The reads run off the event stream: an inline read holds the stream (and the next event) while the server is slow.
    'inlineread': (L, 'TestTurnEndHeldReadDelaysNothing', [(TE, '''	l.goBG(func(ctx context.Context) { l.turnEndReads(ctx, id, sid, gen) })''', '''	l.turnEndReads(l.ctx, id, sid, gen)''')]),
    # 2. A usage report and a context size are written only for the session and generation they were read for: under the
    # owner's guard (generation and session) and, in the write's own transaction, on the row.
    'usageguard': (L, 'TestTurnEndReadAfterNewOwner/(stop|launch|archive|switch)/usage', [(TE, '''	return b.o.writeIf(b.gen, b.sid, b.turn, w)''', '''	return true, w()''')]),
    'usagegen': (L, 'TestTurnEndReadAfterNewOwner/(stop|launch)/usage', [(TE, '''b.o.writeIf(b.gen, b.sid, b.turn, w)''', '''b.o.writeIf(b.o.now(), b.sid, b.turn, w)''')]),
    'usagesession': (L, 'TestTurnEndReadAfterNewOwner/(archive|switch)/usage', [(TE, '''b.o.writeIf(b.gen, b.sid, b.turn, w)''', '''b.o.writeIf(b.gen, b.sid, func() string { return b.sid }, w)'''), (TE, '''ok: func(a db.Agent) bool { return sid != "" && running(a) && l.serverTurn(a) == sid && epochOf(a) == epoch }}''', '''ok: func(a db.Agent) bool { return true }}''')]),
    'usagetxn': (L, 'TestTurnEndWriterBetweenCheckAndCommit/usage-commit', [(US, '''bound.ok, func(fresh db.Agent)''', '''func(db.Agent) bool { return true }, func(fresh db.Agent)''')]),
    'contexttxn': (L, 'TestTurnEndWriterBetweenCheckAndCommit/update-commit', [(TE, '''UpdateAgentIf(ctx, b.id, b.ok, fields...)''', '''UpdateAgentIf(ctx, b.id, func(db.Agent) bool { return true }, fields...)''')]),
    'contextguard': (L, 'TestTurnEndReadAfterNewOwner/(stop|launch|archive|switch)/message', [(TE, '''	return b.o.writeIf(b.gen, b.sid, b.turn, w)''', '''	return true, w()'''), (TE, '''UpdateAgentIf(ctx, b.id, b.ok, fields...)''', '''UpdateAgentIf(ctx, b.id, func(db.Agent) bool { return true }, fields...)''')]),
    'stillbail': (L, 'TestTurnEndReadAfterNewOwner/(stop|launch|archive|switch)/usage', [(TE, '''	if !b.still() {
		return
	}
	l.turnAt(id, "context-read")''', '''	l.turnAt(id, "context-read")''')]),
    # 2. The context's effects (level, measurement, notice) are the report's own.
    'contextnotice': (L, 'TestTurnEndContextNoticeBound', [(CX, '''	if b != nil && !b.still() {
		return
	}''', '''''')]),
    # 3. Once per end: the baseline is read again inside the write, a lower session-cumulative reading records nothing,
    # and a new session restarts cost too.
    'stalebaseline': (L, 'TestTurnEndReportsRaceOnce', [(US, '''func(fresh db.Agent) db.UsageChange { return change(fresh.UsageLast) }''', '''func(fresh db.Agent) db.UsageChange { _ = fresh; return change(a.UsageLast) }''')]),
    'lowerread': (L, 'TestTurnEndUsageAndContext', [(US, '''		if r.sessionCumulative && !idChanged && *value < prev {''', '''		if false && r.sessionCumulative && !idChanged && *value < prev {''')]),
    'newsessioncost': (L, 'TestTurnEndNewSessionRestartsCost', [(US, '''		if idChanged && (k != "cost" || r.sessionCumulative) {
			prev = 0''', '''		if idChanged && k != "cost" {
			prev = 0''')]),
    'olderreport': (L, 'TestTurnEndTwoEnds/older_read_last', [(US, '''		if r.sessionCumulative && !idChanged && *value < prev {''', '''		if false && r.sessionCumulative && !idChanged && *value < prev {''')]),
    'usagenocost': (L, 'TestTurnEndNewSessionWithoutCost', [(US, '''			if idChanged && (k != "cost" || r.sessionCumulative) {
				next.Set(k, 0.0)''', '''			if idChanged && k != "cost" {
				next.Set(k, 0.0)''')]),
    'usagetwice': (L, 'TestTurnEndNewSessionRestartsCost', [(US, '''	case grew:
		return usagePlan{kind: planRecord,''', '''	case grew || changed:
		return usagePlan{kind: planRecord,''')]),
    # 3. Usage is the session's: output with the reasoning tokens, the context from input and cache read.
    'reasoning': ('./internal/adapters/opencode/', 'TestTurnEndCalls', [('internal/adapters/opencode/turnend.go', '''num(ocGet(t, "output")) + num(ocGet(t, "reasoning"))''', '''num(ocGet(t, "output"))''')]),
    'contextcache': ('./internal/adapters/opencode/', 'TestTurnEndCalls', [('internal/adapters/opencode/turnend.go', '''return num(ocGet(t, "input")) + num(ocGet(asObject(ocGet(t, "cache")), "read")), true, nil''', '''return num(ocGet(t, "input")), true, nil''')]),
    # 2/4. An empty session never binds.
    'emptysid': (L, 'TestTurnEndEmptySession', [(TE, '''func (b *turnBind) still() bool { return b.sid != "" && b.o.still(''', '''func (b *turnBind) still() bool { return b.o.still('''), (TE, '''ok: func(a db.Agent) bool { return sid != "" && running(a)''', '''ok: func(a db.Agent) bool { return running(a)'''), (TE, '''	if b.sid == "" {
		return false, nil
	}
	return b.o.writeIf''', '''	return b.o.writeIf''')]),
    # 5. Nothing the server answered reaches an error.
    'errorbody': ('./internal/adapters/opencode/', 'TestTurnEndErrorBody', [(SV, '''		return nil, &CallError{Method: method, Path: path, Status: res.StatusCode}''', '''		return nil, fmt.Errorf("OpenCode %s %s: %d %s", method, path, res.StatusCode, text)''')]),
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
        pat = test
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
