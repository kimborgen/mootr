package claude

import (
	"os"
	"regexp"
	"strings"

	"stam/internal/jsjson"
)

// Ties a stam permission request to the Claude Code permission dialog on an agent's screen (src/adapters/claude-dialog.ts,
// S-276), so stam types an answer only into the dialog the request is about.

// Dialog is a harness dialog a hook reports (src/adapters/types.ts HookResult.dialog): stam makes it a permission
// request. Replaces says the hook names its dialog, so it withdraws a pending request for another one.
type Dialog struct {
	Action   string `json:"action"`
	Details  string `json:"details"`
	Replaces bool   `json:"replaces"`
}

// DialogInfo is a dialog request's details (DialogDetails): the tool, its input as the hook gave it, and the harness
// session that showed the dialog.
type DialogInfo struct {
	Tool    string
	HasTool bool
	Input   *jsjson.Object
	Session string
}

// DialogDetails is src/adapters/claude-dialog.ts dialogDetails: details that aren't a JSON object read as none.
func DialogDetails(details string) DialogInfo {
	v, err := jsjson.Parse([]byte(details))
	o, _ := v.(*jsjson.Object)
	if err != nil || o == nil {
		return DialogInfo{}
	}
	var d DialogInfo
	if t, ok := get(o, "tool").(string); ok {
		d.Tool, d.HasTool = t, true
	}
	d.Input, _ = get(o, "input").(*jsjson.Object)
	d.Session, _ = get(o, "session").(string)
	return d
}

// DialogTarget is src/adapters/claude-dialog.ts dialogTarget: what a permission dialog names, the file's full path, or
// the whole command, URL, or pattern; the first of them the input has (`??`), and "" when that isn't a string.
func DialogTarget(input *jsjson.Object) string {
	for _, k := range []string{"file_path", "notebook_path", "path", "command", "url", "pattern"} {
		if v := get(input, k); v != nil {
			s, _ := v.(string)
			return s
		}
	}
	return ""
}

// jsSpaceChars is jsSpace without its brackets, to join a larger class.
var jsSpaceChars = jsSpace[1 : len(jsSpace)-1]

// squeezeRe is what squeeze drops: whitespace, line breaks and box borders, since the pane wraps and frames long lines.
var squeezeRe = regexp.MustCompile(`[` + jsSpaceChars + `│┃╭╮╰╯─━]+`)

func squeeze(t string) string { return squeezeRe.ReplaceAllString(t, "") }

var wordRe = regexp.MustCompile(`^\w+$`)

// home is the folder a dialog may write as ~.
var home = func() string { h, _ := os.UserHomeDir(); return h }

// DialogNames is src/adapters/claude-dialog.ts dialogNames: the dialog's body names exactly the request's tool and
// target, the call TOOL(target) with TOOL( starting a line, the home folder written as ~ or in full. A longer path or
// command, a tool named only inside some text, a target the dialog shortened, or any other shape fails closed.
func DialogNames(body []string, tool, target string) bool {
	if !wordRe.MatchString(tool) || squeeze(target) == "" {
		return false
	}
	rows := make([]string, len(body))
	starts := map[int]bool{}
	at := 0
	for i, l := range body {
		rows[i] = squeeze(l)
		if rows[i] != "" {
			starts[at] = true
		}
		at += len(rows[i])
	}
	text := strings.Join(rows, "")
	forms := []string{target, target}
	if h := home(); h != "" && strings.HasPrefix(target, h+"/") {
		forms[1] = "~" + target[len(h):]
	}
	for _, f := range forms {
		call := tool + "(" + squeeze(f) + ")"
		for i := 0; i <= len(text); {
			j := strings.Index(text[i:], call)
			if j < 0 {
				break
			}
			if starts[i+j] {
				return true
			}
			i += j + 1
		}
	}
	return false
}

var (
	optionRe = regexp.MustCompile(`^(?:❯` + jsSpace + `*)?([1-9])\.` + jsSpace + `+(.*?)$`)
	yesOnce  = regexp.MustCompile(`^Yes(, but ask again next time)?$`)
	noOnce   = regexp.MustCompile(`^No, and ask again next time$`)
	barRe    = regexp.MustCompile(`[│┃]`)
)

// DialogKey is src/adapters/claude-dialog.ts dialogKey: the key that picks the dialog's one-time answer, found by its
// text; "" when the dialog has no such option (a yes then fails closed, and a no is Esc).
func DialogKey(body []string, approve bool) string {
	want := noOnce
	if approve {
		want = yesOnce
	}
	for _, line := range body {
		if m := optionRe.FindStringSubmatch(jsjson.Trim(barRe.ReplaceAllString(line, ""))); m != nil && want.MatchString(m[2]) {
			return m[1]
		}
	}
	return ""
}

var (
	escToCancelRe = regexp.MustCompile(`Esc to cancel`)
	topRuleRe     = regexp.MustCompile(`^` + jsSpace + `*[╭─━]{3,}`)
)

// DialogAnswer is src/adapters/claude.ts answerDialog over a captured screen of the agent's session that showed the
// dialog: the key to send, and "typed" when the dialog's body names the request's tool and target (DialogNames). Else
// nothing is typed: "gone" when no dialog is on screen; "unsafe" for a yes the dialog doesn't tie to the request or
// doesn't offer once; "unsure" for a no the dialog doesn't tie to the request. The body runs from the dialog's top rule
// to its "Esc to cancel" line.
//
// Unlike TS, a no checks the dialog too (S-2848 #989 review): a dialog the Go daemon couldn't route (DialogShown's 501)
// leaves the request of the dialog it replaced pending, and a No or an Esc typed for that request would answer the
// new one. A screen that doesn't show the request's dialog is never read as another dialog's: the request stays
// pending, as in TS, which withdraws one only on a hook's word or no dialog on screen.
func DialogAnswer(screen, details string, approve bool) (key, outcome string) {
	lines := strings.Split(screen, "\n")
	end := -1
	for i := len(lines) - 1; i >= 0; i-- {
		if escToCancelRe.MatchString(lines[i]) {
			end = i
			break
		}
	}
	if end < 0 {
		return "", "gone"
	}
	top := -1
	for i := end - 1; i >= 0; i-- {
		if topRuleRe.MatchString(lines[i]) {
			top = i
			break
		}
	}
	var body []string
	if top >= 0 {
		body = lines[top+1 : end]
	}
	d := DialogDetails(details)
	target := DialogTarget(d.Input)
	if !DialogNames(body, d.Tool, target) {
		if approve {
			return "", "unsafe"
		}
		return "", "unsure"
	}
	key = DialogKey(body, approve)
	if approve && key == "" {
		return "", "unsafe"
	}
	if key == "" {
		key = "Escape"
	}
	return key, "typed"
}
