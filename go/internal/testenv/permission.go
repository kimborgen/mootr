package testenv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

// The permission listing of a real OpenCode 2.0.26 (test/fixtures/opencode-permissions.json, S-4280), for the stubs of the
// server's GET /api/session/SID/permission: a stub that echoes the permission.asked event (its metadata, and none of the
// listing's save and source) tests a shape the server never sends.

var (
	permOnce sync.Once
	permItem map[string]any
	permErr  error
)

func permissionTemplate() map[string]any {
	permOnce.Do(func() {
		_, file, _, _ := runtime.Caller(0)
		b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "test", "fixtures", "opencode-permissions.json"))
		if err != nil {
			permErr = err
			return
		}
		var fx struct {
			Pending struct {
				Body struct {
					Data []map[string]any `json:"data"`
				} `json:"body"`
			} `json:"pending"`
		}
		if permErr = json.Unmarshal(b, &fx); permErr == nil && len(fx.Pending.Body.Data) > 0 {
			permItem = fx.Pending.Body.Data[0]
		}
	})
	if permErr != nil || permItem == nil {
		panic("testenv: the OpenCode permission fixture is unreadable")
	}
	return permItem
}

// PermissionItem is one item of a permission listing as OpenCode 2.0.26 gives it, for permission id of session sid: the
// captured item with its id and session replaced (its action is shell, its resources the captured command). With
// resources, they replace the captured ones.
func PermissionItem(sid, id string, resources ...string) string {
	item := map[string]any{}
	for k, v := range permissionTemplate() {
		item[k] = v
	}
	item["id"], item["sessionID"] = id, sid
	if len(resources) > 0 {
		item["resources"] = resources
	}
	b, _ := json.Marshal(item)
	return string(b)
}
