package mcp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// tools/list and tools/call read the tool table at the same time (every request is handled on a goroutine of its own): the
// first of them orders it, and none changes it afterwards. Run with -race.
func TestToolTableIsSafeToShare(t *testing.T) {
	orderOnce, ordered = sync.Once{}, nil
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"enabled":true}`) }))
	defer daemon.Close()
	vars := map[string]string{"STAM_URL": daemon.URL, "STAM_TOKEN": "t", "STAM_HOME": t.TempDir()}
	srv := New(Options{In: strings.NewReader(""), Out: io.Discard, Err: io.Discard, Getenv: func(k string) string { return vars[k] }, Instructions: new(string)})
	before := make([]string, len(tools))
	for i, tl := range tools {
		before[i] = tl.name
	}
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			for j := 0; j < 50; j++ {
				if i%2 == 0 {
					if list := srv.toolList(context.Background()); !strings.HasPrefix(list, `[{"name":"whoami"`) {
						t.Errorf("tools/list starts %.40s", list)
					}
				} else if tl := findTool("itsa_get"); tl == nil || tl.name != "itsa_get" {
					t.Errorf("itsa_get is %v", tl)
				}
			}
		}(i)
	}
	close(start)
	wg.Wait()
	// The table the init functions filled is as they left it: the order lives in a copy.
	for i, tl := range tools {
		if tl.name != before[i] {
			t.Fatalf("tools[%d] changed from %s to %s", i, before[i], tl.name)
		}
	}
}
