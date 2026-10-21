package server

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/jsfmt"
)

var reReqID = regexp.MustCompile(`\br[abcdefghijkmnpqrstuvwxyz23456789]{4}\b`)

func maskedReqs(s string) string {
	ids := map[string]string{}
	s = reReqID.ReplaceAllStringFunc(s, func(id string) string {
		if _, ok := ids[id]; !ok {
			ids[id] = "Q" + strconv.Itoa(len(ids))
		}
		return ids[id]
	})
	return masked(s)
}

const reqSettings = `{"requirements":{"enabled":true},"itsa":{"ownerNotices":"off"}}`

// TestRequirementsMatchTS runs the ops of testdata/reqs-steps.json through src/requirements.ts (routed as src/daemon.ts routes
// them) on one database and through /api/requirements* on a copy of it, and compares every status and answer, and the tables
// left behind.
func TestRequirementsMatchTS(t *testing.T) { requirementsParity(t, reqSettings, "reqs-steps.json") }

// The approval rules, under each setting: who may move a draft into force, an agent only by naming the revision it read.
func TestRequirementsApprovalMatchesTS(t *testing.T) {
	for _, approval := range []string{"human", "cos", "any"} {
		t.Run(approval, func(t *testing.T) {
			requirementsParity(t, `{"requirements":{"enabled":true,"approval":"`+approval+`"},"chiefOfStaff":"boss","itsa":{"ownerNotices":"off"}}`, "reqs-approval-steps.json")
		})
	}
}

// The approval asks against src/req-approval.ts: the ITSAs they open, their comments, the stamps, under `human` and `cos`.
func TestRequirementAsksMatchTS(t *testing.T) {
	for _, approval := range []string{"human", "cos"} {
		t.Run(approval, func(t *testing.T) {
			requirementsParity(t, `{"requirements":{"enabled":true,"approval":"`+approval+`"},"chiefOfStaff":"boss","humanMail":{"models":{"claude-opus-5-5":true}},"itsa":{"ownerNotices":"off"}}`, "reqs-asks-steps.json")
		})
	}
}

// The check engine against src/req-check.ts: a pasted text checked by the requirements in scope (cache, thresholds, modes, keys,
// a failed model), and a peer's tool-call check (allow, deny, waived, the owner named, the budget), on the decide stub.
func TestRequirementsCheckMatchesTS(t *testing.T) {
	startDecideStub(t)
	requirementsParity(t, reqSettings, "reqs-check-steps.json")
}

// The branch checks against src/req-check.ts: a manual check of a branch's diff (each requirement reads the files its globs match)
// and the previews, on the decide stub, with a repository whose commits are dated so both daemons see the same head.
func TestRequirementsBranchMatchesTS(t *testing.T) {
	startDecideStub(t)
	repo, _ := branchRepo(t)
	requirementsParity(t, `{"requirements":{"enabled":true},"itsa":{"ownerNotices":"off","repos":{"r":"`+repo+`"}}}`, "reqs-branch-steps.json")
}

