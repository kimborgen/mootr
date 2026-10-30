package ghpoll

import (
	"os/exec"

	"stam/internal/jsjson"
)

func jsjsonStringify(v any) string { return jsjson.Stringify(v, "") }

func execNode(script, dir string) ([]byte, error) {
	return exec.Command("node", script, dir).CombinedOutput()
}
