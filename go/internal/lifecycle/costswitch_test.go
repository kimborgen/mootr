package lifecycle

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"
)

// The tests of costswitch.go. TestSwitchMoveMatchesTS runs each case through src/cost-switch.ts costSwitch with fake
// harnesses (testdata/switchref.mjs) and through the Go move: db.MoveToSuccessor with successorSpec's row, the
// takeover prompt and the switched notice, or, for a case whose successor fails to start, the move and db.Unmove. It
// compares the rows the move touches (agents, parents, mail copies and batches, ITSAs, participants, grants and the
// move's events), the takeover prompt, and the switched notice's mail and events. The successor's id is random, so
// it is compared as SUCC; the case folder as WORK, and every time stamp not in the fixture as NOW. The parts of the
// switch around the move (the stop, the launch, the blockers, the lifecycle) are B5e2's, so lifecycle, activity,
// session and blockers aren't compared here.

const switchSettings = `{"peers":[],"chiefOfStaff":"cos","humanMail":{"when":"important"},` +
	`"cost":{"subscriptionWarnPercent":[],"accounts":{"acct-a":{"match":{"harness":"fake"},"paid":false},"acct-b":{"match":{"harness":"fake2"},"paid":false}}},` +
	`"permissionModes":{"harness":{"fake2":"bypass"},"types":{"reviewer":"default"}}}`

const switchRegistry = `{"presets":{"cheap":{"harness":"fake2","model":"cheap-model","effort":"low"}},` +
	`"harnesses":{"fake2":{"description":"The preset's fake.","efforts":["low"],"tools":{"bash":true,"web_search":false}}}}`

// switchDump is the rows a move touches, one query per table; mail from system:cost (the switched notice) is the
// notice's, compared apart.
var switchDump = map[string]string{
	"agents": `SELECT id, name, role, machine, harness, model, effort, cwd, parent_id, workspace, personal_workspace, standing, capabilities,
		permission_mode, permission_source, visibility, child_notices, kind, type, first_prompt, forwarded_to FROM agents ORDER BY name`,
	"parents":    "SELECT child_id, parent_id FROM agent_parents",
	"recipients": "SELECT mail_id, agent_id, read_at, pushed_at, quiet FROM mail_recipients WHERE mail_id IN (SELECT id FROM mail WHERE from_id != 'system:cost')",
	"deliveries": "SELECT agent_id, mail_id, batch FROM mail_deliveries",
	"itsas":      "SELECT id, owner, updated_at, closed_at FROM itsas",
	"joined":     "SELECT itsa_id, agent_id, left_at FROM itsa_participants",
	"grants":     "SELECT workspace, grantee_id, access, granted_by, granted_at FROM workspace_grants",
	"events":     "SELECT agent_id, data FROM events WHERE type = 'cost:switch' AND json_extract(data, '$.step') IN ('moved', 'created')",
}

type switchFile struct {
	Path  string `json:"path"`
	Text  string `json:"text"`
	Mtime string `json:"mtime"`
}

type switchCase struct {
	Name      string       `json:"name"`
	Agent     string       `json:"agent"`
	By        string       `json:"by"`
	Preset    string       `json:"preset"`
	Successor string       `json:"successor"`
	Fail      string       `json:"fail,omitempty"`
	SQL       []string     `json:"sql"`
	During    []string     `json:"during,omitempty"`
	Files     []switchFile `json:"files,omitempty"`
}

type switchOut struct {
	Dump     map[string][]string `json:"dump"`
	Prompt   *string             `json:"prompt"`
	Switched []string            `json:"switched"`
	Error    *string             `json:"error"`
	Work     string              `json:"work"`
	// Succ is the Go successor's id, which no dump holds once a rollback forgot it.
	Succ string `json:"-"`
}

const t0 = "2026-01-01T00:00:00.000Z"

// switchFailures is the error each failing case's fake successor gives.
var switchFailures = map[string]string{"launch": "harness would not start", "afterLaunch": "the first prompt was not taken"}

