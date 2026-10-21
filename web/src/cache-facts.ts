// Prompt caching per harness, for Settings › Prompt caching (S-2239): what each harness's provider
// documents about its cache window and prices. Fixed facts, not settings: from the S-2191 research
// (2026-10-19) and the sources listed with each harness. Multipliers are of the uncached input price.
// stam's own timers are not here: they are settings, read live (cacheTimers).

export type CacheHarness = 'claude' | 'codex' | 'opencode'

export interface CacheFacts {
  harness: CacheHarness
  // The window a write lasts, on a subscription login and on credits or an API key.
  ttl: { subscription: string; credits: string }
  write: string
  read: string
  // Whether the harness compacts an idle conversation on its own.
  idleCompaction: { own: boolean; note: string }
  sources: { label: string; url: string }[]
}

export const CACHE_FACTS: CacheFacts[] = [
  {
    harness: 'claude',
    ttl: { subscription: '1 hour (5 minutes for subagents)', credits: '5 minutes, also on a subscription that spills into credits' },
    write: '2× for a 1-hour write, 1.25× for a 5-minute one',
    read: '0.05× (Opus, Sonnet), 0.025× (Fable), 0.1× (Haiku)',
    idleCompaction: { own: true, note: 'At about 54 minutes idle over 200k tokens. Off for agents mootr starts, which mootr compacts itself.' },
    sources: [
      { label: 'Claude Code prompt caching', url: 'https://code.claude.com/docs/en/prompt-caching' },
      { label: 'Claude API prompt caching', url: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching' },
      { label: 'Claude Code settings', url: 'https://code.claude.com/docs/en/settings-reference' },
    ],
  },
  {
    harness: 'codex',
    ttl: { subscription: '30 minutes or more', credits: '30 minutes' },
    write: 'No write charge on credits; 1.25× on the API',
    read: '0.05×',
    idleCompaction: { own: false, note: 'Compacts only at the context limit.' },
    sources: [
      { label: 'OpenAI prompt caching', url: 'https://developers.openai.com/api/docs/guides/prompt-caching' },
      { label: 'Codex pricing', url: 'https://learn.chatgpt.com/docs/pricing' },
    ],
  },
  {
    harness: 'opencode',
    ttl: { subscription: 'Not documented', credits: 'Not documented; OpenRouter keeps a provider for about 10 minutes idle' },
    write: '1×, the input price',
    read: '0.1× (DeepSeek)',
    idleCompaction: { own: false, note: 'Compacts only at the context limit.' },
    sources: [
      { label: 'OpenRouter prompt caching', url: 'https://openrouter.ai/docs/prompt-caching' },
      { label: 'DeepSeek context caching', url: 'https://deepseek.com/en/news/context-caching/' },
    ],
  },
]

// stam's timers around the cache, each read from its settings path and edited by it (S-2240). `on` is
// false when the feature is off, and `dflt` is what the daemon uses when settings.json leaves it out.
export interface CacheTimer { path: string; label: string; help: string; value: string; on: boolean; dflt: number }

type Obj = Record<string, unknown>
// What the daemon uses for a key settings.json leaves out: the same as DEFAULTS in src/settings.ts.
const TIMER_DEFAULTS: Obj = { rest: { enabled: true, afterMinutes: 20, graceMinutes: 2 }, idleCompaction: { enabled: true, idleMinutes: 50 } }
const read = (s: Obj, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), s)
const at = (s: Obj, path: string): unknown => read(s, path) ?? read(TIMER_DEFAULTS, path)
const minutes = (v: unknown) => (typeof v === 'number' ? `${v} minute${v === 1 ? '' : 's'}` : 'Not set')
const off = (s: Obj, path: string, text: string) => (at(s, path) === false ? 'Off' : text)
const timer = (s: Obj, enabled: string, path: string, label: string, help: string): CacheTimer =>
  ({ path, label, help, value: off(s, enabled, minutes(at(s, path))), on: at(s, enabled) !== false, dflt: read(TIMER_DEFAULTS, path) as number })

// `s` is settings.json as stored, so a key it leaves out takes the daemon's default.
export function cacheTimers(s: Obj): CacheTimer[] {
  return [
    timer(s, 'rest.enabled', 'rest.afterMinutes', 'Rest after idle', 'An idle agent with nothing to wait on stops its harness, keeping its conversation.'),
    timer(s, 'rest.enabled', 'rest.graceMinutes', 'Rest after a long wait starts', 'An agent waiting on something that will take long rests this soon after its turn ends.'),
    timer(s, 'idleCompaction.enabled', 'idleCompaction.idleMinutes', 'Compact while idle after', 'Before a 1-hour cache expires, a running or resting agent over the threshold is compacted while its cache is warm.'),
  ]
}

// The harnesses' own cache and compaction settings stam passes on at launch (settings.harness, S-2240),
// each edited by its `path`. Null clears a key: the harness keeps its default. The ranges are the ones
// src/settings.ts HARNESS_KEYS checks on save.
export interface HarnessSetting {
  harness: CacheHarness
  path: string
  label: string
  help: string
  // A choice of values, or a token count.
  options?: { v: string | boolean | null; label: string }[]
  tokens?: { min: number; max?: number }
}

const TTL_OPTIONS = [{ v: null, label: 'Default' }, { v: '5m', label: '5 minutes' }, { v: '1h', label: '1 hour' }]

export const HARNESS_SETTINGS: HarnessSetting[] = [
  { harness: 'claude', path: 'harness.claude.promptCacheTtl', label: 'Cache window', help: 'For the main conversation. Default: 1 hour on a subscription, 5 minutes on credits.', options: TTL_OPTIONS },
  { harness: 'claude', path: 'harness.claude.subagentPromptCacheTtl', label: 'Cache window for subagents', help: 'Default: 5 minutes.', options: TTL_OPTIONS },
  { harness: 'claude', path: 'harness.claude.idleCompaction', label: "Claude Code's own idle compaction", help: 'Off by default, as mootr compacts idle agents itself before the cache expires.', options: [{ v: null, label: 'Off' }, { v: true, label: 'On' }] },
  { harness: 'claude', path: 'harness.claude.autoCompactWindow', label: 'Compact at', help: 'Tokens, 100,000 to 1,000,000. Empty: the window Claude Code tunes for the model.', tokens: { min: 100_000, max: 1_000_000 } },
  { harness: 'codex', path: 'harness.codex.model_auto_compact_token_limit', label: 'Compact at', help: "Tokens. Empty: Codex's limit for the model.", tokens: { min: 1 } },
]

// What a harness setting reads as, for the read-only panel.
export function harnessValue(s: Obj, h: HarnessSetting): string {
  const v = read(s, h.path)
  if (v === undefined || v === null) return h.options?.find((o) => o.v === null)?.label ?? 'Default'
  if (h.options) return h.options.find((o) => o.v === v)?.label ?? String(v)
  return typeof v === 'number' ? `${v.toLocaleString('en-US')} tokens` : String(v)
}
