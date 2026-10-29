package lifecycle

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"zombiezen.com/go/sqlite"
	"zombiezen.com/go/sqlite/sqlitex"

	"stam/internal/db"
	"stam/internal/jsjson"
)

// The tests of readings.go: AccountReadings and CodexView over the same rows as src/readings.ts and
// src/codex-usage-view.ts (testdata/usageref.mjs, on a copy of the Go test's database), compared as JSON text.

// readingsSettings has an account of every basis, in an order that isn't the names' sorted order: a paid Claude
// account with a weekly budget, Codex, OpenRouter with a cap, and a pay-per-token provider priced from the registry.
const readingsSettings = `{"cost":{"accounts":{` +
	`"max":{"match":{"harness":"claude"},"paid":true,"budget":{"usd":50,"per":"week"}},` +
	`"codex":{"match":{"harness":"codex"}},` +
	`"or":{"match":{"harness":"opencode","model":"openrouter/"},"budget":{"usd":5,"per":"cap"}},` +
	`"zed":{"match":{"harness":"opencode","model":"zed/"},"provider":"zed","budget":{"usd":3,"per":"month"}}}}}`

const readingsRegistry = `{"prices":{"zed/m2":{"input":2,"output":4}}}`

// readingsNow is a Wednesday, so the week starts two days before it.
var readingsNow = float64(time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC).UnixMilli())

// dbCopy is a consistent copy of the test's database, for the TS reference to read.
func dbCopy(t *testing.T, l *live) string {
	t.Helper()
	conn, err := sqlite.OpenConn(filepath.Join(l.home, "stam.db"), sqlite.OpenReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	out := filepath.Join(t.TempDir(), "copy.db")
	if err := sqlitex.ExecuteTransient(conn, "VACUUM INTO ?", &sqlitex.ExecOptions{Args: []any{out}}); err != nil {
		t.Fatal(err)
	}
	return out
}

// usageRef is testdata/usageref.mjs's output for what over the test's rows; peer, when given, is peer1's GET
// /api/usage/readings answer.
func usageRef(t *testing.T, l *live, settings, registry string, now float64, what string, peer ...string) string {
	t.Helper()
	var stderr bytes.Buffer
	args := []string{"--no-warnings", "testdata/usageref.mjs", dbCopy(t, l), settings, registry, strconv.FormatFloat(now, 'f', -1, 64), what}
	cmd := exec.Command("node", append(args, peer...)...)
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("usageref.mjs %s: %v\n%s", what, err, stderr.String())
	}
	return string(bytes.TrimSpace(raw))
}

func readingsFixture(t *testing.T) *live {
	l, _ := newCostLive(t, readingsSettings)
	if err := os.WriteFile(filepath.Join(l.home, "registry.json"), []byte(readingsRegistry), 0o600); err != nil {
		t.Fatal(err)
	}
	// An active Claude agent, so the Claude reading can go stale.
	if _, err := l.db.CreateAgent(l.ctx, db.NewAgent{ID: "rd1", Name: "rd-one", Role: "test", Machine: "test-machine", Harness: "claude", Cwd: l.work}); err != nil {
		t.Fatal(err)
	}
	at := func(minutesAgo float64) string { return isoMs(readingsNow - minutesAgo*60_000) }
	future, past := strconv.FormatFloat(readingsNow/1000+3600, 'f', -1, 64), strconv.FormatFloat(readingsNow/1000-60, 'f', -1, 64)
	for _, s := range [][3]string{
		{"claude", `{"five_hour":{"used_percentage":42,"resets_at":` + future + `},"seven_day":{"used_percentage":10.5},"note":"x"}`, at(20)},
		{"codex", `{"primary":{"used_percentage":30,"resets_at":` + past + `},"secondary":{"used_percentage":5,"resets_at":` + future + `},"credits":{"balance":12.5},"planType":"plus"}`, at(1)},
		{"openrouter", `{"credits":{"remaining":7.25,"observed_at":"` + at(2) + `"}}`, at(2)},
	} {
		l.exec("INSERT INTO subscriptions (name, data, updated_at) VALUES (?, ?, ?)", s[0], s[1], s[2])
	}
	day := func(daysAgo int) string {
		return time.UnixMilli(int64(readingsNow)).UTC().AddDate(0, 0, -daysAgo).Format("2006-01-02")
	}
	for _, u := range []struct {
		day, account, harness, model string
		cost, est, in, out           float64
	}{
		{day(0), "max", "claude", "claude-opus-5-5", 9, 1.5, 100, 10},
		{day(1), "max", "claude", "claude-opus-5-5", 3, 0.25, 0, 0},
		{day(10), "max", "claude", "claude-opus-5-5", 4, 2, 0, 0},
		{day(0), "or", "opencode", "openrouter/x", 0.4, 0, 0, 0},
		{day(40), "or", "opencode", "openrouter/x", 0.1, 0, 0, 0},
		{day(0), "zed", "opencode", "zed/m1", 0.02, 0, 1000, 0},
		{day(3), "zed", "opencode", "zed/m2", 9, 0, 1000, 500},
		{day(0), "codex", "codex", "gpt-6.1-sol", 0, 0, 500, 50},
	} {
		l.exec("INSERT INTO usage (agent_id, day, harness, model, account, cost_usd, paid_estimate_usd, tokens_in, tokens_out) VALUES ('rd1', ?, ?, ?, ?, ?, ?, ?, ?)",
			u.day, u.harness, u.model, u.account, u.cost, u.est, u.in, u.out)
	}
	return l
}

