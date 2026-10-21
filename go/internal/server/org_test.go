package server

import (
	"context"
	"testing"
)

// TestMailHumanFromStam: the org's trouble mail for an agent with no parent reaches the human from that agent, in a
// new thread.
func TestMailHumanFromStam(t *testing.T) {
	f := newFixture(t, nil)
	must(t, f.srv.mailHumanFromStam(context.Background(), "aboss", "boss errored", "it crashed"))
	n := f.count(`SELECT count(*) FROM mail m JOIN mail_recipients r ON r.mail_id = m.id
		WHERE r.agent_id = 'human' AND m.from_id = 'aboss' AND m.subject = 'boss errored' AND m.body = 'it crashed' AND m.thread_id = m.id`)
	if n != 1 {
		t.Errorf("%d mails to the human", n)
	}
}
