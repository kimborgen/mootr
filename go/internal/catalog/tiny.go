// Package catalog holds the read-only lists the Settings pages pick from: the tiny-step models (src/tiny-models.ts),
// the models a model field offers (src/model-catalog.ts), what a fresh install still lacks (src/onboarding.ts) and
// the permission modes (src/permission-modes.ts).
package catalog

import (
	"strings"

	"stam/internal/config"
	"stam/internal/jsjson"
)

// The shipped prompts the tiny steps ask with when the human's own is empty: src/mail-title.ts TITLE_PROMPT and
// SUMMARY_PROMPT, src/block-summaries.ts SUMMARY_PROMPT.
const (
	MailTitlePrompt    = "You title mail. Answer with a title of one to three words that says what the mail is about, and nothing else."
	MailSummaryPrompt  = `You title and summarize mail. Answer in this form. First line: "Title: " and a title of one to three words that says what the mail is about. Then "Summary: " and a condensed version of the mail itself, not a description of it, so the reader need not open the mail. Shape the summary by the type of mail you find. Decision (someone must choose between options): the question to decide on the summary line, then one "- Option: why" line per option, at most four, the recommended one ending in " (recommended)". Blocker (work cannot go on): "Problem: " with the problem, then "Solution: " with what would clear it, including what the human must do. Done (work is finished): "Problem: " with what the problem was, then "Solution: " with what was done, then "Deferred: " for items left for later and "Note: " for anything the reader must know, each line only when it applies. Any other mail: plain condensed text over at most four short lines, keeping the outcome, the ask, key numbers, and names such as S-12, @agent or PR #12. Use no Markdown beyond the "- " option lines and the labels, and write nothing else.`
	BlockSummaryPrompt = "You summarise one block of an AI agent’s standing instructions. Answer with one or two plain sentences, at most 200 characters, saying what the block tells the agent to do. No preamble, no lists, no Markdown."
)

// ToolSummaryMaxWords and ToolNameMaxWords are src/tiny-models.ts TOOL_SUMMARY_MAX_WORDS and TOOL_NAME_MAX_WORDS.
const (
	ToolSummaryMaxWords = 12
	ToolNameMaxWords    = 3
)

// ToolSummaryInstructions is src/tiny-models.ts TOOL_SUMMARY_DEFAULT_INSTRUCTIONS.
var ToolSummaryInstructions = strings.Join([]string{
	"You summarise one tool call an AI coding agent made. You get the tool name and its input.",
	"Answer with JSON of exactly two string fields and nothing else:",
	`{"tool": "...", "doing": "..."}`,
	`"tool" is the tool in plain English, one to three words, for example "send mail", "edit file", "run command".`,
	`"doing" is what the agent is doing, one short sentence of at most 12 words, for example "instructing agent cost-budget-mgr that its tree is not working".`,
	"Name agents, files and ITSA keys as they appear. No Markdown, no preamble, no quotation marks inside the values.",
}, "\n")

// ToolNameInstructions is src/tiny-models.ts TOOL_NAME_INSTRUCTIONS.
var ToolNameInstructions = strings.Join([]string{
	"You name one tool an AI coding agent can call. You get the tool name, as a harness gave it.",
	"Answer with JSON of exactly one string field and nothing else:",
	`{"label": "..."}`,
	`"label" is the tool in plain English, one to 3 words, starting with a capital letter, for example "Send mail", "Edit file", "Run command".`,
	"No Markdown, no preamble, no server name, no quotation marks inside the value.",
}, "\n")

// ToolSummaryPrompt is src/tiny-models.ts toolSummaryConfig's instructions: the human's own, or the shipped ones when
// they are blank.
func ToolSummaryPrompt(s config.Settings) string {
	return own(s.Tiny.ToolSummary.Instructions, ToolSummaryInstructions)
}

// MailTitleInstructions is src/mail-title.ts titlePrompt: the human's own prompt, or the shipped one when it is blank;
// the title-and-summary prompt for a mail to the human.
func MailTitleInstructions(s config.Settings, summary bool) string {
	if summary {
		return own(s.Tiny.MailSummaryInstructions, MailSummaryPrompt)
	}
	return own(s.Tiny.MailTitleInstructions, MailTitlePrompt)
}

// own is the human's text unless it is blank, else the shipped one.
func own(text, shipped string) string {
	if jsjson.Trim(text) != "" {
		return text
	}
	return shipped
}

// instr is a tiny model's Instr: {text, default, editable, path, note?}.
func instr(text, def string, editable bool, path any, note string) *jsjson.Object {
	o := jsjson.NewObject("text", text, "default", def, "editable", editable, "path", path)
	if note != "" {
		o.Set("note", note)
	}
	return o
}

// extra is one of a tiny model's extra settings; the numeric options are set when given as pairs.
func extra(path, kind, label, help string, opts ...any) *jsjson.Object {
	o := jsjson.NewObject("path", path, "kind", kind, "label", label, "help", help)
	for i := 0; i+1 < len(opts); i += 2 {
		o.Set(opts[i].(string), opts[i+1])
	}
	return o
}