// agentSQL is an agents row of the fixture, idle and active, with the columns given over the defaults.
func agentSQL(id, name string, cols map[string]string) string {
	base := map[string]string{"id": "'" + id + "'", "name": "'" + name + "'", "role": "'role of " + name + "'", "machine": "'test'",
		"harness": "'fake'", "cwd": "'{{work}}/" + name + "'", "lifecycle": "'active'", "activity": "'idle'", "permission_mode": "'auto'",
		"created_at": "'" + t0 + "'", "updated_at": "'" + t0 + "'"}
	for k, v := range cols {
		base[k] = v
	}
	keys := make([]string, 0, len(base))
	for k := range base {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	vals := make([]string, len(keys))
	for i, k := range keys {
		vals[i] = base[k]
	}
	return "INSERT INTO agents (" + strings.Join(keys, ", ") + ") VALUES (" + strings.Join(vals, ", ") + ")"
}

func mailSQL(id, from, thread, subject, created string, extra ...string) string {
	perm := "NULL"
	if len(extra) > 0 {
		perm = "'" + extra[0] + "'"
	}
	return "INSERT INTO mail (id, from_id, from_name, subject, body, created_at, thread_id, permission_id) VALUES ('" + id + "', '" + from + "', NULL, '" +
		subject + "', 'body of " + id + "', '" + created + "', '" + thread + "', " + perm + ")"
}

func recipSQL(mail, agent, readAt string) string {
	r := "NULL"
	if readAt != "" {
		r = "'" + readAt + "'"
	}
	return "INSERT INTO mail_recipients (mail_id, agent_id, read_at, pushed_at) VALUES ('" + mail + "', '" + agent + "', " + r + ", " + r + ")"
}

func itsaSQL(id, key, owner, closed string) string {
	c := "NULL"
	if closed != "" {
		c = "'" + closed + "'"
	}
	return "INSERT INTO itsas (id, key, kind, title, status, owner, created_by, created_at, updated_at, closed_at) VALUES ('" + id + "', '" + key +
		"', 'issue', '" + key + "', 'in_progress', '" + owner + "', 'mgr', '" + t0 + "', '" + t0 + "', " + c + ")"
}

// switchOrg is the org around the predecessor: cos above mgr and second-parent; worker (ax) under mgr and adopted by
// second-parent, with a spawned child (child-one) and an adopted one (child-two); an archived worker-t2, so worker's
// successor is worker-t3.
func switchOrg(worker map[string]string) []string {
	return []string{
		agentSQL("acos", "cos", nil),
		agentSQL("amgr", "mgr", map[string]string{"parent_id": "'acos'"}),
		agentSQL("ap2", "second-parent", map[string]string{"parent_id": "'acos'"}),
		agentSQL("ax", "worker", worker),
		"INSERT INTO agent_parents (child_id, parent_id) VALUES ('ax', 'ap2')",
		agentSQL("ac1", "child-one", map[string]string{"parent_id": "'ax'"}),
		agentSQL("ac2", "child-two", map[string]string{"parent_id": "'acos'"}),
		"INSERT INTO agent_parents (child_id, parent_id) VALUES ('ac2', 'ax')",
		agentSQL("aold", "worker-t2", map[string]string{"lifecycle": "'archived'"}),
	}
}

func switchCases() []switchCase {
	worker := map[string]string{"parent_id": "'amgr'", "session_id": "'sess-x'", "workspace": `'{"spec":{"kind":"dir","path":"{{work}}/worker"},"cwd":"{{work}}/worker"}'`,
		"personal_workspace": "'/pw/worker'", "standing": "1", "visibility": `'{"reach":"parent"}'`, "child_notices": "'turn'", "kind": "'specialist'",
		"type": "'reviewer'", "first_prompt": "'Build the frobnicator.'", "transcript_path": "'{{work}}/t.jsonl'"}
	transcript := strings.Join([]string{
		`{"type":"user","message":{"content":"hi"}}`,
		`{"type":"user","isCompactSummary":true,"message":{"content":"Old summary."}}`,
		`{"type":"user","isCompactSummary":true,"message":{"content":[{"type":"text","text":"  Summary: the frobnicator"},{"type":"image"},{"text":"is half built.  "}]}}`,
		`{"type":"assistant","message":{"content":"isCompactSummary is a word I said"}}`,
		`not json "compacted"`,
	}, "\n")
	move := append(switchOrg(worker),
		// A read thread: the successor gets a read copy of mread1, not of the mail in it between others.
		mailSQL("mread1", "amgr", "T1", "Plan", "2026-01-01T00:01:00.000Z"), recipSQL("mread1", "ax", "2026-01-01T00:02:00.000Z"),
		mailSQL("mside", "amgr", "T1", "Re: Plan", "2026-01-01T00:03:00.000Z"), recipSQL("mside", "ap2", ""),
		// Unread mail moves.
		mailSQL("munread", "amgr", "T2", "More", "2026-01-01T00:04:00.000Z"), recipSQL("munread", "ax", ""),
		// Mail a read batch still owes (S-357) moves as unread, with its batch.
		mailSQL("mowed", "amgr", "T3", "Owed", "2026-01-01T00:05:00.000Z"), recipSQL("mowed", "ax", "2026-01-01T00:06:00.000Z"),
		"INSERT INTO mail_deliveries (agent_id, mail_id, batch) VALUES ('ax', 'mowed', 'batch-lost')",
		// An archived thread gets no copy; one the archive didn't record a later mail of is open again; a pending
		// permission request keeps its thread open.
		mailSQL("march", "amgr", "T4", "Archived", "2026-01-01T00:07:00.000Z"), recipSQL("march", "ax", "2026-01-01T00:08:00.000Z"),
		"INSERT INTO thread_archive (mailbox_id, thread_id) VALUES ('ax', 'T4')",
		"INSERT INTO thread_archive_mail (mailbox_id, thread_id, mail_id) VALUES ('ax', 'T4', 'march')",
		mailSQL("mback", "amgr", "T5", "Back", "2026-01-01T00:09:00.000Z"), recipSQL("mback", "ax", "2026-01-01T00:10:00.000Z"),
		mailSQL("mback2", "amgr", "T5", "Re: Back", "2026-01-01T00:11:00.000Z"), recipSQL("mback2", "ax", "2026-01-01T00:12:00.000Z"),
		"INSERT INTO thread_archive (mailbox_id, thread_id) VALUES ('ax', 'T5')",
		"INSERT INTO thread_archive_mail (mailbox_id, thread_id, mail_id) VALUES ('ax', 'T5', 'mback')",
		"INSERT INTO permission_requests (id, agent_id, action, reason, details, status, created_at) VALUES ('p1', 'ax', 'act', 'why', '', 'pending', '"+t0+"')",
		mailSQL("mperm", "ax", "T6", "Permission request p1: act", "2026-01-01T00:13:00.000Z", "p1"), recipSQL("mperm", "ax", "2026-01-01T00:14:00.000Z"),
		"INSERT INTO thread_archive (mailbox_id, thread_id) VALUES ('ax', 'T6')",
		"INSERT INTO thread_archive_mail (mailbox_id, thread_id, mail_id) VALUES ('ax', 'T6', 'mperm')",
		// A thread worker only sent in: listed, nothing to copy.
		mailSQL("msent", "ax", "T7", "Report", "2026-01-01T00:15:00.000Z"), recipSQL("msent", "amgr", ""),
		// ITSAs: open ones move (owned) or are joined; closed ones and one it left stay.
		itsaSQL("I1", "S-1", "ax", ""), itsaSQL("I2", "S-2", "ax", "2026-01-01T00:20:00.000Z"),
		itsaSQL("I3", "S-3", "amgr", ""), itsaSQL("I4", "S-4", "amgr", ""), itsaSQL("I5", "S-5", "amgr", "2026-01-01T00:20:00.000Z"),
		"INSERT INTO itsa_participants (itsa_id, agent_id) VALUES ('I3', 'ax')",
		"INSERT INTO itsa_participants (itsa_id, agent_id, left_at) VALUES ('I4', 'ax', '"+t0+"')",
		"INSERT INTO itsa_participants (itsa_id, agent_id) VALUES ('I5', 'ax')",
		// A workspace shared with worker (S-896).
		agentSQL("asharer", "sharer", map[string]string{"parent_id": "'amgr'"}),
		"INSERT INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) VALUES ('/pw/sharer', 'ax', 'write', 'asharer', '"+t0+"')",
	)
	files := []switchFile{
		{Path: "worker/HANDOVER.md", Text: "# Goal\nfrobnicator, café\n", Mtime: "2026-01-02T03:04:05.000Z"},
		{Path: "t.jsonl", Text: transcript, Mtime: "2026-01-02T03:04:05.000Z"},
	}

	// solo-t2 (whose successor is solo-t3) left no HANDOVER.md: the brief names its worktree's branch, its open ITSAs
	// and its last message with JavaScript's whitespace collapsed. Its transcript is a Codex rollout. It chose bypass
	// itself (manual), so its successor keeps it.
	brief := []string{
		agentSQL("acos", "cos", nil),
		agentSQL("amgr", "mgr", map[string]string{"parent_id": "'acos'"}),
		agentSQL("as", "solo-t2", map[string]string{"parent_id": "'amgr'", "session_id": "'sess-s'", "permission_mode": "'bypass'", "permission_source": "'manual'",
			"workspace":    `'{"spec":{"kind":"worktree","repo":"/r"},"cwd":"{{work}}/solo-t2","worktree":{"repo":"/r","path":"{{work}}/tree","branch":"stam/solo-dev"}}'`,
			"last_message": "'Ran the tests;' || char(9) || char(10) || ' two fail' || char(160) || char(160) || 'in parser.test.  '", "transcript_path": "'{{work}}/rollout.jsonl'"}),
		itsaSQL("I6", "S-6", "as", ""), itsaSQL("I7", "S-7", "as", ""), itsaSQL("I8", "S-8", "as", "2026-01-01T00:20:00.000Z"),
	}
	rollout := `{"type":"compacted","payload":{"message":"Codex summary: ` + strings.Repeat("é", 8100) + `"}}` + "\n" + `{"type":"event_msg","payload":{}}`

	// A long HANDOVER.md is cut at 12000 UTF-16 units (é is one, two bytes).
	clip := []string{
		agentSQL("acos", "cos", nil),
		agentSQL("amgr", "mgr", map[string]string{"parent_id": "'acos'"}),
		agentSQL("ak", "long", map[string]string{"parent_id": "'amgr'", "session_id": "'sess-k'", "permission_source": "'settings'"}),
	}

	// A launch that fails after its prompt was taken, with mail sent to the successor meanwhile: the rollback gives
	// back every mail it got, merges a duplicate (unread, since the successor's copy was), returns the owed mail with
	// its batch and read state, and puts the children, parents, ITSAs and grants back.
	rollback := append(switchOrg(map[string]string{"parent_id": "'amgr'", "session_id": "'sess-x'"}),
		mailSQL("munread", "amgr", "T2", "More", "2026-01-01T00:04:00.000Z"), recipSQL("munread", "ax", ""),
		mailSQL("mread", "amgr", "T8", "Old", "2026-01-01T00:05:00.000Z"), recipSQL("mread", "ax", "2026-01-01T00:06:00.000Z"),
		mailSQL("mdup", "amgr", "T9", "Dup", "2026-01-01T00:07:00.000Z"), recipSQL("mdup", "ax", "2026-01-01T00:08:00.000Z"),
		"INSERT INTO thread_archive (mailbox_id, thread_id) VALUES ('ax', 'T9')",
		"INSERT INTO thread_archive_mail (mailbox_id, thread_id, mail_id) VALUES ('ax', 'T9', 'mdup')",
		mailSQL("mowed", "amgr", "T3", "Owed", "2026-01-01T00:09:00.000Z"), recipSQL("mowed", "ax", "2026-01-01T00:10:00.000Z"),
		"INSERT INTO mail_deliveries (agent_id, mail_id, batch) VALUES ('ax', 'mowed', 'batch-kept')",
		itsaSQL("I1", "S-1", "ax", ""), itsaSQL("I3", "S-3", "amgr", ""),
		"INSERT INTO itsa_participants (itsa_id, agent_id) VALUES ('I3', 'ax')",
		agentSQL("asharer", "sharer", map[string]string{"parent_id": "'amgr'"}),
		"INSERT INTO workspace_grants (workspace, grantee_id, access, granted_by, granted_at) VALUES ('/pw/sharer', 'ax', 'read', 'asharer', '"+t0+"')",
	)
	during := []string{
		mailSQL("mduring", "amgr", "T10", "During", "2026-01-01T00:30:00.000Z"),
		"INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('mduring', '{{succ}}')",
		"INSERT INTO mail_recipients (mail_id, agent_id) VALUES ('mdup', '{{succ}}')",
		mailSQL("mquiet", "amgr", "T11", "Quiet", "2026-01-01T00:31:00.000Z"),
		"INSERT INTO mail_recipients (mail_id, agent_id, read_at, pushed_at, quiet) VALUES ('mquiet', '{{succ}}', '2026-01-01T00:32:00.000Z', '2026-01-01T00:33:00.000Z', 1)",
	}

	// A top-level agent the human switches: no parent to tell, so the human hears it (humanMail important).
	lone := []string{agentSQL("al", "lone", map[string]string{"session_id": "'sess-l'"})}

	// cos, not a parent, asks for the switch: it hears it too, and the working parent hears it in-turn, not by mail.
	ancestor := []string{
		agentSQL("acos", "cos", nil),
		agentSQL("amgr", "mgr", map[string]string{"parent_id": "'acos'", "activity": "'working'"}),
		agentSQL("aw", "busy-parent-child", map[string]string{"parent_id": "'amgr'", "session_id": "'sess-w'"}),
	}

	return []switchCase{
		{Name: "move", Agent: "worker", By: "amgr", Preset: "cheap", Successor: "worker-t3", SQL: move, Files: files},
		{Name: "brief", Agent: "solo-t2", By: "amgr", Preset: "cheap", Successor: "solo-t3", SQL: brief,
			Files: []switchFile{{Path: "rollout.jsonl", Text: rollout, Mtime: "2026-01-02T03:04:05.000Z"}, {Path: "solo-t2/x", Text: "", Mtime: "2026-01-02T03:04:05.000Z"}}},
		{Name: "clip", Agent: "long", By: "amgr", Preset: "cheap", Successor: "long-t2", SQL: clip,
			Files: []switchFile{{Path: "long/HANDOVER.md", Text: "  " + strings.Repeat("é", 11990) + strings.Repeat("x", 30) + "\n", Mtime: "2026-01-02T03:04:05.000Z"}}},
		{Name: "rollback", Agent: "worker", By: "amgr", Preset: "cheap", Successor: "worker-t3", Fail: "afterLaunch", SQL: rollback, During: during},
		{Name: "launch-fails", Agent: "worker", By: "amgr", Preset: "cheap", Successor: "worker-t3", Fail: "launch", SQL: rollback},
		{Name: "ancestor", Agent: "busy-parent-child", By: "acos", Preset: "cheap", Successor: "busy-parent-child-t2", SQL: ancestor},
		{Name: "human", Agent: "lone", By: "human", Preset: "cheap", Successor: "lone-t2", SQL: lone},
	}
}

func TestSwitchMoveMatchesTS(t *testing.T) {
	runSwitchDiff(t)
}

// runSwitchDiff runs the named cases (all when none is named) through TS and Go and compares them.
func runSwitchDiff(t *testing.T, only ...string) {
	var cases []switchCase
	for _, c := range switchCases() {
		if len(only) == 0 || contains(only, c.Name) {
			cases = append(cases, c)
		}
	}
	in, err := json.Marshal(cases)
	if err != nil {
		t.Fatal(err)
	}
	dump, err := json.Marshal(switchDump)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd := exec.Command("node", "--no-warnings", "testdata/switchref.mjs", string(in), switchSettings, switchRegistry, string(dump))
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("switchref.mjs: %v\n%s", err, stderr.String())
	}
	var want map[string]switchOut
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("switchref.mjs output %q: %v", raw, err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			w := want[c.Name]
			if c.Fail == "" && w.Error != nil {
				t.Fatalf("TS switch failed: %s", *w.Error)
			}
			if c.Fail != "" && (w.Error == nil || !strings.Contains(*w.Error, switchFailures[c.Fail])) {
				t.Fatalf("TS switch didn't fail as the case asks: %v", orNil(w.Error))
			}
			g := runSwitchCase(t, c, w.Prompt != nil)
			exp := normalizeSwitch(w, w.Work, succOf(w.Dump["agents"], c.Successor))
			got := normalizeSwitch(g, g.Work, g.Succ)
			// The comparison has something to compare: a successful switch's successor, prompt and notice.
			if c.Fail == "" && (exp.Prompt == nil || len(exp.Switched) == 0 || !strings.Contains(strings.Join(exp.Dump["agents"], "\n"), `["SUCC","`+c.Successor+`"`)) {
				t.Fatalf("TS gave no successor, prompt or notice: %+v", exp)
			}
			for _, k := range sortedKeys(exp.Dump) {
				if a, b := strings.Join(got.Dump[k], "\n"), strings.Join(exp.Dump[k], "\n"); a != b {
					t.Errorf("%s:\nGo:\n%s\nTS:\n%s", k, a, b)
				}
			}
			if (got.Prompt == nil) != (exp.Prompt == nil) || (got.Prompt != nil && *got.Prompt != *exp.Prompt) {
				t.Errorf("prompt:\nGo:\n%v\nTS:\n%v", orNil(got.Prompt), orNil(exp.Prompt))
			}
			if a, b := strings.Join(got.Switched, "\n"), strings.Join(exp.Switched, "\n"); a != b {
				t.Errorf("switched:\nGo:\n%s\nTS:\n%s", a, b)
			}
		})
	}
}