func requirementsParity(t *testing.T, settings, opsFile string) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("no node to run src/requirements.ts")
	}
	t.Setenv("STAM_EMBEDDER", "stub")
	home := filepath.Join(t.TempDir(), "home")
	must(t, os.Mkdir(home, 0o700))
	if out, err := exec.Command("node", "--no-warnings", "testdata/reqsref.mjs", home, settings, "./"+opsFile).CombinedOutput(); err != nil {
		t.Fatalf("reqsref.mjs: %v\n%s", err, out)
	}
	raw, err := os.ReadFile(filepath.Join(home, "expect.json"))
	must(t, err)
	want, err := jsfmt.Parse(raw)
	must(t, err)
	f := newFixtureFrom(t, nil, filepath.Join(home, "stam.pre.db"))
	writeFile(t, filepath.Join(f.home, "settings.json"), settings)

	opsRaw, err := os.ReadFile("testdata/" + opsFile)
	must(t, err)
	var ops []struct {
		Op      string
		Ref     string
		Input   json.RawMessage
		By      string
		Query   map[string]string
		Link    int
		Verdict int
		SQL     string
	}
	must(t, json.Unmarshal(opsRaw, &ops))
	var ids []string
	reHash := regexp.MustCompile(`"#(\d+)"`)
	reQuoted := regexp.MustCompile(`'#(\d+)'`)
	wantResults, _ := want.Get("results")
	for i, op := range ops {
		time.Sleep(3 * time.Millisecond)
		ref := op.Ref
		if strings.HasPrefix(ref, "#") {
			n, _ := strconv.Atoi(ref[1:])
			ref = ids[n]
		}
		input := reHash.ReplaceAllStringFunc(string(op.Input), func(m string) string {
			n, _ := strconv.Atoi(m[2 : len(m)-1])
			if n < len(ids) && ids[n] != "" {
				return `"` + ids[n] + `"`
			}
			return m
		})
		if input == "" {
			input = "{}"
		}
		// An agent with its own token acts as itself; the human and the shared token carry the rest.
		send := func(method, path, body string) *httptest.ResponseRecorder {
			if op.By == "child" {
				return f.sendH(method, path, agentTok, nil, body)
			}
			if op.By != "" && method != "GET" && method != "DELETE" && op.Op != "waive" {
				b, _ := jsfmt.Parse([]byte(body))
				b.Set("by", jsfmt.StringValue(op.By))
				body = jsfmt.Compact(b)
			}
			return f.post2(method, path, body)
		}
		var rec *httptest.ResponseRecorder
		switch op.Op {
		case "sql":
			q := reQuoted.ReplaceAllStringFunc(op.SQL, func(m string) string {
				n, _ := strconv.Atoi(m[2 : len(m)-1])
				return "'" + ids[n] + "'"
			})
			f.sql(q)
			ids = append(ids, "")
			continue
		case "list":
			v := url.Values{}
			for k, x := range op.Query {
				v.Set(k, x)
			}
			rec = send("GET", "/api/requirements?"+v.Encode(), "")
		case "create":
			rec = send("POST", "/api/requirements", input)
		case "batch":
			rec = send("POST", "/api/requirements/batch", input)
		case "get":
			path := "/api/requirements/" + ref
			if op.Verdict != 0 {
				path += "?verdict=" + strconv.Itoa(op.Verdict)
			}
			rec = send("GET", path, "")
		case "set":
			rec = send("PATCH", "/api/requirements/"+ref, input)
		case "link":
			rec = send("POST", "/api/requirements/"+ref+"/links", input)
		case "unlink":
			rec = send("DELETE", "/api/requirements/"+ref+"/links/"+strconv.Itoa(op.Link), "")
		case "waive":
			body := input
			if op.By != "" && op.By != "child" {
				b, _ := jsfmt.Parse([]byte(body))
				b.Set("by", jsfmt.StringValue(op.By))
				body = jsfmt.Compact(b)
			}
			rec = send("POST", "/api/requirements/waivers", body)
		case "preview":
			rec = send("POST", "/api/requirements/"+ref+"/preview", input)
		case "check":
			rec = send("POST", "/api/requirements/check", input)
		case "tool":
			rec = f.do(call{method: "POST", path: "/api/requirements/check-tool", token: peerTok, header: map[string]string{"X-Stam-Local": "1"}, body: input})
		default:
			t.Fatalf("op %d: bad op %s", i, op.Op)
		}
		exp := wantResults.Items[i]
		if wc := int(mustInt(t, exp, "status")); rec.Code != wc {
			t.Errorf("op %d (%s %s %s): status %d, TS %d\n go: %s\n ts: %s", i, op.Op, op.Ref, input, rec.Code, wc, rec.Body.String(), jsfmt.Compact(exp))
			ids = append(ids, "")
			continue
		}
		got, perr := jsfmt.Parse(rec.Body.Bytes())
		must(t, perr)
		var wantBody jsfmt.Value
		if e, ok := exp.Get("error"); ok {
			wantBody = jsfmt.Value{Kind: jsfmt.Object}
			wantBody.Set("error", e)
		} else {
			wantBody, _ = exp.Get("result")
		}
		if testing.Verbose() && (op.Op == "check" || op.Op == "tool") {
			t.Logf("op %d (%s %s): %d %s", i, op.Op, input, rec.Code, jsfmt.Compact(got))
		}
		if g, w := maskedReqs(jsfmt.Compact(got)), maskedReqs(jsfmt.Compact(wantBody)); g != w {
			t.Errorf("op %d (%s %s %s):\n go: %s\n ts: %s", i, op.Op, op.Ref, input, g, w)
		}
		id := ""
		if rec.Code == 200 && op.Op == "create" {
			id = got.Text("id")
		}
		ids = append(ids, id)
	}
	wantTables, _ := want.Get("tables")
	for i, name := range wantTables.Keys {
		query := "SELECT * FROM " + name + " ORDER BY 1"
		switch name {
		case "requirements":
			query = "SELECT * FROM requirements ORDER BY created_at, key"
		case "events":
			query = "SELECT agent_id, type, data FROM events WHERE type LIKE 'req:%' ORDER BY id"
		// The mail that tells the human of an ask is the daemon's delivery, which the TS replay (no daemon) does not do.
		case "itsas":
			query = "SELECT key, kind, title, summary, body, status, owner FROM itsas ORDER BY rowid"
		case "ask_mail":
			query = "SELECT m.from_id, m.body FROM mail m JOIN itsas i ON i.thread_id = m.thread_id WHERE m.body NOT LIKE '%needs you:%' AND m.body NOT LIKE 'Meant for your user%' ORDER BY m.rowid"
		case "req_approvals":
			query = "SELECT req_key, rev, via FROM req_approvals ORDER BY req_key"
		case "req_batch_asks":
			query = "SELECT req_key, rev, via FROM req_batch_asks ORDER BY req_key"
		}
		got := dumpTyped(t, f, query)
		if a, b := maskedReqs(jsfmt.Compact(wantTables.Items[i])), maskedReqs(jsfmt.Compact(got)); a != b {
			t.Errorf("table %s differs\n ts: %s\n go: %s", name, a, b)
		}
	}
}

