#!/usr/bin/env python3
"""Mutations of the Go daemon's event subscriptions (S-4317): each one breaks one rule of delivery, ingest, forget or the
event wait, and the test named with it must fail on a test, not on the build or a timeout.

    python3 go/mutants/s4317-events.py [--equivalent] [NAME...]

MUTANT_COUNT=20 runs each mutant's test 20 times (the split mutants, which need every schedule to fail).

Each mutant is applied to the working tree, its test run, and the file restored with git restore: commit first.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
GO = os.path.join(ROOT, 'go')
SV, EX, DC = 'internal/events/service.go', 'internal/db/extevents.go', 'internal/events/declare.go'
LC, SD = 'internal/lifecycle/lifecycle.go', 'internal/db/send.go'
E = './internal/events/'
D = './internal/db/'

# name: (package, test, [(file, old, new)])
M = {
    # Delivery: the agent is read again right before the send, and the generation compared.
    'recheckgen': (E, 'TestDeliveryDrops', [(SV, 'if s.forgotCount(a.ID) != g {', 'if false && s.forgotCount(a.ID) != g {')]),
    'gentodrop': (E, 'TestDeliveryDropsOnAMovedGeneration', [(SV, 'return later, 0, false', 'return dropped, 0, false')]),
    # The delivery's transaction reads the agent itself, so an archive after the last recheck sends nothing.
    'txlive': (E, 'TestArchiveAfterTheFinalRecheckSendsNothing', [(EX, "lifecycle != 'archived'\", &sqlitex.ExecOptions{Args: []any{id}", "1 = 1\", &sqlitex.ExecOptions{Args: []any{id}")]),
    'txworking': (E, 'TestNoticeTransactionRefusesAnAgentThatWentIdle', [(EX, "lifecycle = 'active' AND activity = 'working'", "lifecycle = 'active'")]),
    'noticerow': (E, 'TestWorkingAgentsNoticeIsStoredWithItsAckAndSurvivesARestart', [(EX, "\t\tvar err error\n\t\tif row, err = insertAnswerNotice(conn, agentID, text); err != nil {\n\t\t\treturn err\n\t\t}\n\t\tleft, err = AckQueueConn", "\t\tvar err error\n\t\tleft, err = AckQueueConn")]),
    'noticeack': (E, 'TestWorkingAgentsNoticeIsStoredWithItsAckAndSurvivesARestart', [(EX, "\t\tleft, err = AckQueueConn(conn, subID, n)\n\t\treturn err\n\t})\n\treturn row, left, err", "\t\treturn nil\n\t})\n\treturn row, left, err")]),
    'waitrowkeep': (E, 'TestWaitNoticeIsStoredAsAnswerNoticeWithItsRowRemoved', [(EX, 'return runSQL(conn, "DELETE FROM kv WHERE key = ?", waitPrefix+waitID)', 'return nil')]),
    'waitempty': (E, 'TestWaitNoticeNeverDeliversEmptyText', [(EX, '\t\tif text != "" {\n\t\t\tif row, err = insertAnswerNotice', '\t\tif true {\n\t\t\tif row, err = insertAnswerNotice')]),
    'mailack': (E, 'TestMailAndAckCommitTogether', [(EX, '\t\tl, err := AckQueueConn(conn, subID, n)\n\t\tif err != nil {\n\t\t\treturn err\n\t\t}\n\t\t*left = l', '\t\t*left = 0')]),
    'mailagent': (E, 'TestArchiveAfterTheFinalRecheckSendsNothing', [(EX, '\t\t\tif !ok {\n\t\t\t\treturn ErrAgentGone', '\t\t\tif !ok && false {\n\t\t\t\treturn ErrAgentGone')]),
    'humanpointer': (E, 'TestHumanThreadPointerCommitsWithTheMail', [(EX, 'return runSQL(conn, "UPDATE event_subscriptions SET last_mail_id = ? WHERE id = ?", mailID, subID)', 'return nil')]),
    'intx': ('./internal/server/', 'TestDeliveryMailRollsBack', [(SD, 'if m.InTx != nil {', 'if false && m.InTx != nil {')]),
    'fallbackack': (E, 'TestDeliveryWhoseCommitDidNotRunIsAckedSeparately', [(SV, '\tif !acked {\n', '\tif false && !acked {\n')]),
    # D: a failing batch is kept and backs off.
    'dropafterattempts': (E, 'TestFailedDeliveryIsKeptAndBacksOff', [(SV, '\t\tif attempts == MaxAttempts {', '\t\tif attempts == MaxAttempts {\n\t\t\t_ = s.o.DB.DropQueue(ctx, subID)\n\t\t}\n\t\tif attempts == MaxAttempts {')]),
    'backoffgrow': (E, 'TestFailedDeliveryIsKeptAndBacksOff', [(SV, '\t\td *= 2\n', '')]),
    'backoffcap': (E, 'TestFailedDeliveryIsKeptAndBacksOff', [(SV, 'return min(d, MaxBackoff)', 'return d')]),
    # C and E: forget and archive find every queue of the agent.
    'forgethook': ('./internal/lifecycle/', 'TestForgetTellsEventsTheAgentIsGone', [(LC, '\tl.tellAgentGone(ctx, a.ID)\n', '')]),
    'forgetroute': ('./internal/server/', 'TestForgetThroughTheRouteDropsEventState', [(LC, '\tl.tellAgentGone(ctx, a.ID)\n', '')]),
    'orphanqueue': (E, 'TestArchiveRemovesTheQueueOfAnEndedSubscription', [(EX, "json_extract(value, '$.sub.kind') = 'agent'", "0")]),
    'recheckworking': (E, 'TestDeliveryRechecksWorkingBeforeSending', [(SV, 'if cur.Lifecycle == "active" && cur.Activity == "working" {', 'if a.Lifecycle == "active" && a.Activity == "working" {')]),
    'forgetbump': (E, 'TestDeliveryDrops', [(SV, '\ts.forgot[agentID]++\n', '')]),
    # Ack after the send, by queue row; a stop in the middle leaves the batch; a failed one is retried then dropped.
    'ackbefore': (E, 'TestEventDuringADeliveryStaysQueued', [(SV, 'n := len(q.Lines)\n', 'n := len(q.Lines) + 1\n')]),
    # The fold timer is armed once per burst, not per event.
    'armonce': (E, 'TestFoldBatchesBurstIntoOneNoticeForAWorkingAgent', [(SV, '\tif _, ok := s.timers[subID]; ok {\n\t\treturn\n\t}\n\ts.timers[subID] = s.o.Timers.AfterFunc(', '\ts.timers[subID] = s.o.Timers.AfterFunc(')]),
    # The human's thread and the subject of the mail.
    'humanreply': (E, 'TestHumanDeliveriesReplyIntoOneThread', [(SV, 'replyTo = *live.LastMailID', 'replyTo = ""')]),
    'subjectnote': (E, 'TestIdleAgentGetsMailWithTheNotesSubject', [(SV, 'what = *sub.Note', 'what = "external"')]),
    # Ingest: an ending event deletes its subscription and keeps its delivery; an expired one goes; the event is stored once.
    'endskeep': (E, 'TestEndingEventDeletesTheSubscriptionAndKeepsItsDelivery', [(EX, 'if dec.Ends {', 'if false {')]),
    'endsdelivery': (E, 'TestEndingEventDeletesTheSubscriptionAndKeepsItsDelivery', [(EX, 'if err := appendQueue(conn, sub, dec.Line); err != nil {', 'if false {')]),
    'expiry': (E, 'TestExpiredSubscriptionIsDeletedAndNeverDelivers', [(EX, '"DELETE FROM event_subscriptions WHERE expires_at IS NOT NULL AND expires_at <= ?"', '"DELETE FROM event_subscriptions WHERE 0 AND expires_at <= ?"')]),
    'storeonce': (E, 'TestIngestStoresOnceAndValidates', [(EX, 'if conn.Changes() == 0 {', 'if false {')]),
    'processqueues': (E, 'TestProcessSubscriptionsCountAsMatchedAndQueueNothing', [(EX, 'if sub.SubscriberKind == "process" {', 'if false {')]),
    # Forget and remove: the folded delivery and the timer go with the subscription.
    'forgetdrops': (E, 'TestForgetAgentDropsSubscriptionsBatchesAndWaitNotices', [(EX, '''		for _, s := range subs {
			if _, err := dropSub(conn, s.ID); err != nil {''', '''		for _, s := range subs[:0] {
			if _, err := dropSub(conn, s.ID); err != nil {''')]),
    'forgetnotices': (E, 'TestForgetAgentDropsSubscriptionsBatchesAndWaitNotices', [(EX, 'for _, k := range keys {', 'for _, k := range keys[:0] {')]),
    'forgettimer': (E, 'TestForgetAgentDropsSubscriptionsBatchesAndWaitNotices', [(SV, '''	for _, id := range dropped {
		if stop, ok := s.timers[id]; ok {''', '''	for _, id := range dropped[:0] {
		if stop, ok := s.timers[id]; ok {''')]),
    'removequeue': (E, 'TestRemoveSubscriptionDropsItsBatchAndTimer', [(EX, 'return removed, runSQL(conn, "DELETE FROM kv WHERE key = ?", queueKey(id))', 'return removed, nil')]),
    'removetimer': (E, 'TestRemoveSubscriptionDropsItsBatchAndTimer', [(SV, '''	removed, err := s.o.DB.RemoveSubscription(ctx, id)
	s.mu.Lock()
	if stop, ok := s.timers[id]; ok {''', '''	removed, err := s.o.DB.RemoveSubscription(ctx, id)
	s.mu.Lock()
	if stop, ok := s.timers[id+"x"]; ok {''')]),
    # The event wait: cleared by the first matching event in the ingest transaction, its notice kept until queued.
    'waitnotice': (E, 'TestEventWaitClearedStaysClearedAcrossARestart', [(EX, 'if err := kvPut(conn, waitPrefix+w.ID, string(b)); err != nil {', 'if _, _ = b, waitPrefix; false {')]),
    'waitclear': (E, 'TestEventWaitClearsOnTheFirstMatchOnlyAndNotOnADuplicate', [(EX, 'if _, err := d.clearWait(conn, w.ID); err != nil {', 'if false {')]),
    'waitdedupe': (E, 'TestDeclareWaitDedupesRefreshesAndRefusesNoSelector', [(DC, '\tf.Since = ""\n', '')]),
    'waitarchived': (E, 'TestWaitNoticeForAnArchivedAgentIsDroppedNotSent', [('internal/db/answer_notices.go', "lifecycle != 'archived')", "1 = 1)")]),
    # Link subscriptions: only stam's own are dropped.
    'linkstam': ('./internal/server/', 'TestLinkSubscriptionsFollowTheItsa', [(EX, 'if sub.CreatedBy == StamSubscriber {', 'if true {')]),
    # Round 2: the subscription check is made in the insert's own transaction, and it covers the target and the actor.
    'subnomanage': ('./internal/server/', 'TestSubscri', [(EX, '\t\tif err != nil || !ok {\n\t\t\treturn err\n\t\t}\n\t\tif TestHookSubCheck', '\t\tif err != nil || false && !ok {\n\t\t\treturn err\n\t\t}\n\t\tif TestHookSubCheck')]),
    'subarchivedtarget': ('./internal/server/', 'TestSubscri', [(EX, 'return found && a.Lifecycle != "archived", err', 'return found && (a.Lifecycle != "archived" || true), err')]),
    'subarchivedactor': ('./internal/server/', 'TestSubscri|TestInsertSubscriptionBy', [(EX, '!found || actor.Lifecycle == "archived" {', '!found || actor.Lifecycle == "archived" && false {')]),
    'subitsatarget': ('./internal/server/', 'TestSubscri|TestInsertSubscriptionBy', [(EX, 'return len(rows) > 0, err', 'return len(rows) > 0 || true, err')]),
    'removenoauth': ('./internal/server/', 'TestListAndRemove', [(EX, '\t\t\tif err != nil || !ok {\n\t\t\t\treturn err\n\t\t\t}\n\t\t}\n\t\tallowed = true', '\t\t\tif err != nil || false && !ok {\n\t\t\t\treturn err\n\t\t\t}\n\t\t}\n\t\tallowed = true')]),
    # Round 3: the check and the write are one transaction (split in two, a queued write gets in between), and an archived
    # actor can't remove.
    'subsplit': ('./internal/server/', 'TestSubscriptionCheckAndInsertAreOneTransaction', [
        (EX, '\t\tverdict = SubStored\n\t\treturn insertSub(conn, s)\n\t})\n', '\t\tverdict = SubStored\n\t\treturn nil\n\t})\n\tif err == nil && verdict == SubStored {\n\t\terr = d.Write(ctx, func(conn *sqlite.Conn) error { return insertSub(conn, s) })\n\t}\n')]),
    'removesplit': ('./internal/server/', 'TestSubscriptionRemovalCheckAndDeleteAreOneTransaction', [
        (EX, '\t\tallowed = true\n\t\tremoved, err = dropSub(conn, id)\n\t\treturn err\n\t})\n', '\t\tallowed = true\n\t\treturn nil\n\t})\n\tif err == nil && allowed {\n\t\terr = d.Write(ctx, func(conn *sqlite.Conn) (err error) { removed, err = dropSub(conn, id); return err })\n\t}\n')]),
    'removeactorlive': ('./internal/server/', 'TestArchivedActorCannotRemoveASubscription', [(EX, 'if err != nil || !found || actor.Lifecycle == "archived" {\n\t\t\t\treturn err\n\t\t\t}\n\t\t}\n\t\town :=', 'if err != nil || !found || actor.Lifecycle == "archived" && false {\n\t\t\t\treturn err\n\t\t\t}\n\t\t}\n\t\town :=')]),
}


# Equivalent mutations, not in M: each is applied and run with --equivalent, and must SURVIVE; the reason is why.
EQUIV = {
    # flushOne's check for a stop in the middle. A cancelled context already fails the database calls after it (the retry
    # count and the ack), so the batch stays queued either way; the check says so where it is read.
    'stopacks': (E, 'TestCloseCancelsAHungDeliveryAndLeavesItsBatch', [(SV, '\tif ctx.Err() != nil {\n\t\treturn\n\t}\n\tswitch out {', '\tswitch out {')]),
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
