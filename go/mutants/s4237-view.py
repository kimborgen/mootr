#!/usr/bin/env python3
"""Mutations of the OpenCode agent view (S-4237, PR 6): each one breaks one check of the session binding of a send, of a
follower's removal or routing, of the human-only auth, or of a permission reply's body, and the test named with it must
fail on a test, not on the build or a timeout.

    python3 go/mutants/s4237-view.py [NAME...]

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
OV, OL, SV, LC, VR, SVC, AS = ('internal/agentview/opencode.go', 'internal/lifecycle/openview.go', 'internal/agentview/service.go',
                      'internal/lifecycle/opencode.go', 'internal/server/view_routes.go', 'internal/agentview/service.go', 'internal/lifecycle/ask.go')
A, L, S = './internal/agentview/', './internal/lifecycle/', './internal/server/'
SENDS = 'TestOpenCodeSendBinding'
MODEL = 'TestOpenCodeViewSendModel'
READ = '''	cur, err := o.DB.GetAgent(ctx, a.ID)
	if err != nil {
		return "", err
	}
	if cur.SessionID == nil || *cur.SessionID == "" {'''
STOP = '''		delete(o.followers[a.ID], f)
		if len(o.followers[a.ID]) == 0 {
			delete(o.followers, a.ID)
		}'''
FOLLOWERS = '''	fs := make([]*follower, 0, len(o.followers[a.ID]))
	for f := range o.followers[a.ID] {
		fs = append(fs, f)
	}'''
EVERY = '''	fs := make([]*follower, 0)
	for _, set := range o.followers {
		for f := range set {
			fs = append(fs, f)
		}
	}
	_ = a'''

# name: (package, test, [(file, old, new)])
M = {
    # The session binding of a send (opencode.go send, openview.go ViewBinding).
    'sendrefuse': (A, SENDS, [(OV, '	if !sent && err == nil {', '	if !sent && err == nil && false {')]),
    'bindlaunch': (L, MODEL, [(OL, 'if sid == "" || launching {', 'if sid == "" || (launching && false) {')]),
    'bindheld': (L, MODEL, [(OL, '	if !o.keep(&op, gen) || !o.still(gen, sid, turn) {', '	if !o.keep(&op, gen) {')]),
    'bindgen': (L, MODEL, [(OL, '	if !o.keep(&op, gen) || !o.still(gen, sid, turn) {', '	if !o.keep(&op, gen) || turn() != sid {')]),
    # The call holds the session's slot, so a stop or a relaunch's release orders after it.
    'sendslot': (L, 'TestViewSendHoldsTheSlot', [(OL, '	if !o.waitSlot(ctx, slot, &op) {\n		return false, ctx.Err()\n	}\n	defer o.leaveSlot(slot, &op)', '	o.unregister(slot, &op)')]),
    'sendanswer': (L, 'TestViewSendHoldsTheSlot', [(OL, '	if pid != "" {\n		o.endAnswer(pid, err == nil)\n	}', '')]),
    # A reply from the view settles its ask, only when it went through; a first read's stale failure isn't the joiner's.
    'replyclose': (L, 'TestViewReplyClosesTheAsk', [(OL, '			l.closeAsk(cctx, d, id, pid)', '			_ = cctx')]),
    'replyctx': (L, 'TestViewReplyClosesTheAskAfterTheRequestEnds', [(OL, 'context.WithTimeout(context.WithoutCancel(ctx), viewCloseTimeout)', 'context.WithTimeout(ctx, viewCloseTimeout)')]),
    'closectx': (L, 'TestViewReplyCloseTimesOut', [(AS, '		l.event(ectx, id, "permission-error", "Error: "+err.Error())', '		_ = ectx\n		l.event(ctx, id, "permission-error", "Error: "+err.Error())')]),
    'replyfailed': (L, 'TestViewReplyClosesTheAsk', [(OL, '	if sent && err == nil && pid != "" {', '	if sent && pid != "" {')]),
    'firsterr': (A, 'TestOpenCodeFirstReadFailsAfterAMove', [(SVC, '		if l.moves == moves {\n			l.readyErr = err\n		}', '		l.readyErr = err')]),
    # A moved window: a read of the old session in flight is dropped, the new session's paging and messages go out whole.
    'movegen': (A, 'TestOpenCodeMovedWindow', [(SVC, '	if l.dropped || l.moves != moves {', '	if l.dropped || (l.moves != moves && false) {')]),
    'movepaging': (A, 'TestOpenCodeMovedWindow', [(SVC, '		l.emptied = false\n		l.store.HasOlder = p.Older != nil', '		l.emptied = false')]),
    'movewhole': (A, 'TestOpenCodeMovedWindow', [(SVC, '		l.store.HasOlder = p.Older != nil\n		l.store.Replaced = true', '		l.store.HasOlder = p.Older != nil')]),
    # Reads act on the row's session at the call.
    'readstale': (A, 'TestOpenCodeReadsTheCurrentSession', [(OV, READ, '	cur := a\n	var err error\n	_ = err\n	if cur.SessionID == nil || *cur.SessionID == "" {')]),
    # Followers: removed with their window, routed by the agent that has the session now, moved windows read again.
    'followstop': (A, 'TestOpenCodeFollowersCleanUp', [(OV, STOP, '		_ = f')]),
    'followempty': (A, 'TestOpenCodeFollowersCleanUp', [(OV, '		if len(o.followers[a.ID]) == 0 {\n			delete(o.followers, a.ID)\n		}', '		_ = a')]),
    'followmoved': (A, 'TestOpenCodeEventRouting', [(OV, '	moved := f.sid != sid', '	moved := false')]),
    'followresync': (A, 'TestOpenCodeEventRouting', [(OV, '	if moved || result == evResync {', '	if moved {')]),
    'followagent': (A, 'TestOpenCodeEventRouting', [(OV, FOLLOWERS, EVERY)]),
    'viewdeferred': (S, 'TestOpenCodeViewRoutes', [(LC, '	defer l.viewEvent(ev)\n', '')]),
    # The human-only auth of the sends (the Claude view's, shared) and a reply's body.
    'authowned': (S, 'TestOpenCodeViewRoutes', [(VR, '	if !c.Owned {', '	if false {')]),
    'replyrequest': (A, 'TestServiceAnswerPermission', [(SV, '	if req == "" {\n		return refuse(400, "request is missing")\n	}', '')]),
    'replydecision': (A, 'TestServiceAnswerPermission', [(SV, '	if d != "once" && d != "always" && d != "reject" {', '	if false {')]),
    'replyevent': (A, 'TestServiceAnswerPermission', [(SV, '	return s.DB.AddEvent(ctx, a.ID, "view-permission", struct {', '	return s.DB.AddEvent(ctx, a.ID, "view-permission-x", struct {')]),
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