func (f *fixture) reqCreate(body string) string {
	f.t.Helper()
	rec := f.post2("POST", "/api/requirements", body)
	if rec.Code != 200 {
		f.t.Fatalf("create %s: %d %s", body, rec.Code, rec.Body.String())
	}
	v, err := jsfmt.Parse(rec.Body.Bytes())
	must(f.t, err)
	return v.Text("key")
}

// An agent's in-force requirement under approval `any` needs no ask; a branch no repo is configured for can't be read.
func TestRequirementsAgentLiveAndUnreadableBranch(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true,"approval":"any"}}`)
	f.reqCreate(`{"title":"Seed"}`)
	if rec := f.sendH("POST", "/api/requirements", agentTok, nil, `{"title":"Agent live","status":"in_force"}`); rec.Code != 200 {
		t.Errorf("an agent's in-force requirement: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.post2("POST", "/api/requirements/check", `{"subject":"branch:stam2/x"}`); rec.Code != 400 || !strings.Contains(rec.Body.String(), "can't read the diff of x in stam2") {
		t.Errorf("a manual check of a branch: %d %s", rec.Code, rec.Body.String())
	}
}

// A waiver that tips a requirement over the false-positive limit drops it to observe, once, and its owner hears: an agent as a
// notice, the human in the thread of the requirement's ask, nobody when it has no owner.
func TestRequirementsDemotion(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true,"demoteMinFlags":2},"itsa":{"ownerNotices":"off"}}`)
	n := &notices{}
	f.srv.noticeHook = n.add
	for _, owner := range []string{"", "child", "human"} {
		body := `{"title":"R","status":"in_force","mode":"enforce"`
		if owner != "" {
			body += `,"owner":"` + owner + `"`
		}
		key := f.reqCreate(body + `}`)
		ask := ""
		if owner == "human" {
			ask = f.createItsa(`{"title":"Approve ` + key + `","kind":"requirement-approval"}`)
			f.sql("INSERT INTO itsa_links (itsa_id, n, system, external_id, url) SELECT id, 1, 'requirement', ?, '' FROM itsas WHERE key = ?", key, ask)
		}
		f.sql("INSERT INTO req_verdicts (req_id, req_version, subject, subject_hash, model, verdict, p_violates, ts) SELECT id, 1, 'tool:A', 'a' || id, 'm', 'violates', 0.9, '2026-10-21T00:00:01.000Z' FROM requirements WHERE key = ?", key)
		f.sql("INSERT INTO req_verdicts (req_id, req_version, subject, subject_hash, model, verdict, p_violates, ts) SELECT id, 1, 'tool:B', 'b' || id, 'm', 'violates', 0.9, '2026-10-21T00:00:02.000Z' FROM requirements WHERE key = ?", key)
		rows := dumpTyped(t, f, "SELECT v.id FROM req_verdicts v JOIN requirements r ON r.id = v.req_id WHERE r.key = '"+key+"' ORDER BY v.id")
		first, second := rows.Items[0].Items[0].Num, rows.Items[1].Items[0].Num
		waive := `{"kind":"false_positive","reason":"noise","verdict_id":`
		if rec := f.post2("POST", "/api/requirements/waivers", waive+first+`}`); rec.Code != 200 {
			t.Fatalf("first waiver: %d %s", rec.Code, rec.Body.String())
		}
		if rec := f.post2("POST", "/api/requirements/waivers", waive+second+`}`); rec.Code != 200 {
			t.Fatalf("second waiver: %d %s", rec.Code, rec.Body.String())
		}
		mode := jsfmt.Compact(dumpTyped(t, f, "SELECT mode, rev FROM requirements WHERE key = '"+key+"'"))
		if !strings.Contains(mode, `"mode":"observe"`) {
			t.Errorf("owner %q: %s", owner, mode)
		}
		if c := f.count("SELECT count(*) FROM events WHERE type = 'req:demoted' AND data LIKE ?", `%"requirement":"`+key+`"%`); c != 1 {
			t.Errorf("owner %q: %d req:demoted events", owner, c)
		}
		text := key + " dropped to observe: 1 of its last 2 flags were waived as false positives (50%, limit 30%). To reword it so the model flags only real violations, write a new draft with req_create and link it to this one with the role refines, or ask the human; a new text starts a new count."
		switch owner {
		case "child":
			if got := n.all(); len(got) != 1 || got[0] != "achild: "+text {
				t.Errorf("notices: %q", got)
			}
		case "human":
			if c := f.count("SELECT count(*) FROM mail m JOIN itsas i ON i.thread_id = m.thread_id WHERE i.key = ? AND m.body = ?", ask, text); c != 1 {
				t.Errorf("posts in the ask: %d", c)
			}
		}
	}
	if len(n.all()) != 1 {
		t.Errorf("notices: %q", n.all())
	}
}