func orNil(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return *s
}

func sortedKeys(m map[string][]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// succOf is the successor's id in an agents dump, "" when none is there.
func succOf(rows []string, name string) string {
	for _, r := range rows {
		var cols []any
		if json.Unmarshal([]byte(r), &cols) == nil && len(cols) > 1 && cols[1] == name {
			id, _ := cols[0].(string)
			return id
		}
	}
	return ""
}

var switchStamp = regexp.MustCompile(`\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z`)

// normalizeSwitch maps the successor's id to SUCC, the case folder to WORK and every stamp the fixture didn't write
// to NOW, and sorts each table's rows and the notice's lines.
func normalizeSwitch(o switchOut, work, succ string) switchOut {
	norm := func(s string) string {
		if succ != "" {
			s = strings.ReplaceAll(s, succ, "SUCC")
		}
		s = strings.ReplaceAll(s, work, "WORK")
		return switchStamp.ReplaceAllStringFunc(s, func(t string) string {
			if strings.HasPrefix(t, "2026-01-0") {
				return t
			}
			return "NOW"
		})
	}
	out := switchOut{Dump: map[string][]string{}}
	for k, rows := range o.Dump {
		n := make([]string, len(rows))
		for i, r := range rows {
			n[i] = norm(r)
		}
		sort.Strings(n)
		out.Dump[k] = n
	}
	if o.Prompt != nil {
		p := norm(*o.Prompt)
		out.Prompt = &p
	}
	for _, s := range o.Switched {
		out.Switched = append(out.Switched, norm(s))
	}
	sort.Strings(out.Switched)
	return out
}

// runSwitchCase runs a case through the Go move on a fresh home. prompt says whether TS's successor got its takeover
// prompt (a launch that fails before it never does).
func runSwitchCase(t *testing.T, c switchCase, prompt bool) switchOut {
	l, _ := newCostLive(t, switchSettings)
	if err := os.WriteFile(filepath.Join(l.home, "registry.json"), []byte(switchRegistry), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tb := range []string{"agents", "agent_parents", "mail", "mail_recipients", "mail_deliveries", "thread_archive", "thread_archive_mail", "itsas",
		"itsa_participants", "workspace_grants", "permission_requests", "events", "blockers", "waits"} {
		l.exec("DELETE FROM " + tb)
	}
	work := filepath.Join(l.base, "work", c.Name)
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(work))
	for _, f := range c.Files {
		p := filepath.Join(work, f.Path)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(f.Text), 0o600); err != nil {
			t.Fatal(err)
		}
		at, err := time.Parse(time.RFC3339, f.Mtime)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, at, at); err != nil {
			t.Fatal(err)
		}
	}
	for _, q := range c.SQL {
		l.exec(strings.ReplaceAll(q, "{{work}}", work))
	}
	pred, err := l.db.GetAgent(l.ctx, c.Agent)
	if err != nil {
		t.Fatal(err)
	}
	threads, err := l.db.OpenThreads(l.ctx, pred.ID, switchThreads)
	if err != nil {
		t.Fatal(err)
	}
	model, effort := "cheap-model", "low"
	id, err := l.db.NewAgentID(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	spec, err := l.life.successorSpec(pred, switchTo{Harness: "fake2", Model: &model, Effort: &effort}, id, "session")
	if err != nil {
		t.Fatal(err)
	}
	s, moved, err := l.db.MoveToSuccessor(l.ctx, pred, spec, threads, c.Preset)
	if err != nil {
		t.Fatal(err)
	}
	out := switchOut{Work: work, Succ: s.ID}
	if prompt {
		now := l.agent(pred.ID)
		text, _, err := l.life.takeoverPrompt(l.ctx, now, s, c.By, c.Preset, threads)
		if err != nil {
			t.Fatal(err)
		}
		out.Prompt = &text
	}
	if c.Fail != "" {
		for _, q := range c.During {
			l.exec(strings.ReplaceAll(q, "{{succ}}", s.ID))
		}
		if err := l.db.Unmove(l.ctx, pred.ID, s.ID, moved); err != nil {
			t.Fatal(err)
		}
	} else {
		l.life.switched(l.ctx, l.agent(pred.ID), l.agent(s.ID), c.Preset, c.By)
		out.Switched = l.costMails()
		for _, e := range strings.Split(l.query("SELECT agent_id, data FROM events WHERE type IN ('cost:switched', 'notice:queued') ORDER BY id"), "\n") {
			if e != "" {
				out.Switched = append(out.Switched, "event|"+e)
			}
		}
	}
	out.Dump = map[string][]string{}
	for name, q := range switchDump {
		out.Dump[name] = dumpRows(t, l, q)
	}
	return out
}

