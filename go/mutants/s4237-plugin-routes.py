#!/usr/bin/env python3
"""Mutations of the OpenCode plugin's routes (S-4237, PR 5): each one breaks one check of the auth, of the session binding
on a take, or of the delivery mark, and the test named with it must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4237-plugin-routes.py [NAME...]

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
PR, PL, OO = 'internal/server/plugin_routes.go', 'internal/lifecycle/pluginroutes.go', 'internal/lifecycle/owner_oc.go'
L, S = './internal/lifecycle/', './internal/server/'
MODEL = 'TestOpenCodePluginModel$'
AUTH = 'TestSessionRoutesAuth'
TAKE = 'if sid == "" || o.gen != gen || turn() != sid {'
BIND = '''	cur, gen, launching := o.bindSignal(turn)
	if sid == "" || launching || cur != sid {
		return ""
	}
	l.turnAt(id, "notes-bound")'''

# name: (package, test, [(file, old, new)])
M = {
    # Auth (plugin_routes.go): who may read a session's text, and what a refusal says.
    'authcheck': (S, AUTH, [(PR, 'if err := s.mayActAs(ctx, c.Caller, a.ID, true); err != nil {', 'if err := error(nil); err != nil {')]),
    'forbiddenleaks': (S, AUTH, [(PR, '''			return db.Agent{}, false, errSessionDenied
		}
		return db.Agent{}, false, err
	}
	return a, true, nil''', '''			return db.Agent{}, false, err
		}
		return db.Agent{}, false, err
	}
	return a, true, nil''')]),
    'unknownoracle': (S, AUTH, [(PR, '''		if restricted {
			return db.Agent{}, false, errSessionDenied
		}
		return db.Agent{}, false, nil''', '''		if restricted && false {
			return db.Agent{}, false, errSessionDenied
		}
		return db.Agent{}, false, nil''')]),
    # The take of the instructions bound to the URL's session (owner_oc.go takeNotesFor, pluginroutes.go).
    'notesgen': (L, MODEL, [(OO, TAKE, 'if sid == "" || turn() != sid {')]),
    'notessession': (L, MODEL, [(OO, TAKE, 'if sid == "" || o.gen != gen {')]),
    'notesby': (L, MODEL, [(OO, 'if by := o.notes.by; by != nil && (by.sid != sid || by.gen != o.gen) {', 'if by := o.notes.by; by != nil && false {')]),
    'notesbyheld': (L, 'TestSessionCompactInstructionsAfterRequest', [(OO, 'by.sid != sid || by.gen != o.gen', 'by.sid != sid || !o.held(by)')]),
    'notesbind': (L, 'TestSessionCompactInstructionsOnce', [(PL, BIND, '	_, gen, _ := o.bindSignal(turn)\n	l.turnAt(id, "notes-bound")'), (OO, TAKE, 'if o.gen != gen {')]),
    'noteslaunchbind': (L, MODEL, [(PL, BIND, '	cur, gen, _ := o.bindSignal(turn)\n	if sid == "" || cur != sid {\n		return ""\n	}\n	l.turnAt(id, "notes-bound")'), (OO, TAKE, 'if sid == "" || o.gen != gen || turn() != sid {')]),
    # The notice: taken for the session that runs, marked delivered only when its text is returned and the binding holds.
    'noticebind': (L, MODEL, [(PL, '''	if sid == "" || launching || cur != sid {
		return ""
	}
	l.turnAt(id, "notice-bound")''', '''	_, _ = cur, launching
	l.turnAt(id, "notice-bound")''')]),
    'noticetake': (L, MODEL, [(PL, 'text, _ := l.inTurnTakeIf(ctx, id, func() bool { return o.still(gen, sid, turn) })', 'text, _ := l.inTurnTakeIf(ctx, id, nil)')]),
    'noticemark': (L, MODEL, [(PL, 'l.turnBinding(ctx, id, sid, gen).event(ctx, "mail:notice", nil)', 'l.event(ctx, id, "mail:notice", nil)')]),
    'noticemarkempty': (L, 'TestSessionNoticeSharesTheHookQueue', [(PL, '''	if text == "" {
		return ""
	}
	l.turnAt(id, "notice-taken")''', '''	l.turnAt(id, "notice-taken")''')]),
    'noticerows': (L, 'TestSessionNoticeAnswerRow', [(PL, 'text, _ := l.inTurnTakeIf(ctx, id, func() bool { return o.still(gen, sid, turn) })', 'text, rows := l.inTurnTakeIf(ctx, id, func() bool { return o.still(gen, sid, turn) })'), (PL, '	return text\n}', '	for _, row := range rows {\n		l.AckNotice(ctx, id, row)\n	}\n	return text\n}')]),
    # The system prompt is the Claude agent's render with the agent's harness.
    'systemharness': (S, 'TestSessionRoutesServe', [(PR, 'claude.SystemPrompt(ctx, p.Templates, a.Harness, a, parts)', 'claude.SystemPrompt(ctx, p.Templates, "claude", a, parts)')]),
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
