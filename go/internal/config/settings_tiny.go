package config

import (
	"encoding/json"
	"math"

	"stam/internal/jsjson"
)

// TinySettings are the keys of the tiny-step models (src/tiny-models.ts, S-1480) as src/settings.ts reads them:
// decisions.mailCheck and suggestRescore, mail.titles.model, instructions.summaries.model, tiny.* and
// activity.classify.*. decisions.model and mailGate are DecisionsModel and MailGate.
type TinySettings struct {
	// MailCheck is decisions.mailCheck: on unless the file says false.
	MailCheck bool
	// SuggestRescore is decisions.suggestRescore: off unless the file says true.
	SuggestRescore bool
	// MailTitlesModel is mail.titles.model, trimmed; "" (the step off) unless a string.
	MailTitlesModel string
	// BlockSummariesModel is instructions.summaries.model, trimmed; "" (the step off) unless a string.
	BlockSummariesModel string
	ToolSummary         ToolSummarySettings
	ToolNames           ToolNamesSettings
	// MailTitleInstructions and MailSummaryInstructions are tiny.mailTitles.titleInstructions and summaryInstructions,
	// "" (the shipped prompt) unless a string.
	MailTitleInstructions   string
	MailSummaryInstructions string
	// BlockSummaryInstructions is tiny.blockSummaries.instructions, "" (the shipped prompt) unless a string.
	BlockSummaryInstructions string
	Classify                 ClassifySettings
}

// ToolSummarySettings is tiny.toolSummary: off unless enabled is true, the default model unless a non-blank string,
// and its own instructions ("" for the shipped ones).
type ToolSummarySettings struct {
	Enabled      bool
	Model        string
	Instructions string
}

// ToolNamesSettings is tiny.toolNames: on unless enabled is false, the default model unless a non-blank string.
type ToolNamesSettings struct {
	Enabled bool
	Model   string
}

// ClassifySettings is activity.classify: off unless enabled is true; the daily cap and concurrency are non-negative
// numbers, else 0.2 and 2, and concurrency is a whole number of at least 1.
type ClassifySettings struct {
	Enabled      bool
	MaxUsdPerDay float64
	Concurrency  float64
}

// tinyDefaultModel is DEFAULTS.tiny.toolSummary.model and DEFAULTS.tiny.toolNames.model.
const tinyDefaultModel = "google/gemma-3-4b-it"

// parseTiny reads TinySettings from a settings.json document, as src/settings.ts does.
func parseTiny(data []byte) TinySettings {
	var user struct {
		Decisions struct {
			MailCheck      any `json:"mailCheck"`
			SuggestRescore any `json:"suggestRescore"`
		} `json:"decisions"`
		Mail struct {
			Titles struct {
				Model any `json:"model"`
			} `json:"titles"`
		} `json:"mail"`
		Instructions struct {
			Summaries struct {
				Model any `json:"model"`
			} `json:"summaries"`
		} `json:"instructions"`
		Tiny struct {
			ToolSummary struct {
				Enabled      any `json:"enabled"`
				Model        any `json:"model"`
				Instructions any `json:"instructions"`
			} `json:"toolSummary"`
			ToolNames struct {
				Enabled any `json:"enabled"`
				Model   any `json:"model"`
			} `json:"toolNames"`
			MailTitles struct {
				TitleInstructions   any `json:"titleInstructions"`
				SummaryInstructions any `json:"summaryInstructions"`
			} `json:"mailTitles"`
			BlockSummaries struct {
				Instructions any `json:"instructions"`
			} `json:"blockSummaries"`
		} `json:"tiny"`
		Activity struct {
			Classify struct {
				Enabled      any `json:"enabled"`
				MaxUsdPerDay any `json:"maxUsdPerDay"`
				Concurrency  any `json:"concurrency"`
			} `json:"classify"`
		} `json:"activity"`
	}
	// A key of the wrong shape (a string where an object goes) reads as unset, as TS's optional chaining does.
	if len(data) > 0 {
		_ = json.Unmarshal(data, &user)
	}
	str := func(v any) string { s, _ := v.(string); return s }
	model := func(v any) string {
		if m := jsjson.Trim(str(v)); m != "" {
			return m
		}
		return tinyDefaultModel
	}
	nonNegative := func(v any, d float64) float64 {
		if n, ok := v.(float64); ok && !math.IsInf(n, 0) && n >= 0 {
			return n
		}
		return d
	}
	t := user.Tiny
	return TinySettings{
		MailCheck:                user.Decisions.MailCheck != false,
		SuggestRescore:           user.Decisions.SuggestRescore == true,
		MailTitlesModel:          jsjson.Trim(str(user.Mail.Titles.Model)),
		BlockSummariesModel:      jsjson.Trim(str(user.Instructions.Summaries.Model)),
		ToolSummary:              ToolSummarySettings{Enabled: t.ToolSummary.Enabled == true, Model: model(t.ToolSummary.Model), Instructions: str(t.ToolSummary.Instructions)},
		ToolNames:                ToolNamesSettings{Enabled: t.ToolNames.Enabled != false, Model: model(t.ToolNames.Model)},
		MailTitleInstructions:    str(t.MailTitles.TitleInstructions),
		MailSummaryInstructions:  str(t.MailTitles.SummaryInstructions),
		BlockSummaryInstructions: str(t.BlockSummaries.Instructions),
		Classify: ClassifySettings{
			Enabled:      user.Activity.Classify.Enabled == true,
			MaxUsdPerDay: nonNegative(user.Activity.Classify.MaxUsdPerDay, 0.2),
			Concurrency:  math.Max(1, math.Floor(nonNegative(user.Activity.Classify.Concurrency, 2))),
		},
	}
}
