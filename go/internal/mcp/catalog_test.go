package mcp

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"

	"stam/internal/jsjson"
)

// Catalog is src/mcp.ts toolCatalog byte for byte, with requirements off and on (testdata/catalogref.mjs): every tool TS
// defines, served by the Go MCP server or not. When it fails after a change to src/mcp.ts, regenerate catalog_tools.go
// with testdata/gencatalog.mjs.
func TestCatalogMatchesTS(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node not installed")
	}
	out, err := exec.Command("node", "--no-warnings", "testdata/catalogref.mjs").Output()
	if err != nil {
		t.Fatalf("catalogref.mjs: %v", err)
	}
	var want []string
	if err := json.Unmarshal(out, &want); err != nil || len(want) != 2 {
		t.Fatalf("catalogref.mjs output: %v %q", err, out)
	}
	for i, req := range []bool{false, true} {
		if got := jsjson.Stringify(Catalog(req), ""); got != want[i] {
			t.Errorf("Catalog(%v) differs from toolCatalog; when src/mcp.ts changed a tool, regenerate catalog_tools.go:\n"+
				"  node go/internal/mcp/testdata/gencatalog.mjs > go/internal/mcp/catalog_tools.go && gofmt -w go/internal/mcp/catalog_tools.go\n"+
				"  go %.300s\n  ts %.300s", req, got, want[i])
		}
	}
	// Every tool the Go MCP server serves is in the catalog.
	all := jsjson.Stringify(Catalog(true), "")
	for _, tl := range orderedTools() {
		var head struct{ Name string }
		_ = json.Unmarshal([]byte(tl.listing), &head)
		if !strings.Contains(all, `"name":"`+head.Name+`"`) {
			t.Errorf("served tool %s is missing from the catalog", head.Name)
		}
	}
}
