package claude

import (
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"stam/internal/jsjson"
)

// Ties a stam permission request to the Claude Code permission dialog on an agent's screen (src/adapters/claude-dialog.ts,
// S-276), so stam types an answer only into the dialog the request is about.

// Dialog is a harness dialog a hook reports (src/adapters/types.ts HookResult.dialog): stam makes it a permission
// request. Replaces says the hook names its dialog, so it withdraws a pending request for another one. Choose, when
// set, names the dialog to show in place of this one, in the same step that reads the pending request, before anything
// else (an OpenCode ask, S-4237): nothing when its Details is empty.
type Dialog struct {
	Action   string        `json:"action"`
	Details  string        `json:"details"`
	Replaces bool          `json:"replaces"`
	Choose   func() Dialog `json:"-"`
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

// Prompt is a question dialog's one question (src/adapters/claude-dialog.ts dialogPrompt): its text, its option labels in
// order, and whether it is multi-select.
type Prompt struct {
	Question    string
	Options     []string
	MultiSelect bool
}

// DialogPrompt is src/adapters/claude-dialog.ts dialogPrompt (S-3978): a question dialog's one question and its option
// labels. Several questions or none, and an option with no label, read as no prompt (ok false). TS would throw on a null
// entry in questions; here it fails closed too.
func DialogPrompt(input *jsjson.Object) (Prompt, bool) {
	qs, _ := get(input, "questions").([]jsjson.Value)
	if len(qs) != 1 {
		return Prompt{}, false
	}
	q, _ := qs[0].(*jsjson.Object)
	text, isText := get(q, "question").(string)
	items, isItems := get(q, "options").([]jsjson.Value)
	if !isText || jsjson.Trim(text) == "" || !isItems {
		return Prompt{}, false
	}
	var options []string
	for _, o := range items {
		obj, _ := o.(*jsjson.Object)
		label, isLabel := get(obj, "label").(string)
		if !isLabel || jsjson.Trim(label) == "" {
			return Prompt{}, false
		}
		options = append(options, label)
	}
	if len(options) == 0 {
		return Prompt{}, false
	}
	return Prompt{Question: text, Options: options, MultiSelect: get(q, "multiSelect") == true}, true
}

// DialogQuestion is src/adapters/claude-dialog.ts dialogQuestion (S-3978): the prompt a choice can be typed into. A
// multi-select question (a digit only toggles an option there) or two options with the same label is not one: ok false.
func DialogQuestion(input *jsjson.Object) (question string, options []string, ok bool) {
	p, ok := DialogPrompt(input)
	if !ok || p.MultiSelect {
		return "", nil, false
	}
	seen := map[string]bool{}
	for _, label := range p.Options {
		if seen[label] {
			return "", nil, false
		}
		seen[label] = true
	}
	return p.Question, p.Options, true
}

// QuestionNames is src/adapters/claude-dialog.ts questionNames: the dialog's body shows the request's question and its
// options in order, each as "N. label" starting a line, so a choice typed as N picks that label and no other. Wrapped
// text and box borders are ignored, as in DialogNames. Anything else fails closed.
func QuestionNames(body []string, question string, options []string) bool {
	if squeeze(question) == "" {
		return false
	}
	var joined strings.Builder
	for _, l := range body {
		joined.WriteString(squeeze(l))
	}
	if !strings.Contains(joined.String(), squeeze(question)) {
		return false
	}
	for i, label := range options {
		found := false
		for _, l := range body {
			m := questionOptionRe.FindStringSubmatch(jsjson.Trim(barRe.ReplaceAllString(l, "")))
			if m != nil && m[1] == strconv.Itoa(i+1) && squeeze(m[2]) == squeeze(label) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

var (
	optionRe = regexp.MustCompile(`^(?:❯` + jsSpace + `*)?([1-9])\.` + jsSpace + `+(.*?)$`)
	yesOnce  = regexp.MustCompile(`^Yes(, but ask again next time)?$`)
	noOnce   = regexp.MustCompile(`^No, and ask again next time$`)
	barRe    = regexp.MustCompile(`[│┃]`)
	// questionOptionRe is the "N. label" line of a question's options, as TS's questionNames reads it (\d+ there).
	questionOptionRe = regexp.MustCompile(`^(?:❯` + jsSpace + `*)?([0-9]+)\.` + jsSpace + `+(.*?)$`)
)

// QuestionNames is src/adapters/claude-dialog.ts questionNames: the dialog's body shows the request's question and its
// options in order, each as "N. label" starting a line, so a choice typed as N picks that label and no other. Wrapped
// text and box borders are ignored, as in DialogNames. Anything else fails closed.
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
// A question dialog (AskUserQuestion) takes choice, one of its option labels, instead of a yes: the key is that
// option's number, and nothing is typed unless the screen shows the question with those options in order
// (QuestionNames, for a single-select question). A no there is Esc, typed only when the screen shows the question's text
// and every label, so a no never cancels another dialog (S-3978 review).
//
// Unlike TS, a no checks the dialog too (S-2848 #989 review): a dialog the Go daemon couldn't route (DialogShown's 501)
// leaves the request of the dialog it replaced pending, and a No or an Esc typed for that request would answer the
// new one. A screen that doesn't show the request's dialog is never read as another dialog's: the request stays
// pending, as in TS, which withdraws one only on a hook's word or no dialog on screen.
func DialogAnswer(screen, details string, approve bool, choice string) (key, outcome string) {
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
	if d.Tool == "AskUserQuestion" {
		// A no matches the screen to the question's text and every label, multi-select or not (dialogPrompt), so Esc only
		// lands on this dialog.
		prompt, ok := DialogPrompt(d.Input)
		if !ok || !QuestionNames(body, prompt.Question, prompt.Options) {
			return "", "unsafe"
		}
		if !approve {
			return "Escape", "typed"
		}
		question, options, ok := DialogQuestion(d.Input)
		if !ok {
			return "", "unsafe"
		}
		at := slices.Index(options, choice)
		if at < 0 || !QuestionNames(body, question, options) {
			return "", "unsafe"
		}
		return strconv.Itoa(at + 1), "typed"
	}
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