// TinyModels is src/tiny-models.ts tinyModels: every cheap model call stam makes for itself, a Settings › Tiny models
// page each.
func TinyModels(s config.Settings) []jsjson.Value {
	t := s.Tiny
	none := []jsjson.Value{}
	model := func(id, label, purpose string, enabled bool, toggle any, m, modelPath, kind string, usedBy any, in *jsjson.Object) *jsjson.Object {
		return jsjson.NewObject("id", id, "label", label, "purpose", purpose, "enabled", enabled, "toggle", toggle, "model", m, "modelPath", modelPath, "modelKind", kind, "usedBy", usedBy, "instructions", in)
	}
	decisions := model("decisions", "Decisions", "Answers a fixed question about a piece of state. One model serves several steps: the mail checks, decision steps, requirement checks and the activity classifier.",
		t.MailCheck || s.MailGate, nil, s.DecisionsModel, "decisions.model", "decision", "Mail checks, decision steps, requirement checks, activity classifier",
		instr("", "", false, nil, "Its questions live in src/mail-check.ts and src/activity-classify.ts, and the mail rules in the mail-to-human template (Settings › Instructions)."))
	decisions.Set("extras", []jsjson.Value{
		extra("decisions.mailCheck", "bool", "Check my mail", "Ask whether each mail to you follows the rules, and show the verdict on the message."),
		extra("decisions.mailGate", "bool", "Check mail before it is sent", "Ask about an agent's mail to you before it is delivered; a mail that fails is refused and the agent fixes it."),
		extra("decisions.suggestRescore", "bool", "Rescore prompt suggestions", "After a pause in typing, ask the model to rescore the top suggestions and show only the close matches; costs a call per pause."),
	})
	titles := model("mailTitles", "Mail titles", "Gives every mail a title of one to three words, and every mail to you a short summary for the swipe cards.",
		t.MailTitlesModel != "", nil, t.MailTitlesModel, "mail.titles.model", "openrouter", nil,
		instr(own(t.MailTitleInstructions, MailTitlePrompt), MailTitlePrompt, true, "tiny.mailTitles.titleInstructions", "Titles a mail. An empty model turns the step off."))
	titles.Set("more", []jsjson.Value{jsjson.NewObject("label", "Summary prompt", "text", own(t.MailSummaryInstructions, MailSummaryPrompt), "default", MailSummaryPrompt, "editable", true,
		"path", "tiny.mailTitles.summaryInstructions", "note", `Titles a mail to you and also summarises it for the swipe cards. The reply must keep the "Title:" and "Summary:" lines.`)})
	titles.Set("extras", none)
	blocks := model("blockSummaries", "Instruction summaries", "Writes a one- or two-sentence summary of each instruction block for the Instructions inventory, cached until the text, the model or the prompt changes.",
		t.BlockSummariesModel != "", nil, t.BlockSummariesModel, "instructions.summaries.model", "openrouter", nil,
		instr(own(t.BlockSummaryInstructions, BlockSummaryPrompt), BlockSummaryPrompt, true, "tiny.blockSummaries.instructions", "An empty model turns the step off."))
	blocks.Set("extras", none)
	classify := model("activityClassify", "Activity classifier", "Labels the activity items the rules cannot settle, using the decision model.",
		t.Classify.Enabled, "activity.classify.enabled", s.DecisionsModel, "decisions.model", "decision", nil,
		instr("", "", false, nil, "Its question and category definitions live in src/activity-classify.ts. It uses the decision model above."))
	classify.Set("extras", []jsjson.Value{
		extra("activity.classify.maxUsdPerDay", "number", "Daily cap", "No more than this is spent on classifying in a UTC day.", "unit", "$", "min", 0, "step", 0.05),
		extra("activity.classify.concurrency", "number", "Items at once", "How many items are classified in parallel. More than 4 hits OpenRouter's rate limit.", "min", 1, "max", 4),
	})
	// The tool summary's text is `instructions || default`: a blank-but-not-empty override is shown as it is.
	summaryText := t.ToolSummary.Instructions
	if summaryText == "" {
		summaryText = ToolSummaryInstructions
	}
	summary := model("toolSummary", "Tool summary", "Summarises one tool call into two fields: the tool in plain English and what the agent is doing.",
		t.ToolSummary.Enabled, "tiny.toolSummary.enabled", t.ToolSummary.Model, "tiny.toolSummary.model", "openrouter", nil,
		instr(summaryText, ToolSummaryInstructions, true, "tiny.toolSummary.instructions", ""))
	summary.Set("extras", none)
	names := model("toolNames", "Tool names", "Names each tool once in plain English, for the conversation view (the built-in tools are named in code). Stored and reused for ever.",
		t.ToolNames.Enabled, "tiny.toolNames.enabled", t.ToolNames.Model, "tiny.toolNames.model", "openrouter", nil,
		instr(ToolNameInstructions, ToolNameInstructions, false, nil, ""))
	names.Set("extras", none)
	return []jsjson.Value{decisions, titles, blocks, classify, summary, names}
}
