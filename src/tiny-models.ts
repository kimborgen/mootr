// The registry of tiny-step models (S-1480): every cheap model call stam makes for itself, each
// with an id, a label, what it is for, whether it is on, its model, its instructions and its own
// extra settings. Settings › Tiny models lists them, a page each.
//
// Entries read through to the settings keys the steps already used (decisions.*, mail.titles.model,
// instructions.summaries.model, activity.classify.*), so no existing setting moves or changes
// meaning; `settingsPaths` names the keys a page writes. Only the tool summary has its own key,
// tiny.*, with editable instructions (empty means the shipped default): the tool summary, the mail
// title and summary prompts and the block summary prompt. The decision questions are per check and
// live in code, so their instructions are shown read-only (`editable: false`).
import { settings, type Settings } from './settings.ts';
import { TITLE_PROMPT, SUMMARY_PROMPT as MAIL_SUMMARY_PROMPT } from './mail-title.ts';
import { SUMMARY_PROMPT as BLOCK_SUMMARY_PROMPT } from './block-summaries.ts';

export type TinyId = 'decisions' | 'mailTitles' | 'blockSummaries' | 'activityClassify' | 'toolSummary';

// What a tool summary asks for: one tool call in two fields. S-1481 builds the feature that uses it.
export const TOOL_SUMMARY_FIELDS = { tool: 'the tool in plain English, 1-3 words', doing: 'what the agent is doing, one short sentence of at most 12 words' } as const;
export const TOOL_SUMMARY_MAX_WORDS = 12;
export const TOOL_SUMMARY_DEFAULT_INSTRUCTIONS = [
  'You summarise one tool call an AI coding agent made. You get the tool name and its input.',
  'Answer with JSON of exactly two string fields and nothing else:',
  '{"tool": "...", "doing": "..."}',
  '"tool" is the tool in plain English, one to three words, for example "send mail", "edit file", "run command".',
  `"doing" is what the agent is doing, one short sentence of at most ${TOOL_SUMMARY_MAX_WORDS} words, for example "instructing agent cost-budget-mgr that its tree is not working".`,
  'Name agents, files and ITSA keys as they appear. No Markdown, no preamble, no quotation marks inside the values.',
].join('\n');

export interface Instr { text: string; default: string; editable: boolean; path: string | null; note?: string }

export interface TinyModel {
  id: TinyId;
  label: string;
  purpose: string;
  // Off means the step asks nothing and spends nothing. `toggle` is the settings path a page writes
  // to turn it on or off; null when the step is on by having a model (empty model: off).
  enabled: boolean;
  toggle: string | null;
  // The model id the step calls, '' when it has none set.
  model: string;
  modelPath: string;
  // Where the model is picked from: OpenRouter's chat catalogue, or the decision model's id.
  modelKind: 'openrouter' | 'decision';
  // What else calls this model, for a step with no on/off of its own: the model is shared, so
  // turning one use off doesn't stop the others. Null for a step that is off by itself.
  usedBy: string | null;
  instructions: Instr;
  // A step with a second prompt (mail titles: the summary prompt) lists it here, labelled.
  more?: (Instr & { label: string })[];
  // Extra settings of the step, each a settings path with its kind, label and help.
  extras: { path: string; kind: 'bool' | 'number'; label: string; help: string; unit?: string; min?: number; max?: number; step?: number }[];
}