// Two edits that each name the revision they read: one wins, the other is told the requirement changed. The check and the
// write are one transaction, so the loser cannot overwrite the winner.
func TestRequirementsConcurrentEdits(t *testing.T) {
	f := newFixture(t, nil)
	writeFile(t, filepath.Join(f.home, "settings.json"), `{"requirements":{"enabled":true}}`)
	for round := 0; round < 15; round++ {
		key := f.reqCreate(`{"title":"Race"}`)
		codes := make(chan int, 2)
		for _, title := range []string{"One", "Two"} {
			go func() {
				codes <- f.post2("PATCH", "/api/requirements/"+key, `{"ifRev":1,"title":"`+title+`"}`).Code
			}()
		}
		a, b := <-codes, <-codes
		if !(a == 200 && b == 400 || a == 400 && b == 200) {
			t.Fatalf("round %d: %d and %d, want one 200 and one 400", round, a, b)
		}
		if rev := jsfmt.Compact(dumpTyped(t, f, "SELECT rev FROM requirements WHERE key = '"+key+"'")); rev != `[{"rev":2}]` {
			t.Fatalf("round %d: %s", round, rev)
		}
	}
}

// Requirements off: every route but /api/req-enabled is a 404 with the settings key named, and nothing is created.
func TestRequirementsOff(t *testing.T) {
	f := newFixture(t, nil)
	if rec := f.post2("GET", "/api/req-enabled", ""); rec.Code != 200 || strings.TrimSpace(rec.Body.String()) != `{"enabled":false}` {
		t.Errorf("req-enabled: %d %s", rec.Code, rec.Body.String())
	}
	for _, c := range [][2]string{{"GET", "/api/requirements"}, {"POST", "/api/requirements"}, {"GET", "/api/requirements/R-1"}, {"POST", "/api/requirements/waivers"}} {
		if rec := f.post2(c[0], c[1], `{"title":"x"}`); rec.Code != 404 || !strings.Contains(rec.Body.String(), "requirements are off") {
			t.Errorf("%s %s: %d %s", c[0], c[1], rec.Code, rec.Body.String())
		}
	}
	if got := dumpTyped(t, f, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'requirements'"); !strings.Contains(jsfmt.Compact(got), `"n":0`) {
		t.Errorf("a table was made while off: %s", jsfmt.Compact(got))
	}
}
