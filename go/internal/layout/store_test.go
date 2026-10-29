package layout

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"stam/internal/jsjson"
)

func parse(t *testing.T, s string) jsjson.Value {
	t.Helper()
	v, err := jsjson.Parse([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func opsOf(t *testing.T, s string) []jsjson.Value {
	t.Helper()
	return parse(t, s).([]jsjson.Value)
}

// A missing file is the empty layout, and so is one that isn't a layout, or isn't JSON.
func TestOpenStartsEmpty(t *testing.T) {
	for _, text := range []string{"", "not json", `{"version":-1,"current":null,"agentWorlds":{},"worlds":{}}`} {
		home := t.TempDir()
		if text != "" {
			if err := os.WriteFile(filepath.Join(home, "layout.json"), []byte(text), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if got := jsjson.Stringify(Open(home).Get(), ""); got != `{"version":0,"current":null,"agentWorlds":{},"worlds":{}}` {
			t.Errorf("%q: started with %s", text, got)
		}
	}
}

// A store writes layout.json as JSON.stringify(layout, null, 2) with a newline, leaves no temp file, and a stale base
// or a failed batch changes neither the file nor the layout.
func TestApplyOpsWritesTheFile(t *testing.T) {
	home := t.TempDir()
	s := Open(home)
	l, err := s.ApplyOps(opsOf(t, `[{"op":"open","world":"main","key":"agent:a"}]`), nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(home, "layout.json"))
	if err != nil {
		t.Fatal(err)
	}
	if want := jsjson.Stringify(l, "  ") + "\n"; string(b) != want {
		t.Errorf("layout.json is\n%s\nwant\n%s", b, want)
	}
	base := 0.0
	if _, err := s.ApplyOps(opsOf(t, `[{"op":"focus","world":"main","pane":"p_0"}]`), &base, nil); err == nil || err.Error() != "layout is at version 1, not the base 0" {
		t.Errorf("a stale base: %v", err)
	}
	if _, err := s.ApplyOps(opsOf(t, `[{"op":"open","world":"main","key":"b"},{"op":"close","world":"main","key":"nope"}]`), nil, nil); err == nil {
		t.Error("a batch with a bad op applied")
	}
	if after, _ := os.ReadFile(filepath.Join(home, "layout.json")); string(after) != string(b) {
		t.Errorf("a refused batch changed the file:\n%s", after)
	}
	entries, _ := os.ReadDir(home)
	if len(entries) != 1 {
		t.Errorf("the home holds %d files, want layout.json alone", len(entries))
	}
}

// Only the last 512 batch ids are kept: an older one applies again.
func TestBatchesKept(t *testing.T) {
	s := Open(t.TempDir())
	op := opsOf(t, `[{"op":"tabBar","world":"main","pane":"p_0","on":true}]`)
	id := func(i int) *string { b := "b" + strconv.Itoa(i); return &b }
	for i := 0; i <= batchesKept; i++ {
		if _, err := s.ApplyOps(op, nil, id(i)); err != nil {
			t.Fatal(err)
		}
	}
	v := jsjson.ToNumber(get(s.Get(), "version"))
	if _, err := s.ApplyOps(op, nil, id(batchesKept)); err != nil || jsjson.ToNumber(get(s.Get(), "version")) != v {
		t.Errorf("the newest batch applied again (%v)", err)
	}
	if _, err := s.ApplyOps(op, nil, id(0)); err != nil || jsjson.ToNumber(get(s.Get(), "version")) != v+1 {
		t.Errorf("the oldest batch, past the cap, didn't apply again (%v)", err)
	}
	empty := ""
	if _, err := s.ApplyOps(op, nil, &empty); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ApplyOps(op, nil, &empty); err != nil || jsjson.ToNumber(get(s.Get(), "version")) != v+2 {
		t.Errorf("an empty batch id applied twice (%v)", err)
	}
}

// The stream sends the layout on connect and after a change, and a page holding it is live: its image tabs stay while
// a dead page's close.
func TestStreamAndDeadPages(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "layout.json"), []byte(`{"version":4,"current":null,"agentWorlds":{"_home":{"root":{"id":"p","tabs":["image:pg1.1","image:pg2.1","agent:a"],"active":"agent:a"},"focused":"p"}},"worlds":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	s := Open(home)
	clock := time.Now()
	s.now = func() time.Time { return clock }
	done := make(chan struct{})
	defer close(done)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.Serve(w, r, r.Header.Get("X-Stam-Page"), done)
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL, nil)
	req.Header.Set("X-Stam-Page", "pg1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type %q", ct)
	}
	rd := bufio.NewReader(resp.Body)
	next := func() string {
		t.Helper()
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(line, "data: ") {
				return strings.TrimSuffix(line[len("data: "):], "\n")
			}
		}
	}
	if first := next(); !strings.HasPrefix(first, `{"version":4,`) {
		t.Errorf("the first event is %s", first)
	}
	// Within the grace after the start every page is live; past it, pg2, which holds no stream, is dead.
	if err := s.DropDeadImageTabs(); err != nil || jsjson.ToNumber(get(s.Get(), "version")) != 4 {
		t.Fatalf("a sweep in the grace changed the layout (%v)", err)
	}
	clock = clock.Add(pageGrace)
	if err := s.DropDeadImageTabs(); err != nil {
		t.Fatal(err)
	}
	got := next()
	if !strings.Contains(got, `"tabs":["image:pg1.1","agent:a"]`) || !strings.HasPrefix(got, `{"version":5,`) {
		t.Errorf("after the sweep the stream sent %s", got)
	}
	// Once its stream closes, pg1 is live for the grace, then dead.
	cancel()
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		n := len(s.subs)
		s.mu.Unlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the closed stream is still subscribed")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := s.DropDeadImageTabs(); err != nil || strings.Contains(jsjson.Stringify(s.Get(), ""), "image:pg1.1") == false {
		t.Errorf("pg1's tab closed inside its grace (%v)", err)
	}
	clock = clock.Add(pageGrace)
	if err := s.DropDeadImageTabs(); err != nil || strings.Contains(jsjson.Stringify(s.Get(), ""), "image:pg1.1") {
		t.Errorf("pg1's tab stayed past its grace (%v)", err)
	}
}

// A stream that stops reading is dropped once more than streamCap waits for it, and a send never blocks.
func TestSlowStreamDropped(t *testing.T) {
	sub := newSubscriber()
	big := make([]byte, streamCap/2+1)
	for i := 0; i < 4; i++ {
		sub.send(big)
	}
	if _, dropped := sub.take(); !dropped {
		t.Error("a stream 2 MiB behind wasn't dropped")
	}
}