export function tinyModels(s: Settings = settings()): TinyModel[] {
  const ts = s.tiny.toolSummary;
  const mt = s.tiny.mailTitles;
  const bs = s.tiny.blockSummaries;
  return [
    {
      id: 'decisions',
      label: 'Decisions',
      purpose: 'Answers a fixed question about a piece of state. One model serves several steps: the mail checks, decision steps, requirement checks and the activity classifier.',
      enabled: s.decisions.mailCheck || s.decisions.mailGate,
      toggle: null,
      model: s.decisions.model,
      modelPath: 'decisions.model',
      modelKind: 'decision',
      usedBy: 'Mail checks, decision steps, requirement checks, activity classifier',
      instructions: { text: '', default: '', editable: false, path: null, note: 'Its questions live in src/mail-check.ts and src/activity-classify.ts, and the mail rules in the mail-to-human template (Settings › Instructions).' },
      extras: [
        { path: 'decisions.mailCheck', kind: 'bool', label: 'Check my mail', help: 'Ask whether each mail to you follows the rules, and show the verdict on the message.' },
        { path: 'decisions.mailGate', kind: 'bool', label: 'Check mail before it is sent', help: "Ask about an agent's mail to you before it is delivered; a mail that fails is refused and the agent fixes it." },
        { path: 'decisions.suggestRescore', kind: 'bool', label: 'Rescore prompt suggestions', help: 'After a pause in typing, ask the model to rescore the top suggestions and show only the close matches; costs a call per pause.' },
      ],
    },
    {
      id: 'mailTitles',
      label: 'Mail titles',
      purpose: 'Gives every mail a title of one to three words, and every mail to you a short summary for the swipe cards.',
      enabled: s.mail.titles.model !== '',
      toggle: null,
      model: s.mail.titles.model,
      modelPath: 'mail.titles.model',
      modelKind: 'openrouter',
      usedBy: null,
      instructions: { text: mt.titleInstructions.trim() ? mt.titleInstructions : TITLE_PROMPT, default: TITLE_PROMPT, editable: true, path: 'tiny.mailTitles.titleInstructions', note: 'Titles a mail. An empty model turns the step off.' },
      more: [{ label: 'Summary prompt', text: mt.summaryInstructions.trim() ? mt.summaryInstructions : MAIL_SUMMARY_PROMPT, default: MAIL_SUMMARY_PROMPT, editable: true, path: 'tiny.mailTitles.summaryInstructions', note: 'Titles a mail to you and also summarises it for the swipe cards. The reply must keep the "Title:" and "Summary:" lines.' }],
      extras: [],
    },
    {
      id: 'blockSummaries',
      label: 'Instruction summaries',
      purpose: 'Writes a one- or two-sentence summary of each instruction block for the Instructions inventory, cached until the text, the model or the prompt changes.',
      enabled: s.instructions.summaries.model !== '',
      toggle: null,
      model: s.instructions.summaries.model,
      modelPath: 'instructions.summaries.model',
      modelKind: 'openrouter',
      usedBy: null,
      instructions: { text: bs.instructions.trim() ? bs.instructions : BLOCK_SUMMARY_PROMPT, default: BLOCK_SUMMARY_PROMPT, editable: true, path: 'tiny.blockSummaries.instructions', note: 'An empty model turns the step off.' },
      extras: [],
    },
    {
      id: 'activityClassify',
      label: 'Activity classifier',
      purpose: 'Labels the activity items the rules cannot settle, using the decision model.',
      enabled: s.activity.classify.enabled,
      toggle: 'activity.classify.enabled',
      model: s.decisions.model,
      modelPath: 'decisions.model',
      modelKind: 'decision',
      usedBy: null,
      instructions: { text: '', default: '', editable: false, path: null, note: 'Its question and category definitions live in src/activity-classify.ts. It uses the decision model above.' },
      extras: [
        { path: 'activity.classify.maxUsdPerDay', kind: 'number', label: 'Daily cap', help: 'No more than this is spent on classifying in a UTC day.', unit: '$', min: 0, step: 0.05 },
        { path: 'activity.classify.concurrency', kind: 'number', label: 'Items at once', help: "How many items are classified in parallel. More than 4 hits OpenRouter's rate limit.", min: 1, max: 4 },
      ],
    },
    {
      id: 'toolSummary',
      label: 'Tool summary',
      purpose: 'Summarises one tool call into two fields: the tool in plain English and what the agent is doing.',
      enabled: ts.enabled,
      toggle: 'tiny.toolSummary.enabled',
      model: ts.model,
      modelPath: 'tiny.toolSummary.model',
      modelKind: 'openrouter',
      usedBy: null,
      instructions: { text: ts.instructions || TOOL_SUMMARY_DEFAULT_INSTRUCTIONS, default: TOOL_SUMMARY_DEFAULT_INSTRUCTIONS, editable: true, path: 'tiny.toolSummary.instructions' },
      extras: [],
    },
  ];
}

// What the tool-summary feature (S-1481) reads: whether to run, which model, and the system prompt.
export interface ToolSummaryConfig { enabled: boolean; model: string; instructions: string; maxWords: number }
export function toolSummaryConfig(s: Settings = settings()): ToolSummaryConfig {
  const t = s.tiny.toolSummary;
  return { enabled: t.enabled, model: t.model, instructions: t.instructions.trim() ? t.instructions : TOOL_SUMMARY_DEFAULT_INSTRUCTIONS, maxWords: TOOL_SUMMARY_MAX_WORDS };
}