// dumpRows is each row of q as JSON.stringify(Object.values(row)) writes it.
func dumpRows(t *testing.T, l *live, q string) []string {
	t.Helper()
	var out []string
	err := l.db.Read(l.ctx, func(conn *sqlite.Conn) error {
		return sqlitex.Execute(conn, q, &sqlitex.ExecOptions{ResultFunc: func(stmt *sqlite.Stmt) error {
			row := make([]any, stmt.ColumnCount())
			for i := range row {
				switch stmt.ColumnType(i) {
				case sqlite.TypeNull:
				case sqlite.TypeInteger:
					row[i] = stmt.ColumnInt64(i)
				default:
					row[i] = stmt.ColumnText(i)
				}
			}
			var b bytes.Buffer
			enc := json.NewEncoder(&b)
			enc.SetEscapeHTML(false)
			if err := enc.Encode(row); err != nil {
				return err
			}
			out = append(out, strings.TrimSuffix(b.String(), "\n"))
			return nil
		}})
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// The parts of the switch filed as S-3687 name their gaps here: TS has them, the Go daemon doesn't yet.

// TestSwitchPeerRelayMatchesTS: POST /api/cost/switch of an agent on another machine is relayed to that machine's
// daemon (src/daemon.ts, S-923).
func TestSwitchPeerRelayMatchesTS(t *testing.T) {
	t.Skip("not in the Go daemon yet (S-3687): the peer relay of cost_switch (src/daemon.ts POST /api/cost/switch, S-923)")
}

// TestSwitchCodexOpenCodeTargetMatchesTS: a switch onto a Codex or OpenCode preset (src/cost-switch.ts switchTarget and
// launch with those adapters).
func TestSwitchCodexOpenCodeTargetMatchesTS(t *testing.T) {
	t.Skip("not in the Go daemon yet (S-3687): a switch onto a Codex or OpenCode preset; the Go daemon launches Claude Code only")
}