// readingsPeer is peer1's readings: a Codex primary newer than this machine's (whose reset has passed) and unreset, a
// window only the peer has, an older secondary that loses to the local one, and an `ID/window` key, which belongs to a
// codex:ID bucket and stays out of the main entry.
func readingsPeer() string {
	at := func(secondsAgo float64) string { return strconv.FormatFloat(readingsNow-secondsAgo*1000, 'f', -1, 64) }
	future := strconv.FormatFloat(readingsNow/1000+7200, 'f', -1, 64)
	return `{"codex":{"match":{"harness":"codex"},"windows":{` +
		`"primary":{"pct":55,"resets_at":` + future + `,"at":` + at(10) + `},` +
		`"tertiary":{"pct":3,"resets_at":null,"at":` + at(20) + `},` +
		`"secondary":{"pct":99,"resets_at":` + future + `,"at":` + at(600) + `},` +
		`"x1/primary":{"pct":77,"resets_at":` + future + `,"at":` + at(5) + `}}}}`
}

// withReadingsPeer has the fixture's daemon read peer1's answer once, as the TS reference does.
func withReadingsPeer(l *live) {
	peers := &fakePeers{answers: map[string]func() (int, []byte, error){}}
	peers.answer("peer1", 200, readingsPeer(), nil)
	l.life.SetPeerReadings(peers)
	l.life.refreshPeerReadings(l.ctx, readingsNow)
}

func TestAccountReadingsMatchTS(t *testing.T) {
	for _, peer := range []bool{false, true} {
		l := readingsFixture(t)
		var extra []string
		if peer {
			withReadingsPeer(l)
			extra = []string{readingsPeer()}
		}
		got, err := l.life.AccountReadings(l.ctx, readingsNow)
		if err != nil {
			t.Fatal(err)
		}
		arr := make([]jsjson.Value, len(got))
		for i, r := range got {
			arr[i] = r
		}
		g, w := jsjson.Stringify(arr, ""), usageRef(t, l, readingsSettings, readingsRegistry, readingsNow, "readings", extra...)
		if g != w {
			t.Errorf("peer %v: readings differ\n go: %s\n ts: %s", peer, g, w)
		}
		// The cases the comparison stands on: the order, a stale Claude reading, Codex's reset window, the priced spend;
		// with the peer, its newer primary and its own window, and no ID/window key.
		wants := []string{`[{"account":"max",`, `"stale":true`, `"reset_windows":{"primary":{"reset":true`, `"provider":"zed"`, `"balance":7.25`}
		if peer {
			wants = []string{`"primary":{"used_percentage":55,`, `"tertiary":{"used_percentage":3,`, `"secondary":{"used_percentage":5,`}
			if bytes.Contains([]byte(g), []byte("x1/")) {
				t.Errorf("the peer's ID/window key reached the main entry: %s", g)
			}
		}
		for _, want := range wants {
			if !bytes.Contains([]byte(g), []byte(want)) {
				t.Errorf("peer %v: readings lack %s: %s", peer, want, g)
			}
		}
	}
}

func TestCodexViewMatchesTS(t *testing.T) {
	for _, peer := range []bool{false, true} {
		l := readingsFixture(t)
		var extra []string
		if peer {
			withReadingsPeer(l)
			extra = []string{readingsPeer()}
		}
		data, at, _, err := l.db.Subscription(l.ctx, "codex")
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := jsjson.Parse([]byte(data))
		if err != nil {
			t.Fatal(err)
		}
		v := l.life.CodexView(parsed, &at, readingsNow)
		var upd, age jsjson.Value
		if v.UpdatedAt != nil {
			upd, age = *v.UpdatedAt, *v.AgeMs
		}
		g := jsjson.Stringify(jsjson.NewObject("live", v.Live, "reset", v.Reset, "updated_at", upd, "age_ms", age), "")
		if w := usageRef(t, l, readingsSettings, readingsRegistry, readingsNow, "codex", extra...); g != w {
			t.Errorf("peer %v: codex view differs\n go: %s\n ts: %s", peer, g, w)
		}
		if peer && (!bytes.Contains([]byte(g), []byte(`"primary":{"used_percentage":55,`)) || bytes.Contains([]byte(g), []byte("x1/"))) {
			t.Errorf("the peer's newer primary is missing or its ID/window key leaked: %s", g)
		}
	}
}
