// Mail components: the visual blocks agents put in mail (docs/mail-components.md). Each is
// plain Markdown or a fenced block with a component name, so a mail still reads as text in
// an agent's terminal. This renders a body to sanitized HTML; the thread wires the clicks.
import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import type { Mermaid } from 'mermaid';
import type { HLJSApi } from 'highlight.js';
import type { TokenizerAndRendererExtension } from 'marked';
import { icon } from '../icons';
import { refLinks } from './refs';
import { parsePatch, type PatchRow } from './parsePatch';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ESCAPES[c]);
let mention: (name: string) => string | null = () => null; // name -> HTML for a known agent, set by the app
let itsaLink: (key: string) => string | null = () => null; // key -> HTML for a known ITSA, set by the app
export function configure(opts: { mention?: (name: string) => string | null; itsa?: (key: string) => string | null }): void {
  if (opts.mention) mention = opts.mention;
  if (opts.itsa) itsaLink = opts.itsa;
}

// Links in mail open in a new tab.
DOMPurify.addHook('afterSanitizeAttributes', (n) => { if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener'); } });

// --- TLDR -------------------------------------------------------------------------
const TLDR = /^\s*(?:\*\*)?TL;?DR(?:\*\*)?\s*:?\s*(?:\*\*)?\s*(.+)$/i;
// The body's TLDR line, if its first line is one, and the rest.
export function splitTldr(body: unknown): { tldr: string | null; rest: string } {
  const text = String(body ?? '');
  const nl = text.search(/\n|$/);
  const m = text.slice(0, nl).match(TLDR);
  return m ? { tldr: m[1].replace(/\*\*\s*$/, '').trim(), rest: text.slice(nl + 1) } : { tldr: null, rest: text };
}

// --- Decision -----------------------------------------------------------------------
// Question lines, then one "- Option: why" line per option; "(recommended)" marks one. With
// no options it's a yes-or-no question, and "(recommended: yes)" in it marks the answer.
export interface DecisionOption { label: string; why: string; rec: boolean }
export interface ParsedDecision { question: string; options: DecisionOption[]; yesno: boolean }
export function parseDecision(text: string): ParsedDecision {
  const question: string[] = [], options: DecisionOption[] = [];
  for (const line of text.split('\n')) {
    const o = line.match(/^\s*[-*+]\s+(.*)$/);
    if (!o) { if (options.length && line.trim()) options.at(-1)!.why += ' ' + line.trim(); else if (!options.length) question.push(line); continue; }
    let t = o[1].trim();
    const rec = /\((recommended|recommend)\)|\*\*recommended\*\*/i.test(t);
    t = t.replace(/\s*\((recommended|recommend)\)|\s*\*\*recommended\*\*/gi, '').trim();
    const cut = t.search(/: | — | - /);
    const label = (cut > 0 && cut <= 60 ? t.slice(0, cut) : t).replace(/^\*\*(.*)\*\*$/, '$1').trim();
    const why = cut > 0 && cut <= 60 ? t.slice(cut).replace(/^(: | — | - )/, '').trim() : '';
    options.push({ label, why, rec });
  }
  let q = question.join('\n').trim();
  if (options.length) return { question: q, options, yesno: false };
  const r = q.match(/\s*\(recommended:?\s*(yes|no)\)/i);
  if (r) q = q.replace(r[0], '').trim();
  const rec = r?.[1].toLowerCase();
  return { question: q, options: [{ label: 'Yes', why: '', rec: rec === 'yes' }, { label: 'No', why: '', rec: rec === 'no' }], yesno: true };
}
// The texts a click sends, and what marks a reply as that answer.
export const choiceText = (label: string): string => `Chose **${label}**.`;
const PICKED = 'Picked ';
export const pickText = (labels: string[], suggested = false): string => PICKED + labels.map((l) => `**${l}**`).join(', ') + (suggested ? ' (as suggested).' : '.');
// A decision block's question, by its first line: answers quote it so they say what they answer.
export const questionOf = (d: Element): string => d.querySelector('.mb-q')?.textContent?.trim().split('\n')[0] ?? '';
export const answerText = (d: Element, body: string): string => { const q = questionOf(d); return (q ? `> ${q}\n\n` : '') + body; };
// The agent reads this reply: it says the ask is deferred and stays open (S-353).
const DEFERRED = "Deferring this one: still open, I'll decide later. Keep working on what doesn't depend on it.";
// Detects a deferral, both this reply and the older "Deferring this one. Go with your recommendation…" ones.
const DEFER_MARK = 'Deferring this one';
// A note the human wrote on a decision, alone (an answer in their own words) or after a choice.
const NOTED = 'Note: ';
export const noteText = (note: string): string => NOTED + note;
// A deferral leaves the decision open: it doesn't pick the recommendation.
export const deferText = (): string => DEFERRED;
function decision(text: string, n: number, multi = false): string | false {
  const { question, options, yesno } = parseDecision(text);
  if (!question && yesno) return false;
  if (multi && yesno) return false;
  const mark = (o: DecisionOption) => (multi ? `<span class="mb-box">${icon(o.rec ? 'square-check' : 'square', 'xs')}</span>` : `<span class="mb-mark">${icon('check', 'xs')}</span>`);
  return `<div class="mb-decision${yesno ? ' yesno' : ''}${multi ? ' multi' : ''}" data-decision="${n}">
    <div class="mb-label">${icon(multi ? 'list-checks' : 'circle-help', 'xs')}<span>${yesno ? 'Question' : multi ? 'Pick several' : 'Decision'}</span></div>
    ${question ? `<div class="mb-q">${inner(question)}</div>` : ''}
    <div class="mb-options">${options.map((o) => `<button class="mb-opt${o.rec ? ' rec' : ''}${multi && o.rec ? ' sel' : ''}" data-choose="${esc(o.label)}" type="button"${multi ? ` aria-pressed="${o.rec}"` : ''}>
      ${mark(o)}<span class="mb-opt-text"><span class="mb-opt-label">${inline(o.label)}${o.rec ? '<span class="mb-rec">Recommended</span>' : ''}</span>${o.why ? `<span class="mb-why">${inline(o.why)}</span>` : ''}</span></button>`).join('')}</div>
    <div class="mb-foot"><span class="mb-status"></span><button class="mb-own" data-own type="button">${icon('pencil', 'xs')}Add a note</button><button class="mb-own" data-defer="" type="button">${icon('clock', 'xs')}Decide later</button></div>
  </div>`;
}

// --- Metrics ------------------------------------------------------------------------
// "Label: value", optionally " — note" and a trailing [success], [warning], or [error].
const TONES: Record<string, string> = { success: 'success', ok: 'success', good: 'success', warning: 'warning', warn: 'warning', error: 'error', bad: 'error', fail: 'error' };
function metrics(text: string): string | false {
  const rows = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    let tone = '';
    l = l.replace(/\s*\[(success|ok|good|warning|warn|error|bad|fail)\]/i, (_, t: string) => { tone = TONES[t.toLowerCase()]; return ''; }).trim();
    const c = l.indexOf(':');
    if (c < 1) return null;
    const [value, note] = l.slice(c + 1).trim().split(/\s+—\s+|\s+--\s+/);
    return { label: l.slice(0, c).trim(), value, note, tone };
  }).filter((r): r is NonNullable<typeof r> => r !== null);
  if (!rows.length) return false;
  return `<div class="mb-metrics">${rows.map((r) => `<div class="mb-metric${r.tone ? ' ' + r.tone : ''}"><div class="mb-mlabel">${esc(r.label)}</div><div class="mb-mval">${inline(r.value ?? '')}</div>${r.note ? `<div class="mb-mnote">${inline(r.note)}</div>` : ''}</div>`).join('')}</div>`;
}

// --- Diff ---------------------------------------------------------------------------
// A unified diff: a header with the counts over one scroller of folds, one per file.
const DIFF_OPEN_ROWS = 18;
function diff(text: string): string {
  const files = parsePatch(text);
  const total = files.reduce((n, x) => n + x.rows.length, 0);
  const add = files.reduce((n, x) => n + x.add, 0), del = files.reduce((n, x) => n + x.del, 0);
  // The marker is the row's first character, in its own span, so copying gives back the patch lines. `--ind` feeds the hanging indent.
  const row = (r: PatchRow) => `<span class="l ${r.kind}" style="--ind:${r.ind}">${r.kind === 'hunk' ? esc(r.text) : `<span class="m">${esc(r.text.charAt(0) || ' ')}</span>${esc(r.text.slice(1))}`}</span>`;
  // Every file opens when the whole diff fits the phone's cap (DIFF_OPEN_ROWS); otherwise only the first does.
  const fold = (x: (typeof files)[number], i: number) => {
    const slash = x.path.lastIndexOf('/'), dir = x.path.slice(0, slash + 1), name = x.path.slice(slash + 1) || 'diff';
    return `<details class="mb-file"${total <= DIFF_OPEN_ROWS || i === 0 ? ' open' : ''}><summary>${icon('chevron-right', 'xs')}<span class="mb-path">${dir ? `<span class="mb-dir">${esc(dir)}</span>` : ''}<span class="mb-name">${esc(name)}</span></span><span class="mb-count"><span class="add">+${x.add}</span> <span class="del">−${x.del}</span></span></summary><pre><code>${x.rows.map(row).join('')}</code></pre></details>`;
  };
  const n = files.length, label = `${n} file${n === 1 ? '' : 's'}`;
  // The header is a sibling of the folds, never inside a summary. Its Open slot stays hidden until a viewer can take the patch.
  return `<div class="mb-diff"><div class="mb-dhead"><span class="mb-dsum">${label} · <span class="add">+${add}</span> <span class="del">−${del}</span></span><span class="mb-dopen" hidden></span></div><div class="mb-dscroll" role="region" tabindex="0" aria-label="Diff, ${label}">${files.map(fold).join('')}</div></div>`;
}

// --- Checklist --------------------------------------------------------------------
// "- [x] done", "- [ ] next", "- [~] in progress", "- [!] blocked", "- [-] skipped".
const CHECK: Record<string, string> = { x: 'done', X: 'done', ' ': 'todo', '': 'todo', '~': 'doing', '>': 'doing', '!': 'blocked', '-': 'skipped' };
const CHECK_ICON: Record<string, string> = { done: 'circle-check', todo: 'circle', doing: 'circle-dot', blocked: 'octagon-x', skipped: 'circle-minus' };
const CHECK_LABEL: Record<string, string> = { done: 'Done', todo: 'Next', doing: 'In progress', blocked: 'Blocked', skipped: 'Skipped' };
function checklist(text: string): string | false {
  const items = text.split('\n').filter((l) => l.trim()).map((l) => {
    const m = l.match(/^\s*(?:[-*+]\s+)?(?:\[(.?)\]\s*)?(.*)$/);
    return { state: CHECK[m![1] ?? ''] ?? 'todo', text: m![2] };
  });
  if (!items.length) return false;
  return `<ul class="mb-checklist">${items.map((i) => `<li class="${i.state}"><span class="mb-ci" title="${CHECK_LABEL[i.state]}">${icon(CHECK_ICON[i.state], 'xs')}</span><span>${inline(i.text)}</span></li>`).join('')}</ul>`;
}

// --- Test results -------------------------------------------------------------------
// One test per line: "PASS name", "FAIL name", "SKIP name" (or ✓, ✗, and ok/not ok);
// indented lines under a test are its output. "passed: 212" lines give counts.
function tests(text: string): string | false {
  interface TestRow { s: string; name: string; out: string[] }
  const list: TestRow[] = [], counts: Record<string, number> = {}, notes: string[] = [];
  for (const line of text.split('\n')) {
    if (/^(\s{2,}|\t)/.test(line) && list.length) { list.at(-1)!.out.push(line.replace(/^(\s{2}|\t)/, '')); continue; }
    const t = line.trim();
    if (!t) continue;
    const c = t.match(/^(passed|failed|skipped|pass|fail|skip)\s*:\s*(\d+)$/i);
    if (c) { counts[c[1][0].toLowerCase()] = +c[2]; continue; }
    const c2 = t.match(/^(\d+)\s+(passed|failed|skipped)$/i);
    if (c2) { counts[c2[2][0].toLowerCase()] = +c2[1]; continue; }
    const m = t.replace(/^[-*+]\s+/, '').match(/^(PASS|FAIL|SKIP|ok|not ok|✓|✔|✗|✘|×)\s+(.*)$/i);
    if (!m) { notes.push(t); continue; }
    const k = m[1].toLowerCase();
    list.push({ s: /^(pass|ok|✓|✔)$/.test(k) ? 'p' : k === 'skip' ? 's' : 'f', name: m[2], out: [] });
  }
  const n = (k: string) => counts[k] ?? list.filter((x) => x.s === k).length;
  const [p, f, sk] = [n('p'), n('f'), n('s')];
  if (!p && !f && !sk) return false;
  const fails = list.filter((x) => x.s === 'f'), passes = list.filter((x) => x.s === 'p');
  const total = p + f + sk || 1;
  return `<div class="mb-tests${f ? ' failing' : ''}">
    <div class="mb-label">${icon('flask-conical', 'xs')}<span>Tests</span></div>
    <div class="mb-tsum"><span class="pass">${p} passed</span>${f ? `<span class="fail">${f} failed</span>` : ''}${sk ? `<span class="skip">${sk} skipped</span>` : ''}</div>
    ${notes.length ? `<div class="mb-tnote">${notes.map(inline).join('<br>')}</div>` : ''}
    <div class="mb-bar"><i class="pass" style="width:${(p / total) * 100}%"></i><i class="fail" style="width:${(f / total) * 100}%"></i></div>
    ${fails.map((x) => x.out.length
      ? `<details class="mb-fail" open><summary>${icon('chevron-right', 'xs')}${icon('circle-x', 'xs')}<span>${inline(x.name)}</span></summary><pre><code>${esc(x.out.join('\n'))}</code></pre></details>`
      : `<div class="mb-fail">${icon('circle-x', 'xs')}<span>${inline(x.name)}</span></div>`).join('')}
    ${passes.length ? `<details class="mb-passes"><summary>${icon('chevron-right', 'xs')}<span>${passes.length} passing test${passes.length > 1 ? 's' : ''}</span></summary><ul>${passes.map((x) => `<li>${inline(x.name)}</li>`).join('')}</ul></details>` : ''}
  </div>`;
}

// --- Spend --------------------------------------------------------------------------
// "Spent: $4.20", "Budget: $10", "Estimate: $14" (what the next step adds), "For: what".
const dollars = (v: unknown): number | null => { const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };
const usd = (v: number): string => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2));
function spend(text: string): string | false {
  const kv: Record<string, string> = {};
  for (const l of text.split('\n')) { const m = l.match(/^\s*([\w ]+?)\s*:\s*(.+)$/); if (m) kv[m[1].toLowerCase()] = m[2].trim(); }
  const spent = dollars(kv.spent ?? kv.cost ?? kv.used) ?? 0;
  const budget = dollars(kv.budget ?? kv.limit ?? kv.cap);
  const est = dollars(kv.estimate ?? kv.next ?? kv.more ?? kv.projected);
  const what = kv.for ?? kv.item ?? kv.task;
  if (!spent && budget == null && est == null) return false;
  const end = spent + (est ?? 0);
  const scale = Math.max(budget ?? 0, end) || 1;
  const tone = budget != null && spent > budget ? 'error' : budget != null && end > budget ? 'warning' : '';
  return `<div class="mb-spend${tone ? ' ' + tone : ''}">
    <div class="mb-label">${icon('chart-column', 'xs')}<span>Spend${what ? ` · ${esc(what)}` : ''}</span></div>
    <div class="mb-sline"><b>${usd(spent)}</b> spent${budget != null ? ` of ${usd(budget)}` : ''}${est != null ? `<span class="mb-est">, about ${usd(est)} more${budget != null ? `, ${usd(end)} in all` : ''}</span>` : ''}${tone === 'warning' ? '<span class="mb-over">over budget</span>' : tone === 'error' ? '<span class="mb-over">over budget</span>' : ''}</div>
    <div class="mb-bar"><i class="spent" style="width:${(spent / scale) * 100}%"></i>${est ? `<i class="est" style="width:${(est / scale) * 100}%"></i>` : ''}${budget != null && budget < scale ? `<b style="left:${(budget / scale) * 100}%" title="Budget"></b>` : ''}</div>
  </div>`;
}

// --- Error --------------------------------------------------------------------------
// "Message:", "Where:", "Cause:", "Fix:" lines; other lines join the message.
function error(text: string): string | false {
  const kv: Record<string, string[]> = { message: [] };
  let key = 'message';
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*(message|error|where|at|file|cause|why|fix|next)\s*:\s*(.*)$/i);
    if (m) { key = ({ error: 'message', at: 'where', file: 'where', why: 'cause', next: 'fix' } as Record<string, string>)[m[1].toLowerCase()] ?? m[1].toLowerCase(); kv[key] = [...(kv[key] ?? []), m[2]]; }
    else if (l.trim()) kv[key] = [...(kv[key] ?? []), l];
  }
  const msg = kv.message.join('\n').trim();
  if (!msg && !kv.cause) return false;
  const row = (k: string, label: string) => (kv[k] ? `<dt>${label}</dt><dd>${inner(kv[k].join('\n'))}</dd>` : '');
  return `<div class="mb-error">
    <div class="mb-label">${icon('octagon-x', 'xs')}<span>Error</span></div>
    ${msg ? `<pre class="mb-emsg"><code>${esc(msg)}</code></pre>` : ''}
    <dl>${row('where', 'Where')}${row('cause', 'Cause')}${row('fix', 'Fix')}</dl>
  </div>`;
}

// --- Terminal excerpt -----------------------------------------------------------------
// Output with its ANSI colours (the 16 basic ones, on stam's terminal palette); "$ " lines
// are commands.
interface AnsiState { fg?: number | null; bg?: number | null; b?: number; d?: number; i?: number; u?: number }
function ansi(text: string): string {
  let out = '', st: AnsiState = {};
  const open = () => { const c = [st.fg != null && `fg${st.fg}`, st.bg != null && `bg${st.bg}`, st.b && 'b', st.d && 'd', st.i && 'it', st.u && 'u'].filter(Boolean); return c.length ? `<span class="${c.join(' ')}">` : ''; };
  for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) { if (part) { const o = open(); out += o + esc(part) + (o ? '</span>' : ''); } continue; }
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) st = {}; else if (c === 1) st.b = 1; else if (c === 2) st.d = 1; else if (c === 3) st.i = 1; else if (c === 4) st.u = 1;
      else if (c === 22) { st.b = 0; st.d = 0; } else if (c === 23) st.i = 0; else if (c === 24) st.u = 0;
      else if (c >= 30 && c <= 37) st.fg = c - 30; else if (c >= 90 && c <= 97) st.fg = c - 82; else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = c - 40; else if (c >= 100 && c <= 107) st.bg = c - 92; else if (c === 49) st.bg = null;
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : 4; // 256-colour and RGB: no palette for them, so skipped
    }
  }
  return out;
}
function terminal(text: string): string {
  const body = text.replace(/\n$/, '').split('\n').map((l) => (/^\$ /.test(l) ? `<span class="cmd"><span class="ps">$</span> ${ansi(l.slice(2))}</span>` : ansi(l))).join('\n');
  return `<div class="mb-term"><pre><code>${body}</code></pre></div>`;
}

// --- Progress -----------------------------------------------------------------------
// One bar per line: "3/5 Label", "Label: 3/5", or "60% Label".
function progress(text: string): string | false {
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => {
    let m = l.match(/(\d+)\s*\/\s*(\d+)/), done: number, of: number, label: string;
    if (m) { done = +m[1]; of = +m[2]; label = l.replace(m[0], ''); }
    else if ((m = l.match(/(\d+(?:\.\d+)?)\s*%/))) { done = +m[1]; of = 100; label = l.replace(m[0], ''); }
    else return null;
    label = label.replace(/^[\s:—-]+|[\s:—-]+$/g, '').replace(/^[-*+]\s+/, '');
    return { done: Math.min(done, of), of: of || 1, label, pct: of === 100 && !/\//.test(m[0]) };
  }).filter((r): r is NonNullable<typeof r> => r !== null);
  if (!rows.length) return false;
  return `<div class="mb-progress">${rows.map((r) => `<div class="mb-prow"><div class="mb-ptext"><span>${inline(r.label || 'Progress')}</span><span class="mb-pnum">${r.pct ? `${r.done}%` : `${r.done} of ${r.of}`}</span></div><div class="mb-bar"><i class="spent" style="width:${(r.done / r.of) * 100}%"></i></div></div>`).join('')}</div>`;
}

// --- Before and after ----------------------------------------------------------------
// "Before: name", "After: name" (an attachment's name or an image URL); other lines caption it.
// Attachments a mail already shows in its body (a before and after, or an embed), which
// the attachment strip leaves out.
export function shownAttachments(body: unknown): Set<string> {
  const refs = compareRefs(body);
  for (const m of String(body ?? '').matchAll(/```(?:embed|video|audio|image|file)\nattachment:\s*(.+)/g)) refs.add(m[1].trim());
  return refs;
}
export function compareRefs(body: unknown): Set<string> {
  const refs = new Set<string>();
  for (const m of String(body ?? '').matchAll(/```compare\n([\s\S]*?)```/g)) for (const l of m[1].split('\n')) { const x = l.match(/^\s*(before|after)\s*:\s*(.+)$/i); if (x) refs.add(x[2].trim()); }
  return refs;
}
function compare(text: string): string | false {
  let before: string | undefined, after: string | undefined;
  const caption: string[] = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\s*(before|after)\s*:\s*(.+)$/i);
    if (m) { if (m[1].toLowerCase() === 'before') before = m[2].trim(); else after = m[2].trim(); }
    else if (l.trim()) caption.push(l.trim());
  }
  if (!before || !after) return false;
  return `<figure class="mb-compare"><div class="mb-cmp-stage" style="--pos:50%">
      <img class="after" data-ref="${esc(after)}" alt="After"><img class="before" data-ref="${esc(before)}" alt="Before">
      <div class="mb-cmp-line"></div><span class="mb-cmp-tag l">Before</span><span class="mb-cmp-tag r">After</span>
      <input type="range" min="0" max="100" value="50" step="0.5" data-compare aria-label="Slide between before and after">
    </div>${caption.length ? `<figcaption>${inline(caption.join(' '))}</figcaption>` : ''}</figure>`;
}
// Points each compared image at its attachment (through attUrl(name), a URL the page can
// load as is, like the embeds') or URL.
export function resolveCompare(el: ParentNode, attUrl: (name: string) => string | null | undefined): void {
  for (const img of el.querySelectorAll<HTMLImageElement>('.mb-compare img[data-ref]')) {
    const ref = img.dataset.ref!;
    if (/^https?:\/\//.test(ref)) img.src = ref;
    else { const u = attUrl(ref); if (u) img.src = u; else img.closest('.mb-compare')!.classList.add('missing'); }
  }
}

// --- Pane ---------------------------------------------------------------------------
// An agent's terminal at the moment the mail was sent: the sender's daemon fills in
// "captured:" and the screen below "---". Without them it's a link to the terminal.
const since = (t: string): string => { const s = (Date.now() - new Date(t).getTime()) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
function pane(text: string): string | false {
  const [first, ...rest] = text.replace(/\n$/, '').split('\n');
  const name = first.trim().replace(/^@/, '');
  if (!name) return false;
  const at = rest[0]?.match(/^captured:\s*(.+)$/)?.[1];
  const cut = rest.indexOf('---');
  const screen = at && cut >= 0 ? rest.slice(cut + 1).join('\n') : null;
  const who = mention(name) ?? `<span class="mono">${esc(name)}</span>`;
  const id = who.match(/data-open-agent="([^"]+)"/)?.[1];
  const open = id ? `<a href="#" class="mb-pane-open" data-open-agent="${id}">${icon('terminal', 'xs')}Open terminal</a>` : '';
  return `<div class="mb-pane"><div class="mb-pane-head"><span>${who}<span class="muted">'s terminal${at ? ` · ${since(at)}` : ''}</span></span>${open}</div>
    ${screen != null ? `<div class="mb-term"><pre><code>${ansi(screen.replace(/`​``/g, '```'))}</code></pre></div>` : ''}</div>`;
}

// --- Diagram ------------------------------------------------------------------------
// Mermaid source, drawn by Mermaid (loaded on first use) in the design tokens' colours.
// Until it's drawn, or if it can't be, the source shows.
function diagram(text: string): string {
  return `<div class="mb-diagram"><pre class="mb-dsrc"><code>${esc(text)}</code></pre></div>`;
}
let mermaid: Mermaid | null = null, drawn = 0, queue: Promise<unknown> = Promise.resolve();
const svgs = new Map<string, string | Error>(); // theme + source -> drawn SVG, or an Error
// Mermaid can draw one diagram at a time, so calls queue; a thread re-renders often, so
// each drawing is kept and reused.
export function renderDiagrams(el: ParentNode): Promise<unknown> {
  watchTheme();
  queue = queue.then(() => draw(el)).catch(() => {});
  return queue;
}
// A theme change redraws every diagram in the new colours. Charts follow on their own,
// since they draw with the tokens.
let watching = false;
function watchTheme(): void {
  if (watching) return;
  watching = true;
  const redo = () => {
    for (const d of document.querySelectorAll<HTMLElement>('.mb-diagram.drawn')) {
      const src = d.dataset.src ?? d.querySelector('code')?.textContent;
      if (src == null) continue;
      d.classList.remove('drawn', 'failed');
      d.innerHTML = `<pre class="mb-dsrc"><code>${esc(src)}</code></pre>`;
    }
    renderDiagrams(document.body);
  };
  new MutationObserver(redo).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redo);
}
async function draw(el: ParentNode): Promise<void> {
  const todo = [...el.querySelectorAll<HTMLElement>('.mb-diagram:not(.drawn)')];
  if (!todo.length) return;
  try { mermaid ??= (await import('mermaid')).default; } catch { return; }
  const mm = mermaid;
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  const theme = v('--surface-page') + v('--text-primary');
  mm.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: 'base', fontFamily: v('--font-chrome'),
    themeVariables: {
      fontSize: v('--type-chrome-sm'), background: v('--surface-page'),
      primaryColor: v('--surface-raised'), primaryTextColor: v('--text-primary'), primaryBorderColor: v('--border-strong'),
      secondaryColor: v('--surface-sunken'), secondaryTextColor: v('--text-primary'), secondaryBorderColor: v('--border-default'),
      tertiaryColor: v('--surface-pane'), tertiaryTextColor: v('--text-primary'), tertiaryBorderColor: v('--border-default'),
      lineColor: v('--text-secondary'), textColor: v('--text-primary'), edgeLabelBackground: v('--surface-page'),
      clusterBkg: v('--surface-sunken'), clusterBorder: v('--border-default'), titleColor: v('--text-primary'),
      noteBkgColor: v('--surface-sunken'), noteTextColor: v('--text-secondary'), noteBorderColor: v('--border-default'),
      actorBkg: v('--surface-raised'), actorBorder: v('--border-strong'), actorTextColor: v('--text-primary'), actorLineColor: v('--border-default'),
      signalColor: v('--text-secondary'), signalTextColor: v('--text-primary'), labelBoxBkgColor: v('--surface-raised'), labelBoxBorderColor: v('--border-default'),
      labelTextColor: v('--text-primary'), loopTextColor: v('--text-secondary'), activationBkgColor: v('--accent-subtle'), activationBorderColor: v('--accent'),
    },
  });
  for (const d of todo) {
    if (!d.isConnected || d.classList.contains('drawn')) continue;
    const src = d.querySelector('code')!.textContent ?? '';
    const key = theme + '\n' + src;
    if (!svgs.has(key)) {
      const id = `mbd${++drawn}`;
      try { svgs.set(key, (await mm.render(id, src)).svg); }
      catch (err) { svgs.set(key, err instanceof Error ? err : new Error(String(err))); document.getElementById('d' + id)?.remove(); }
    }
    if (!d.isConnected) continue;
    const out = svgs.get(key);
    d.classList.add('drawn');
    if (out instanceof Error) {
      d.classList.add('failed');
      d.insertAdjacentHTML('afterbegin', `<div class="mb-dnote">This diagram didn't draw: ${esc(out.message.split('\n')[0])}</div>`);
    } else { d.dataset.src = src; d.innerHTML = out ?? ''; }
  }
}

// --- Clicks and slides --------------------------------------------------------------
// Handles what the components do on their own: copy, picking options, the compare slider.
// Returns true when it took the click.
export function handleClick(e: { target: EventTarget | null }): boolean {
  if (handleCopy(e)) return true;
  const target = e.target as Element;
  const th = target.closest<HTMLElement>('th[data-sort]');
  if (th) { sortTable(th); return true; }
  const more = target.closest('[data-table-more]');
  if (more) { more.closest('.mb-table')!.classList.remove('folded'); more.remove(); return true; }
  return false;
}
export function handleInput(e: { target: EventTarget | null }): void {
  const r = (e.target as Element).closest<HTMLInputElement>('[data-compare]');
  if (r) r.parentElement!.style.setProperty('--pos', r.value + '%');
}

// --- Tables -------------------------------------------------------------------------
// Markdown tables and ```table blocks (CSV or TSV) get the same treatment: numeric columns
// right-aligned in tabular figures, headers that sort on click, long tables folded, and
// [success], [warning], or [error] in a cell colouring it.
const NUM = /^[-+−]?[$€£]?\s*[-+−]?\d[\d,]*(\.\d+)?\s*(%|[kKMBG]|ms|s|h|min|x|×|GB|MB|KB|tokens?)?$/;
export function num(t: unknown): number | null {
  const s = String(t ?? '').trim().replace(/−/g, '-');
  if (!NUM.test(s)) return null;
  let v = parseFloat(s.replace(/[$€£,\s]/g, '').replace(/^\+/, ''));
  if (/k$/i.test(s)) v *= 1e3; else if (/M$/.test(s)) v *= 1e6; else if (/[BG]$/.test(s) && !/GB$/.test(s)) v *= 1e9;
  return Number.isFinite(v) ? v : null;
}
const FOLD_ROWS = 15;
function enhanceTable(t: HTMLTableElement): void {
  const head = t.tHead?.rows[0];
  const body = [...(t.tBodies[0]?.rows ?? [])];
  if (!head) return;
  const n = head.cells.length;
  for (const r of body) for (const cell of r.cells) {
    const m = cell.innerHTML.match(/\s*\[(success|ok|good|warning|warn|error|bad|fail)\]\s*/i);
    if (m) { cell.innerHTML = cell.innerHTML.replace(m[0], ' ').trim(); cell.classList.add('tone-' + TONES[m[1].toLowerCase()]); }
  }
  for (let c = 0; c < n; c++) {
    const cells = body.map((r) => r.cells[c]).filter((x) => x && x.textContent.trim() && x.textContent.trim() !== '–' && x.textContent.trim() !== '-');
    const numeric = cells.length > 0 && cells.filter((x) => num(x.textContent) != null).length / cells.length >= 0.8;
    if (numeric) { head.cells[c].classList.add('mb-num'); for (const r of body) r.cells[c]?.classList.add('mb-num'); }
    const th = head.cells[c];
    th.dataset.sort = String(c);
    th.setAttribute('aria-sort', 'none');
    th.insertAdjacentHTML('beforeend', `<span class="mb-sort">${icon('chevron-down', 'xs')}</span>`);
  }
  const box = document.createElement('div');
  box.className = 'mb-table';
  t.replaceWith(box);
  box.append(t);
  if (body.length > FOLD_ROWS + 3) {
    for (const r of body.slice(FOLD_ROWS)) r.classList.add('mb-more');
    box.classList.add('folded');
    box.insertAdjacentHTML('beforeend', `<button class="mb-showall" data-table-more type="button">Show all ${body.length} rows</button>`);
  }
}
// Splits CSV or TSV text into rows of cells; quotes may hold commas and doubled quotes.
function parseCSV(lines: string[]): string[][] {
  const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : lines[0].includes(';') ? ';' : '|';
  return lines.map((line) => {
    if (sep === '|') return line.replace(/^\s*\||\|\s*$/g, '').split('|').map((x) => x.trim());
    const out: string[] = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"' && !cur.trim()) q = true;
      else if (ch === sep) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}
// Leading "key: value" lines (only the keys given) as options, and the rest as rows.
type Opts = Record<string, string | undefined>;
function optsAndRows(text: string, keys: string[]): { opts: Opts; rows: string[][] } {
  const lines = text.split('\n').filter((l) => l.trim());
  const opts: Opts = {};
  while (lines.length) {
    const m = lines[0].match(/^\s*([a-z-]+)\s*:\s*(.*)$/i);
    if (!m || !keys.includes(m[1].toLowerCase())) break;
    opts[m[1].toLowerCase()] = m[2].trim();
    lines.shift();
  }
  return { opts, rows: lines.length ? parseCSV(lines) : [] };
}
const tableHtml = (head: string[], rows: string[][]): string => `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, i) => `<td>${inline(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
function table(text: string): string | false {
  const { opts, rows } = optsAndRows(text, ['title', 'caption']);
  if (rows.length < 2) return false;
  const cap = opts.title ?? opts.caption;
  return `<figure class="mb-tfig">${cap ? `<figcaption>${inline(cap)}</figcaption>` : ''}${tableHtml(rows[0], rows.slice(1))}</figure>`;
}
function sortTable(th: HTMLElement): void {
  const t = th.closest('table')!, c = +th.dataset.sort!;
  const dir = th.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
  for (const x of t.tHead!.rows[0].cells) x.setAttribute('aria-sort', 'none');
  th.setAttribute('aria-sort', dir);
  const tb = t.tBodies[0];
  const key = (r: HTMLTableRowElement) => r.cells[c]?.textContent.trim() ?? '';
  const rows = [...tb.rows].sort((a, b) => {
    const x = num(key(a)), y = num(key(b));
    const v = x != null && y != null ? x - y : x != null ? -1 : y != null ? 1 : key(a).localeCompare(key(b), undefined, { numeric: true });
    return dir === 'ascending' ? v : -v;
  });
  tb.append(...rows);
  const box = t.closest('.mb-table');
  if (box?.classList.contains('folded')) { box.classList.remove('folded'); box.querySelector('[data-table-more]')?.remove(); }
}

// --- Charts -------------------------------------------------------------------------
// "type: bar | line | area | donut", optional "title:", "x:", "y:", "unit:", "stacked: yes",
// "height:", then CSV: a header (the x column, then one column per series) and rows.
// Drawn as SVG after the mail is on screen, at the width it has, and again when that changes.
const CHART_KEYS = ['type', 'title', 'caption', 'x', 'y', 'unit', 'stacked', 'height', 'min', 'max', 'horizontal'];
function chart(text: string): string | false {
  const { opts, rows } = optsAndRows(text, CHART_KEYS);
  if (rows.length < 2 || rows[0].length < 2) return false;
  const [head, ...data] = rows;
  return `<figure class="mb-chart">
    ${opts.title ? `<figcaption class="mb-ctitle">${inline(opts.title)}</figcaption>` : ''}
    <div class="mb-legend"></div><div class="mb-cplot"></div><pre class="mb-csrc" hidden>${esc(text)}</pre>
    ${opts.caption ? `<figcaption class="mb-ccap">${inline(opts.caption)}</figcaption>` : ''}
    <details class="mb-cdata"><summary>${icon('chevron-right', 'xs')}<span>Data</span></summary>${tableHtml(head, data)}</details>
  </figure>`;
}
const HARNESS_SERIES: Record<string, string> = { claude: 'claude', 'claude code': 'claude', codex: 'codex', opencode: 'opencode' };
const seriesColor = (name: string, i: number): string => (HARNESS_SERIES[name.trim().toLowerCase()] ? `var(--h-${HARNESS_SERIES[name.trim().toLowerCase()]})` : `var(--series-${(i % 6) + 1})`);
function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw || 1)), f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
// A number for an axis or a readout: short (1.2k, 3.4M), money with cents, and as many
// decimals as the axis step needs.
function fmt(v: number, unit?: string, step = 0): string {
  unit ??= '';
  const money = /^[$€£]$/.test(unit ?? '');
  const abs = Math.abs(v);
  let s: string;
  if (abs >= 1e9) s = +(abs / 1e9).toFixed(1) + 'B';
  else if (abs >= 1e6) s = +(abs / 1e6).toFixed(1) + 'M';
  else if (abs >= 1e4) s = +(abs / 1e3).toFixed(1) + 'k';
  else if (step) { const d = Math.min(2, (String(+step.toPrecision(6)).split('.')[1] ?? '').length); s = abs.toFixed(money && d ? 2 : d); }
  else if (money) s = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  else s = Number.isInteger(abs) ? String(abs) : abs.toFixed(abs < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '');
  const sign = v < 0 ? '-' : '';
  if (!unit) return sign + s;
  return money ? sign + unit + s : sign + s + (/^[%x×]$/.test(unit) ? '' : ' ') + unit;
}
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(t: string, font: string): number { measureCtx ??= document.createElement('canvas').getContext('2d')!; measureCtx.font = font; return measureCtx.measureText(t).width; }
const charts = new WeakMap<Element, { width: number }>(); // figure -> { width }
let resizer: ResizeObserver | null = null;
export function renderCharts(el: ParentNode): void {
  resizer ??= new ResizeObserver((entries) => { for (const e of entries) { const f = e.target.closest<HTMLElement>('.mb-chart'); if (f && charts.get(f)?.width !== Math.round(e.contentRect.width)) drawChart(f); } });
  for (const f of el.querySelectorAll<HTMLElement>('.mb-chart')) { if (!charts.has(f)) { drawChart(f); resizer.observe(f.querySelector('.mb-cplot')!); } }
}
interface Series { name: string; color: string; values: (number | null)[] }
function drawChart(fig: HTMLElement): void {
  const plot = fig.querySelector<HTMLElement>('.mb-cplot')!;
  const W = Math.round(plot.clientWidth);
  if (!W) return;
  charts.set(fig, { width: W });
  const { opts, rows } = optsAndRows(fig.querySelector('.mb-csrc')!.textContent ?? '', CHART_KEYS);
  const [head, ...data] = rows;
  const type = (opts.type ?? 'bar').toLowerCase().replace('pie', 'donut');
  const unit = opts.unit ?? (data.some((r) => /^\s*[-−]?\$/.test(r[1] ?? '')) ? '$' : data.some((r) => /%\s*$/.test(r[1] ?? '')) ? '%' : '');
  const xs = data.map((r) => r[0]);
  const series: Series[] = head.slice(1).map((name, i) => ({ name, color: seriesColor(name, i), values: data.map((r) => num(r[i + 1])) }));
  const cs = getComputedStyle(fig);
  const font = `${cs.getPropertyValue('--type-chrome-xs').trim() || '11px'} ${cs.getPropertyValue('--font-chrome').trim()}`;
  fig.querySelector('.mb-legend')!.innerHTML = series.length > 1 || type === 'donut'
    ? (type === 'donut' ? xs.map((x, i) => [x, seriesColor(x, i)]) : series.map((s) => [s.name, s.color])).map(([n, c]) => `<span><i style="background:${c}"></i>${inline(n)}</span>`).join('') : '';
  if (type === 'donut') return donut(fig, plot, W, xs, series[0], unit);
  if (type === 'radar') return radar(plot, W, xs, series, unit, opts, font);
  if (type === 'radial') { fig.querySelector('.mb-legend')!.innerHTML = ''; return radial(plot, W, xs, series[0], unit, opts); }
  if (type === 'scatter') return scatter(fig, plot, W, head, data, unit, opts, font);
  if (type === 'hbar' || (type === 'bar' && /^(yes|true|1)$/i.test(opts.horizontal ?? ''))) return hbar(plot, W, xs, series, unit, opts, font);
  const stacked = /^(yes|true|1)$/i.test(opts.stacked ?? '') && type !== 'line';
  let lo = Infinity, hi = -Infinity;
  data.forEach((_: string[], j: number) => {
    if (stacked) { let pos = 0, neg = 0; for (const s of series) { const v = s.values[j] ?? 0; if (v >= 0) pos += v; else neg += v; } hi = Math.max(hi, pos); lo = Math.min(lo, neg); }
    else for (const s of series) if (s.values[j] != null) { hi = Math.max(hi, s.values[j]); lo = Math.min(lo, s.values[j]); }
  });
  if (!Number.isFinite(lo)) { plot.innerHTML = '<p class="muted">No numbers to draw.</p>'; return; }
  if (type !== 'line' || (lo >= 0 && lo < hi * 0.5)) lo = Math.min(0, lo);
  if (opts.min != null && num(opts.min) != null) lo = num(opts.min)!;
  if (opts.max != null && num(opts.max) != null) hi = num(opts.max)!;
  if (hi === lo) hi = lo + 1;
  const H = Math.round(num(opts.height) ?? Math.min(300, Math.max(180, W * 0.42)));
  const step = niceStep(hi - lo, Math.max(3, Math.floor(H / 48)));
  const y0 = Math.floor(lo / step) * step, y1 = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = y0; v <= y1 + step / 2; v += step) ticks.push(+v.toPrecision(12));
  const tickLabels = ticks.map((v) => fmt(v, unit, step));
  const left = Math.ceil(Math.max(...tickLabels.map((t) => textWidth(t, font)))) + 10 + (opts.y ? 16 : 0);
  const top = 8, bottom = 22 + (opts.x ? 16 : 0), right = 8;
  const pw = W - left - right, ph = H - top - bottom;
  const Y = (v: number) => top + ph - ((v - y0) / (y1 - y0)) * ph;
  const n = xs.length, band = pw / n;
  const X = (j: number) => (type === 'bar' ? left + band * (j + 0.5) : left + (n === 1 ? pw / 2 : (pw * j) / (n - 1)));
  const maxLabel = Math.max(...xs.map((x) => textWidth(x, font)));
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / (maxLabel + 12)))));
  let svg = '';
  for (let i = 0; i < ticks.length; i++) svg += `<line class="${ticks[i] === 0 ? 'zero' : 'grid'}" x1="${left}" x2="${W - right}" y1="${Math.round(Y(ticks[i])) + 0.5}" y2="${Math.round(Y(ticks[i])) + 0.5}"/><text class="ytick" x="${left - 6 - (opts.y ? 0 : 0)}" y="${Y(ticks[i])}" dy="0.32em" text-anchor="end">${esc(tickLabels[i])}</text>`;
  xs.forEach((x, j) => { if (j % every === 0 || (type !== 'bar' && j === n - 1 && (n - 1) % every > every / 2)) svg += `<text class="xtick" x="${X(j)}" y="${top + ph + 15}" text-anchor="${type !== 'bar' && j === 0 && n > 1 ? 'start' : type !== 'bar' && j === n - 1 && n > 1 ? 'end' : 'middle'}">${esc(x)}</text>`; });
  if (opts.y) svg += `<text class="axis" transform="translate(10 ${top + ph / 2}) rotate(-90)" text-anchor="middle">${esc(opts.y)}</text>`;
  if (opts.x) svg += `<text class="axis" x="${left + pw / 2}" y="${H - 3}" text-anchor="middle">${esc(opts.x)}</text>`;
  if (type === 'bar') {
    const gw = band * Math.min(0.8, 0.5 + 0.1 * series.length), bw = stacked ? gw : gw / series.length;
    data.forEach((_, j) => {
      let pos = 0, neg = 0;
      series.forEach((s, k) => {
        const v = s.values[j];
        if (v == null) return;
        let a: number, b: number, x: number;
        if (stacked) { const base = v >= 0 ? pos : neg; a = Y(base); b = Y(base + v); if (v >= 0) pos += v; else neg += v; x = left + band * j + (band - gw) / 2; }
        else { a = Y(Math.max(y0, Math.min(0, y1))); b = Y(v); x = left + band * j + (band - gw) / 2 + bw * k; }
        const y = Math.min(a, b), h = Math.max(1, Math.abs(b - a));
        svg += `<rect x="${x + (stacked || series.length === 1 ? 0 : 0.5)}" y="${y}" width="${Math.max(1, bw - (stacked || series.length === 1 ? 0 : 1))}" height="${h}" rx="1" style="fill:${s.color}"/>`;
      });
    });
  } else {
    const acc = data.map(() => 0);
    series.forEach((s) => {
      const pts: ([number, number, number] | null)[] = [];
      s.values.forEach((v, j) => { if (v == null) { pts.push(null); return; } const base = stacked ? acc[j] : 0; pts.push([X(j), Y(base + v), Y(base)]); if (stacked) acc[j] += v; });
      const segs: [number, number, number][][] = [];
      let cur: [number, number, number][] = [];
      for (const p of pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } }
      if (cur.length) segs.push(cur);
      for (const seg of segs) {
        if (type === 'area') svg += `<path class="area" d="M${seg.map((p) => `${p[0]},${p[1]}`).join('L')}L${[...seg].reverse().map((p) => `${p[0]},${p[2]}`).join('L')}Z" style="fill:${s.color}"/>`;
        svg += `<polyline class="line" points="${seg.map((p) => `${p[0]},${p[1]}`).join(' ')}" style="stroke:${s.color}"/>`;
        if (n <= 24 || seg.length === 1) svg += seg.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" style="fill:${s.color}"/>`).join('');
      }
    });
  }
  // The hover guide sits behind the marks: a hairline for lines, the whole band for bars.
  svg = `<line class="guide" x1="0" x2="0" y1="${top}" y2="${top + ph}" visibility="hidden"/>` + svg + `<rect class="hit" x="${left}" y="${top}" width="${pw}" height="${ph}"/>`;
  plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title ?? 'Chart')}">${svg}</svg><div class="mb-tip" hidden></div>`;
  const hit = plot.querySelector('.hit')!, guide = plot.querySelector('.guide')!, tip = plot.querySelector<HTMLElement>('.mb-tip')!;
  const show = (e: PointerEvent) => {
    const r = plot.getBoundingClientRect();
    const px = e.clientX - r.left;
    const j = Math.max(0, Math.min(n - 1, type === 'bar' ? Math.floor((px - left) / band) : Math.round(((px - left) / (pw || 1)) * (n - 1))));
    guide.setAttribute('x1', String(X(j))); guide.setAttribute('x2', String(X(j))); guide.setAttribute('visibility', 'visible');
    if (type === 'bar') { guide.classList.add('band'); guide.setAttribute('stroke-width', String(band)); } else guide.classList.remove('band');
    tip.innerHTML = `<div class="mb-tx">${esc(xs[j])}</div>${series.map((s) => `<div><i style="background:${s.color}"></i><span>${esc(s.name)}</span><b>${s.values[j] == null ? '–' : esc(fmt(s.values[j], unit))}</b></div>`).join('')}`;
    tip.hidden = false;
    const tx = X(j) + 12 + tip.offsetWidth > W ? X(j) - 12 - tip.offsetWidth : X(j) + 12;
    tip.style.left = Math.max(0, tx) + 'px';
    tip.style.top = top + 'px';
  };
  hit.addEventListener('pointermove', show as EventListener);
  hit.addEventListener('pointerdown', show as EventListener);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; guide.setAttribute('visibility', 'hidden'); });
}
// Shared by the charts below: nice ticks over [lo, hi], and a hover readout in the plot.
function scale(lo: number, hi: number, count: number): { a: number; b: number; step: number; ticks: number[] } {
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo, count), a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(+v.toPrecision(12));
  return { a, b, step, ticks };
}
function tipAt(plot: HTMLElement, x: number, y: number, html: string): void {
  const tip = plot.querySelector<HTMLElement>('.mb-tip')!;
  tip.innerHTML = html;
  tip.hidden = false;
  const W = plot.clientWidth;
  tip.style.left = Math.max(0, x + 12 + tip.offsetWidth > W ? x - 12 - tip.offsetWidth : x + 12) + 'px';
  tip.style.top = Math.max(0, y - tip.offsetHeight / 2) + 'px';
}
const tipRows = (title: string, rows: [string, string, number | null][], unit: string): string => `<div class="mb-tx">${esc(title)}</div>${rows.map(([name, color, v]) => `<div><i style="background:${color}"></i><span>${esc(name)}</span><b>${v == null ? '–' : esc(fmt(v, unit))}</b></div>`).join('')}`;

// Bars lying on their side: categories down the left, values along the bottom.
function hbar(plot: HTMLElement, W: number, xs: string[], series: Series[], unit: string, opts: Opts, font: string): void {
  const stacked = /^(yes|true|1)$/i.test(opts.stacked ?? '');
  let lo = 0, hi = -Infinity;
  xs.forEach((_x, j) => {
    if (stacked) { let pos = 0, neg = 0; for (const s of series) { const v = s.values[j] ?? 0; if (v >= 0) pos += v; else neg += v; } hi = Math.max(hi, pos); lo = Math.min(lo, neg); }
    else for (const s of series) if (s.values[j] != null) { hi = Math.max(hi, s.values[j]); lo = Math.min(lo, s.values[j]); }
  });
  if (!Number.isFinite(hi)) { plot.innerHTML = '<p class="muted">No numbers to draw.</p>'; return; }
  const left = Math.min(W * 0.35, Math.ceil(Math.max(...xs.map((x) => textWidth(x, font)))) + 10), right = 12, top = 4, bottom = 22 + (opts.x ? 16 : 0);
  const pw = W - left - right, n = xs.length, rowH = stacked || series.length === 1 ? 22 : Math.max(22, series.length * 9 + 8);
  const ph = n * rowH, H = top + ph + bottom;
  const sc = scale(lo, hi, Math.max(3, Math.floor(pw / 90)));
  const X = (v: number) => left + ((v - sc.a) / (sc.b - sc.a)) * pw;
  let svg = `<rect class="hband" x="${left}" y="0" width="${pw}" height="${rowH}" visibility="hidden"/>`;
  for (const t of sc.ticks) svg += `<line class="${t === 0 ? 'zero' : 'grid'}" x1="${Math.round(X(t)) + 0.5}" x2="${Math.round(X(t)) + 0.5}" y1="${top}" y2="${top + ph}"/><text class="xtick" x="${X(t)}" y="${top + ph + 15}" text-anchor="middle">${esc(fmt(t, unit, sc.step))}</text>`;
  if (opts.x) svg += `<text class="axis" x="${left + pw / 2}" y="${H - 3}" text-anchor="middle">${esc(opts.x)}</text>`;
  xs.forEach((x, j) => {
    const y0 = top + j * rowH;
    const label = textWidth(x, font) > left - 10 ? x.slice(0, Math.max(3, Math.floor(x.length * (left - 16) / textWidth(x, font)))) + '…' : x;
    svg += `<text class="ytick" x="${left - 6}" y="${y0 + rowH / 2}" dy="0.32em" text-anchor="end">${esc(label)}</text>`;
    const gh = rowH * 0.7, bh = stacked ? gh : gh / series.length;
    let pos = 0, neg = 0;
    series.forEach((s, k) => {
      const v = s.values[j];
      if (v == null) return;
      let a: number, b: number, y: number;
      if (stacked) { const base = v >= 0 ? pos : neg; a = X(base); b = X(base + v); if (v >= 0) pos += v; else neg += v; y = y0 + (rowH - gh) / 2; }
      else { a = X(0); b = X(v); y = y0 + (rowH - gh) / 2 + bh * k; }
      svg += `<rect x="${Math.min(a, b)}" y="${y + (stacked || series.length === 1 ? 0 : 0.5)}" width="${Math.max(1, Math.abs(b - a))}" height="${Math.max(1, bh - (stacked || series.length === 1 ? 0 : 1))}" rx="1" style="fill:${s.color}"/>`;
    });
  });
  svg += `<rect class="hit" x="${left}" y="${top}" width="${pw}" height="${ph}"/>`;
  plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title ?? 'Chart')}">${svg}</svg><div class="mb-tip" hidden></div>`;
  const hit = plot.querySelector('.hit')!, band = plot.querySelector('.hband')!;
  const show = (e: PointerEvent) => {
    const r = plot.getBoundingClientRect(), j = Math.max(0, Math.min(n - 1, Math.floor((e.clientY - r.top - top) / rowH)));
    band.setAttribute('y', String(top + j * rowH)); band.setAttribute('visibility', 'visible');
    tipAt(plot, e.clientX - r.left, top + j * rowH + rowH / 2, tipRows(xs[j], series.map((s) => [s.name, s.color, s.values[j]]), unit));
  };
  hit.addEventListener('pointermove', show as EventListener);
  hit.addEventListener('pointerdown', show as EventListener);
  hit.addEventListener('pointerleave', () => { plot.querySelector<HTMLElement>('.mb-tip')!.hidden = true; band.setAttribute('visibility', 'hidden'); });
}

// Points on two numeric axes. "x, A, B" draws a series per column against x; "label, x, y"
// draws one series of named points.
function scatter(fig: HTMLElement, plot: HTMLElement, W: number, head: string[], data: string[][], unit: string, opts: Opts, font: string): void {
  interface Pt { x: number; y: number; label: string }
  interface PtSet { name: string; color: string; pts: Pt[] }
  const firstNumeric = data.filter((r) => num(r[0]) != null).length >= data.length * 0.8;
  const valid = (p: { x: number | null; y: number | null; label: string }): p is Pt => p.x != null && p.y != null;
  let sets: PtSet[];
  if (firstNumeric) sets = head.slice(1).map((name, i) => ({ name, color: seriesColor(name, i), pts: data.map((r) => ({ x: num(r[0]), y: num(r[i + 1]), label: '' })).filter(valid) }));
  else sets = [{ name: head[2] ?? 'value', color: seriesColor(head[2] ?? '', 0), pts: data.map((r) => ({ x: num(r[1]), y: num(r[2]), label: r[0] })).filter(valid) }];
  fig.querySelector('.mb-legend')!.innerHTML = sets.length > 1 ? sets.map((s) => `<span><i style="background:${s.color}"></i>${inline(s.name)}</span>`).join('') : '';
  const all = sets.flatMap((s) => s.pts);
  if (!all.length) { plot.innerHTML = '<p class="muted">No numbers to draw.</p>'; return; }
  const H = Math.round(num(opts.height) ?? Math.min(320, Math.max(200, W * 0.5)));
  const sy = scale(Math.min(...all.map((p) => p.y)), Math.max(...all.map((p) => p.y)), Math.max(3, Math.floor(H / 50)));
  const yl = sy.ticks.map((t) => fmt(t, unit, sy.step));
  const left = Math.ceil(Math.max(...yl.map((t) => textWidth(t, font)))) + 10 + (opts.y ? 16 : 0), top = 8, right = 12, bottom = 22 + (opts.x ? 16 : 0);
  const pw = W - left - right, ph = H - top - bottom;
  const sx = scale(Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.x)), Math.max(3, Math.floor(pw / 80)));
  const X = (v: number) => left + ((v - sx.a) / (sx.b - sx.a)) * pw, Y = (v: number) => top + ph - ((v - sy.a) / (sy.b - sy.a)) * ph;
  let svg = '';
  sy.ticks.forEach((t, i) => { svg += `<line class="${t === 0 ? 'zero' : 'grid'}" x1="${left}" x2="${W - right}" y1="${Math.round(Y(t)) + 0.5}" y2="${Math.round(Y(t)) + 0.5}"/><text class="ytick" x="${left - 6}" y="${Y(t)}" dy="0.32em" text-anchor="end">${esc(yl[i])}</text>`; });
  for (const t of sx.ticks) svg += `<line class="grid" x1="${Math.round(X(t)) + 0.5}" x2="${Math.round(X(t)) + 0.5}" y1="${top}" y2="${top + ph}"/><text class="xtick" x="${X(t)}" y="${top + ph + 15}" text-anchor="middle">${esc(fmt(t, '', sx.step))}</text>`;
  if (opts.y) svg += `<text class="axis" transform="translate(10 ${top + ph / 2}) rotate(-90)" text-anchor="middle">${esc(opts.y)}</text>`;
  if (opts.x) svg += `<text class="axis" x="${left + pw / 2}" y="${H - 3}" text-anchor="middle">${esc(opts.x)}</text>`;
  for (const s of sets) for (const p of s.pts) svg += `<circle class="pt" cx="${X(p.x)}" cy="${Y(p.y)}" r="3.5" style="fill:${s.color}"/>`;
  svg += `<circle class="ring" r="6" visibility="hidden"/><rect class="hit" x="${left}" y="${top}" width="${pw}" height="${ph}"/>`;
  plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title ?? 'Chart')}">${svg}</svg><div class="mb-tip" hidden></div>`;
  const hit = plot.querySelector('.hit')!, ring = plot.querySelector<SVGElement>('.ring')!, tip = plot.querySelector<HTMLElement>('.mb-tip')!;
  const flat = sets.flatMap((s) => s.pts.map((p) => ({ ...p, s, px: X(p.x), py: Y(p.y) })));
  const show = (e: PointerEvent) => {
    const r = plot.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best: (typeof flat)[number] | null = null, bd = 24 * 24;
    for (const p of flat) { const d = (p.px - mx) ** 2 + (p.py - my) ** 2; if (d < bd) { bd = d; best = p; } }
    if (!best) { tip.hidden = true; ring.setAttribute('visibility', 'hidden'); return; }
    ring.setAttribute('cx', String(best.px)); ring.setAttribute('cy', String(best.py)); ring.setAttribute('visibility', 'visible'); ring.style.stroke = best.s.color;
    tipAt(plot, best.px, best.py, `<div class="mb-tx">${esc(best.label || best.s.name)}</div><div><span>${esc(opts.x ?? head[firstNumeric ? 0 : 1])}</span><b>${esc(fmt(best.x, ''))}</b></div><div><span>${esc(opts.y ?? (firstNumeric ? best.s.name : head[2]))}</span><b>${esc(fmt(best.y, unit))}</b></div>`);
  };
  hit.addEventListener('pointermove', show as EventListener);
  hit.addEventListener('pointerdown', show as EventListener);
  hit.addEventListener('pointerleave', () => { tip.hidden = true; ring.setAttribute('visibility', 'hidden'); });
}

// One spoke per category, one polygon per series.
function radar(plot: HTMLElement, W: number, xs: string[], series: Series[], unit: string, opts: Opts, font: string): void {
  const n = xs.length;
  if (n < 3) { plot.innerHTML = '<p class="muted">A radar chart needs at least three categories.</p>'; return; }
  const vals = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const sc = scale(0, num(opts.max) ?? Math.max(...vals, 0), 4);
  const lab = Math.ceil(Math.max(...xs.map((x) => textWidth(x, font))));
  const size = Math.min(W, 460), R = Math.max(40, size / 2 - Math.min(lab, size / 4) - 10), cx = W / 2, cy = R + 24, H = cy + R + 24;
  const P = (i: number, v: number): [number, number] => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n, r = (Math.max(0, v) / sc.b) * R; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  let svg = '';
  for (const t of sc.ticks.slice(1)) svg += `<polygon class="ring-grid" points="${xs.map((_, i) => P(i, t).join(',')).join(' ')}"/><text class="ytick" x="${cx + 3}" y="${cy - (t / sc.b) * R}" dy="-0.2em">${esc(fmt(t, unit, sc.step))}</text>`;
  xs.forEach((x, i) => {
    const [ex, ey] = P(i, sc.b), [lx, ly] = P(i, sc.b * 1.08);
    const anchor = Math.abs(lx - cx) < 4 ? 'middle' : lx > cx ? 'start' : 'end';
    svg += `<line class="grid" x1="${cx}" y1="${cy}" x2="${ex}" y2="${ey}"/><text class="xtick" x="${lx}" y="${ly}" dy="0.32em" text-anchor="${anchor}">${esc(x)}</text>`;
  });
  for (const s of series) {
    const pts = s.values.map((v, i) => P(i, v ?? 0));
    svg += `<polygon class="radar" points="${pts.map((p) => p.join(',')).join(' ')}" style="fill:${s.color};stroke:${s.color}"/>`;
    svg += pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.5" style="fill:${s.color}"><title>${esc(`${s.name} · ${xs[i]}: ${s.values[i] == null ? '–' : fmt(s.values[i], unit)}`)}</title></circle>`).join('');
  }
  plot.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title ?? 'Chart')}">${svg}</svg>`;
}

// Concentric arcs, one per category, each a share of the max (100 for percentages).
function radial(plot: HTMLElement, W: number, xs: string[], s: Series, unit: string, opts: Opts): void {
  const vals = s.values.map((v) => Math.max(0, v ?? 0));
  const max = (num(opts.max) ?? (unit === '%' ? 100 : Math.max(...vals, 0))) || 1;
  const size = Math.min(W, 240), c = size / 2, n = xs.length, R = c - 2;
  const t = Math.max(6, Math.min(16, (R * 0.75) / n - 4)), gap = Math.max(2, t * 0.3);
  let svg = '';
  xs.forEach((x, i) => {
    const r = R - t / 2 - i * (t + gap);
    if (r <= t) return;
    const frac = Math.min(1, vals[i] / max), a0 = -Math.PI / 2, a1 = a0 + frac * 2 * Math.PI * 0.999;
    const p = (a: number) => `${c + r * Math.cos(a)},${c + r * Math.sin(a)}`;
    svg += `<circle cx="${c}" cy="${c}" r="${r}" class="track" style="stroke-width:${t}px"/>`;
    if (frac > 0) svg += `<path d="M${p(a0)}A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}" style="fill:none;stroke:${seriesColor(x, i)};stroke-width:${t}px;stroke-linecap:round"><title>${esc(`${x}: ${fmt(s.values[i] ?? 0, unit)}`)}</title></path>`;
  });
  plot.innerHTML = `<div class="mb-donut"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(opts.title ?? s.name)}">${svg}</svg>
    <table class="mb-dtable">${xs.map((x, i) => `<tr><td><i style="background:${seriesColor(x, i)}"></i>${inline(x)}</td><td class="mb-num">${esc(s.values[i] == null ? '–' : fmt(s.values[i], unit))}</td><td class="mb-num muted">${Math.round((vals[i] / max) * 100)}%</td></tr>`).join('')}</table></div>`;
}

function donut(fig: HTMLElement, plot: HTMLElement, W: number, xs: string[], s: Series, unit: string): void {
  const vals = s.values.map((v) => Math.max(0, v ?? 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) { plot.innerHTML = '<p class="muted">No numbers to draw.</p>'; return; }
  const size = Math.min(W, 220), r = size / 2 - 2, ri = r * 0.62, c = size / 2;
  let a = -Math.PI / 2, svg = '';
  vals.forEach((v, i) => {
    if (!v) return;
    const b = a + (v / total) * Math.PI * 2;
    const large = b - a > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number) => `${c + rad * Math.cos(ang)},${c + rad * Math.sin(ang)}`;
    svg += v === total
      ? `<circle cx="${c}" cy="${c}" r="${(r + ri) / 2}" style="fill:none;stroke:${seriesColor(xs[i], i)};stroke-width:${r - ri}px"/>`
      : `<path d="M${p(a, r)}A${r},${r} 0 ${large} 1 ${p(b, r)}L${p(b, ri)}A${ri},${ri} 0 ${large} 0 ${p(a, ri)}Z" style="fill:${seriesColor(xs[i], i)}" data-i="${i}"/>`;
    a = b;
  });
  svg += `<text class="dtotal" x="${c}" y="${c}" dy="0.32em" text-anchor="middle">${esc(fmt(total, unit))}</text>`;
  plot.innerHTML = `<div class="mb-donut"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(s.name)}">${svg}</svg>
    <table class="mb-dtable">${xs.map((x, i) => `<tr><td><i style="background:${seriesColor(x, i)}"></i>${inline(x)}</td><td class="mb-num">${esc(s.values[i] == null ? '–' : fmt(s.values[i], unit))}</td><td class="mb-num muted">${Math.round((vals[i] / total) * 100)}%</td></tr>`).join('')}</table></div>`;
  fig.querySelector('.mb-legend')!.innerHTML = '';
}

// --- Embeds -------------------------------------------------------------------------
// A video or page from the web (YouTube, Vimeo, Loom, Google Docs, Figma), a media file by
// URL, or a file from the sender's machine, which their daemon attaches ("attachment: NAME").
// A YouTube, Vimeo, or Loom link alone on its line embeds too.
const MEDIA: Record<string, RegExp> = { image: /\.(png|jpe?g|gif|webp|svg)$/i, video: /\.(mp4|webm|mov|m4v)$/i, audio: /\.(mp3|wav|ogg|m4a)$/i, pdf: /\.pdf$/i, text: /\.(txt|md|log|json|ya?ml|toml|csv|tsv|ts|js|mjs|py|sh|rs|go|css|html|sql|diff|patch)$/i };
export interface Embed { kind: string; src: string; site: string; ratio?: string }
export function embedUrl(u: string): Embed | null {
  let m: URL;
  try { m = new URL(u); } catch { return null; }
  // Only web URLs embed or link: a javascript: or data: URL would be a live href (S-1529).
  if (m.protocol !== 'http:' && m.protocol !== 'https:') return null;
  const h = m.hostname.replace(/^www\.|^m\./, '');
  let id: string | null | undefined, gd: RegExpMatchArray | null;
  if (h === 'youtu.be') id = m.pathname.slice(1);
  else if (h === 'youtube.com' || h === 'youtube-nocookie.com') id = m.searchParams.get('v') ?? m.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
  if (id) return { kind: 'frame', src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}${m.searchParams.get('t') ? `?start=${parseInt(m.searchParams.get('t')!)}` : ''}`, ratio: '16 / 9', site: 'YouTube' };
  if (h === 'vimeo.com' && (id = m.pathname.match(/^\/(\d+)/)?.[1])) return { kind: 'frame', src: `https://player.vimeo.com/video/${id}`, ratio: '16 / 9', site: 'Vimeo' };
  if (h === 'loom.com' && (id = m.pathname.match(/^\/(?:share|embed)\/(\w+)/)?.[1])) return { kind: 'frame', src: `https://www.loom.com/embed/${id}`, ratio: '16 / 9', site: 'Loom' };
  if (h === 'docs.google.com' && (gd = m.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([\w-]+)/))) return { kind: 'frame', src: `https://docs.google.com/${gd[1]}/d/${gd[2]}/preview`, ratio: gd[1] === 'presentation' ? '16 / 9' : '4 / 5', site: 'Google Docs' };
  if (h === 'drive.google.com' && (id = m.pathname.match(/^\/file\/d\/([\w-]+)/)?.[1])) return { kind: 'frame', src: `https://drive.google.com/file/d/${id}/preview`, ratio: '16 / 9', site: 'Google Drive' };
  if (h === 'figma.com' && /^\/(file|design|proto|board)\//.test(m.pathname)) return { kind: 'frame', src: `https://www.figma.com/embed?embed_host=stam&url=${encodeURIComponent(u)}`, ratio: '16 / 10', site: 'Figma' };
  for (const k of ['image', 'video', 'audio', 'pdf']) if (MEDIA[k].test(m.pathname)) return { kind: k, src: u, site: h };
  return { kind: 'link', src: u, site: h };
}
function embed(text: string): string | false {
  const lines = text.replace(/\n$/, '').split('\n');
  const first = lines[0].trim(), caption = lines.slice(1).join(' ').trim();
  const att = first.match(/^attachment:\s*(.+)$/)?.[1];
  const cap = caption ? `<figcaption>${inline(caption)}</figcaption>` : '';
  if (att) {
    const k = Object.keys(MEDIA).find((x) => MEDIA[x].test(att)) ?? 'file';
    return `<figure class="mb-embed ${k}" data-att-embed="${esc(att)}" data-kind="${k}"><div class="mb-eslot"></div>${cap}</figure>`;
  }
  if (/^(\/|~\/)/.test(first)) return `<figure class="mb-embed file missing"><div class="mb-efile">${icon('file-text', 'xs')}<span class="mono">${esc(first)}</span><span class="muted">is on the sender's machine and wasn't attached.</span></div>${cap}</figure>`;
  const e = embedUrl(first);
  if (!e) return false;
  return embedHtml(e, cap);
}
function embedHtml(e: Embed, cap = ''): string {
  const src = esc(e.src);
  if (e.kind === 'frame') return `<figure class="mb-embed frame" data-frame="${src}" data-ratio="${esc(e.ratio)}" data-site="${esc(e.site)}"><div class="mb-eslot" style="aspect-ratio:${esc(e.ratio)}"></div><div class="mb-esite">${icon('link', 'xs')}<a href="${src}">${esc(e.site)}</a></div>${cap}</figure>`;
  if (e.kind === 'image') return `<figure class="mb-embed image"><img src="${src}" alt="">${cap}</figure>`;
  if (e.kind === 'video') return `<figure class="mb-embed video"><video controls preload="metadata" src="${src}"></video>${cap}</figure>`;
  if (e.kind === 'audio') return `<figure class="mb-embed audio"><audio controls preload="metadata" src="${src}"></audio>${cap}</figure>`;
  if (e.kind === 'pdf') return `<figure class="mb-embed frame" data-frame="${src}" data-ratio="4 / 5" data-site="PDF"><div class="mb-eslot" style="aspect-ratio:4 / 5"></div>${cap}</figure>`;
  return `<figure class="mb-embed link"><a class="mb-elink" href="${src}">${icon('link', 'xs')}<span>${esc(e.site)}</span><span class="muted">${esc(e.src.replace(/^https?:\/\/[^/]+/, '').slice(0, 80))}</span></a>${cap}</figure>`;
}
// Builds iframes and points attached media at their files, through attUrl(name) (a URL
// that carries the token, since players can't send a header). Iframes are built here,
// after sanitizing, from allowlisted sites only.
export function resolveEmbeds(el: ParentNode, attUrl: (name: string) => string | null | undefined, fetchText: (url: string) => Promise<string>, plainUrl: (name: string) => string = () => '#'): void {
  for (const f of el.querySelectorAll<HTMLElement>('.mb-embed[data-frame]:not(.ready)')) {
    f.classList.add('ready');
    // A PDF is never put in an iframe (S-1529): an attached one opens the file view, a linked one opens its own page.
    if (f.dataset.site === 'PDF') {
      const slot = f.querySelector<HTMLElement>('.mb-eslot')!;
      slot.style.aspectRatio = '';
      slot.innerHTML = `<div class="mb-efile">${icon('file-text', 'xs')}<span class="mono">${esc(f.dataset.frame!.replace(/^https?:\/\/[^/]+/, '').slice(0, 80) || 'PDF')}</span><a href="${esc(f.dataset.frame!)}" target="_blank" rel="noopener">Open PDF</a></div>`;
      continue;
    }
    const fr = document.createElement('iframe');
    fr.src = f.dataset.frame!;
    fr.loading = 'lazy';
    fr.allow = 'fullscreen; picture-in-picture; encrypted-media; clipboard-write';
    fr.referrerPolicy = 'strict-origin-when-cross-origin';
    fr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups');
    fr.title = f.dataset.site!;
    f.querySelector('.mb-eslot')!.append(fr);
  }
  for (const f of el.querySelectorAll<HTMLElement>('.mb-embed[data-att-embed]:not(.ready)')) {
    f.classList.add('ready');
    const name = f.dataset.attEmbed!, url = attUrl(name), slot = f.querySelector<HTMLElement>('.mb-eslot')!;
    if (!url) { slot.innerHTML = `<div class="mb-efile">${icon('file-text', 'xs')}<span class="mono">${esc(name)}</span><span class="muted">isn't attached.</span></div>`; continue; }
    const k = f.dataset.kind;
    if (k === 'image') slot.innerHTML = `<img src="${esc(url)}" alt="${esc(name)}">`;
    else if (k === 'video') slot.innerHTML = `<video controls preload="metadata" src="${esc(url)}"></video>`;
    else if (k === 'audio') slot.innerHTML = `<audio controls preload="metadata" src="${esc(url)}"></audio>`;
    // A PDF is a card that opens the file view's PDF viewer (S-1529), not an iframe; the thread panel wires the click.
    else if (k === 'pdf') slot.innerHTML = `<div class="mb-efile">${icon('file-text', 'xs')}<span class="mono">${esc(name)}</span><a href="${esc(plainUrl(name))}" data-att-open="${esc(name)}">Open PDF</a><a href="${esc(plainUrl(name))}" data-att-save="${esc(name)}">Download</a></div>`;
    else if (k === 'text') {
      slot.innerHTML = `<div class="mb-efile">${icon('file-text', 'xs')}<span class="mono">${esc(name)}</span><a href="${esc(plainUrl(name))}" data-att-save="${esc(name)}">Download</a></div><div class="mb-code"><pre><code></code></pre></div>`;
      fetchText(url).then((t) => {
        const lines = t.split('\n');
        const code = slot.querySelector('code')!;
        code.textContent = lines.slice(0, 200).join('\n') + (lines.length > 200 ? `\n… ${lines.length - 200} more lines` : '');
        const ext = name.split('.').pop()!.toLowerCase();
        code.className = 'language-' + (({ md: 'markdown', yml: 'yaml', mjs: 'javascript', sh: 'bash', ts: 'typescript', js: 'javascript', py: 'python', rs: 'rust' } as Record<string, string>)[ext] ?? ext);
        slot.querySelector('.mb-code')!.insertAdjacentHTML('beforeend', `<button class="mb-copy" data-copy type="button" title="Copy">${icon('copy', 'xs')}</button>`);
        highlight(slot);
      }).catch(() => {});
    } else slot.innerHTML = `<div class="mb-efile">${icon('file-text', 'xs')}<span class="mono">${esc(name)}</span><a href="${esc(plainUrl(name))}" data-att-save="${esc(name)}">Download</a></div>`;
  }
}

// --- Math ---------------------------------------------------------------------------
// ```math blocks, $$…$$ on its own lines, and \(…\) inline, typeset by KaTeX on first use.
// A single $ stays a dollar sign: mail is full of prices.
const mathBlock = (tex: string): string => `<div class="mb-math display" data-tex="${esc(tex.trim())}"><code>${esc(tex.trim())}</code></div>`;
const MATH_EXT: { extensions: TokenizerAndRendererExtension[] } = {
  extensions: [
    { name: 'mathBlock', level: 'block', start: (src: string) => src.match(/^\$\$/m)?.index,
      tokenizer(src: string) { const m = /^\$\$\n?([\s\S]+?)\n?\$\$(?:\n|$)/.exec(src); if (m) return { type: 'mathBlock', raw: m[0], tex: m[1] }; },
      renderer: (t) => mathBlock(t.tex as string) },
    { name: 'mathInline', level: 'inline', start: (src: string) => src.indexOf('\\('),
      tokenizer(src: string) { const m = /^\\\(([\s\S]+?)\\\)/.exec(src); if (m) return { type: 'mathInline', raw: m[0], tex: m[1] }; },
      renderer: (t) => `<span class="mb-math" data-tex="${esc((t.tex as string).trim())}"><code>${esc((t.tex as string).trim())}</code></span>` },
  ],
};
type KatexApi = typeof import('katex');
let katex: KatexApi | null = null;
export async function renderMath(el: ParentNode): Promise<void> {
  const todo = [...el.querySelectorAll<HTMLElement>('.mb-math:not(.typeset)')];
  if (!todo.length) return;
  if (!katex) {
    try {
      const [k] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
      katex = (k as unknown as { default: KatexApi }).default;
    } catch { return; }
  }
  for (const m of todo) {
    m.classList.add('typeset');
    try { katex.render(m.dataset.tex!, m, { displayMode: m.classList.contains('display'), throwOnError: true, output: 'htmlAndMathml' }); }
    catch (err) { m.classList.add('failed'); m.title = String(err instanceof Error ? err.message : err); }
  }
}

// --- Syntax highlighting ----------------------------------------------------------------
// Code blocks are coloured by highlight.js, loaded on first use, in stam's syntax tokens.
let hljs: HLJSApi | null = null;
export async function highlight(el: ParentNode): Promise<void> {
  const todo = [...el.querySelectorAll<HTMLElement>('.mb-code pre code:not(.hl)')].filter((c) => c.textContent?.trim() && !c.closest('.mb-term'));
  if (!todo.length) return;
  if (!hljs) {
    try { hljs = (await import('highlight.js/lib/common')).default; } catch { return; }
  }
  const hl = hljs;
  for (const c of todo) {
    c.classList.add('hl');
    const lang = [...c.classList].find((x) => x.startsWith('language-'))?.slice(9);
    try {
      const out = lang && hl.getLanguage(lang) ? hl.highlight(c.textContent!, { language: lang, ignoreIllegals: true }) : !lang && c.textContent!.split('\n').length >= 2 ? hl.highlightAuto(c.textContent!) : null;
      if (out && (lang || out.relevance >= 5)) c.innerHTML = out.value;
    } catch {}
  }
}

// --- Timeline -----------------------------------------------------------------------
// One event per line: "TIME — event" (or " | ", or the time then the event), optionally
// tagged [success], [warning], or [error].
function timeline(text: string): string | false {
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => {
    let tone = '';
    l = l.replace(/\s*\[(success|ok|good|warning|warn|error|bad|fail)\]/i, (_, t: string) => { tone = TONES[t.toLowerCase()]; return ''; }).replace(/^\s*[-*+]\s+/, '');
    let m = l.match(/^(.+?)\s+(?:—|\||–|-)\s+(.+)$/);
    if (!m) m = l.match(/^((?:\d{4}-\d\d-\d\d[ T]?)?(?:\d{1,2}:\d\d(?::\d\d)?(?:\s?[AP]M)?)?)\s+(.+)$/i);
    return m && m[1] ? { at: m[1].trim(), what: m[2].trim(), tone } : { at: '', what: l.trim(), tone };
  });
  if (!rows.length) return false;
  return `<ol class="mb-timeline">${rows.map((r) => `<li class="${r.tone}"><span class="mb-tat">${esc(r.at)}</span><span class="mb-tdot"></span><span class="mb-twhat">${inline(r.what)}</span></li>`).join('')}</ol>`;
}

// --- Rank ---------------------------------------------------------------------------
// Options in the order the agent suggests; the human reorders them by dragging or with the
// arrows, and the order is staged as the answer.
const RANKED = 'Ranked: ';
export const rankText = (labels: string[]): string => RANKED + labels.map((l, i) => `${i + 1}. **${l}**`).join(', ') + '.';
function rank(text: string, n: number): string | false {
  const { question, options } = parseDecision(text);
  if (options.length < 2) return false;
  return `<div class="mb-decision rank" data-decision="${n}">
    <div class="mb-label">${icon('list-checks', 'xs')}<span>Rank</span></div>
    ${question ? `<div class="mb-q">${inner(question)}</div>` : ''}
    <ol class="mb-ranks">${options.map((o) => `<li class="mb-rrow" data-rank="${esc(o.label)}" draggable="true">
      <span class="mb-rnum"></span><span class="mb-opt-text"><span class="mb-opt-label">${inline(o.label)}</span>${o.why ? `<span class="mb-why">${inline(o.why)}</span>` : ''}</span>
      <span class="mb-rmove"><button type="button" data-rank-move="-1" title="Move up" aria-label="Move up">${icon('chevron-down', 'xs')}</button><button type="button" data-rank-move="1" title="Move down" aria-label="Move down">${icon('chevron-down', 'xs')}</button></span></li>`).join('')}</ol>
    <div class="mb-foot"><span class="mb-status"></span><button class="mb-own" data-rank-keep type="button">Keep this order</button><button class="mb-own" data-own type="button">${icon('pencil', 'xs')}Add a note</button><button class="mb-own" data-defer="" type="button">${icon('clock', 'xs')}Decide later</button></div>
  </div>`;
}
export const rankOrder = (b: Element): string[] => [...b.querySelectorAll<HTMLElement>('.mb-rrow')].map((r) => r.dataset.rank!);
export function setRankOrder(b: Element, labels: string[]): void {
  const ol = b.querySelector('.mb-ranks')!;
  for (const l of labels) { const r = [...ol.children].find((x) => (x as HTMLElement).dataset.rank === l); if (r) ol.append(r); }
}

// --- Markdown -----------------------------------------------------------------------
let marker: Marked | null = null;
let decisions = 0;
function parser(): Marked {
  if (marker) return marker;
  marker = new Marked({ gfm: true, breaks: true });
  marker.use(MATH_EXT);
  marker.use({
    renderer: {
      code(token: Tokens.Code) {
        // One component that throws on odd content shows as plain code instead of taking its mail, view, or the app down (S-2084).
        try { return component(token); } catch (e) { console.error('mail component', token.lang, e); return false; }
      },
    },
  });
  return marker;
}
function component({ text, lang }: Tokens.Code): string | false {
  const name = String(lang ?? '').trim().toLowerCase();
  if (name === 'decision') return decision(text, decisions++);
  if (name === 'metrics') return metrics(text);
  if (name === 'diff' || name === 'patch') return diff(text);
  if (name === 'yesno' || name === 'question') return decision(text, decisions++);
  if (name === 'checklist' || name === 'status') return checklist(text);
  if (name === 'tests' || name === 'test') return tests(text);
  if (name === 'spend' || name === 'cost') return spend(text);
  if (name === 'error') return error(text);
  if (['terminal', 'console', 'shell-session', 'log', 'ansi'].includes(name)) return terminal(text);
  if (name === 'progress') return progress(text);
  if (name === 'pick' || name === 'multi' || name === 'choose') return decision(text, decisions++, true);
  if (name === 'compare' || name === 'before-after') return compare(text);
  if (name === 'pane' || name === 'terminal-link') return pane(text);
  if (name === 'mermaid' || name === 'diagram') return diagram(text);
  if (name === 'table' || name === 'csv' || name === 'tsv') return table(text);
  if (name === 'chart' || name === 'graph' || name === 'plot') return chart(text);
  if (name === 'rank') return rank(text, decisions++);
  if (name === 'timeline') return timeline(text);
  if (name === 'math' || name === 'latex' || name === 'tex') return mathBlock(text);
  if (['embed', 'video', 'audio', 'image', 'file'].includes(name)) return embed(text);
  return false;
}
const inner = (text: string): string => parser().parse(text) as string;
const inline = (text: string): string => parser().parseInline(text) as string;

// Callouts: GitHub alert syntax on a block quotation.
const CALLOUT: Record<string, string> = {
  note: 'note', info: 'note', tip: 'note', important: 'note',
  done: 'success', success: 'success',
  warning: 'warning', caution: 'warning',
  blocked: 'error', error: 'error', failed: 'error',
};
const CALLOUT_ICON: Record<string, string> = { note: 'info', success: 'circle-check', warning: 'triangle-alert', error: 'octagon-x' };
function callouts(root: ParentNode): void {
  for (const q of root.querySelectorAll('blockquote')) {
    const p = q.firstElementChild;
    const t = p?.firstChild;
    const m = t?.nodeType === 3 ? t.textContent!.match(/^\s*\[!(\w+)\]\s*/) : null;
    if (!t || !p || !m || !(m[1].toLowerCase() in CALLOUT)) continue;
    const tone = CALLOUT[m[1].toLowerCase()];
    t.textContent = t.textContent!.slice(m[0].length);
    if (!t.textContent && t.nextSibling?.nodeName === 'BR') t.nextSibling.remove();
    if (!t.textContent) t.remove();
    if (!p.childNodes.length) p.remove();
    const box = document.createElement('div');
    box.className = `mb-callout ${tone}`;
    box.innerHTML = `<div class="mb-label">${icon(CALLOUT_ICON[tone], 'xs')}<span>${esc(m[1][0].toUpperCase() + m[1].slice(1).toLowerCase())}</span></div><div class="mb-body"></div>`;
    (box.lastChild as HTMLElement).append(...q.childNodes);
    q.replaceWith(box);
  }
}
// Agent mentions: "@name" in running text, outside code and links.
function mentions(root: ParentNode): void {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('code, pre, a, button') ? NodeFilter.FILTER_REJECT : /@\w/.test(n.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const nodes: Text[] = [];
  while (walk.nextNode()) nodes.push(walk.currentNode as Text);
  for (const n of nodes) {
    const html = esc(n.textContent).replace(/(^|[\s(\[])@([A-Za-z0-9][\w.-]*[\w])/g, (all, pre, name) => {
      const h = mention(name);
      return h ? pre + h : all;
    });
    if (html === esc(n.textContent)) continue;
    const span = document.createElement('span');
    span.innerHTML = html;
    n.replaceWith(...span.childNodes);
  }
}
// ITSA links: a key such as S-12 in running text, outside code and links, opens that ITSA.
// A key no ITSA has stays plain text.
const ITSA_KEY = /(^|[^\w-])(S-\d+)(?![\w-])/g;
function itsaLinks(root: ParentNode): void {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('code, pre, a, button') ? NodeFilter.FILTER_REJECT : /S-\d/.test(n.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const nodes: Text[] = [];
  while (walk.nextNode()) nodes.push(walk.currentNode as Text);
  for (const n of nodes) {
    const html = esc(n.textContent).replace(ITSA_KEY, (all, pre, key) => {
      const h = itsaLink(key);
      return h ? pre + h : all;
    });
    if (html === esc(n.textContent)) continue;
    const span = document.createElement('span');
    span.innerHTML = html;
    n.replaceWith(...span.childNodes);
  }
}
// The same for a short inline HTML string, such as a thread's subject.
export function linkItsaKeys(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  itsaLinks(tpl.content);
  return tpl.innerHTML;
}
// Thread links: a mail id such as m3228ca5 in running text, or a link to "#m3228ca5",
// opens the thread that mail is in. The thread's subject fills in once it's fetched.
const MAIL_ID = /\bm[0-9a-f]{7}\b/;
function threadLinks(root: ParentNode): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="#m"]')) {
    const id = a.getAttribute('href')!.slice(1);
    if (!new RegExp(`^${MAIL_ID.source}$`).test(id)) continue;
    a.classList.add('threadlink');
    a.dataset.threadLink = id;
    a.dataset.keep = '1';
  }
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('code, pre, a, button') ? NodeFilter.FILTER_REJECT : MAIL_ID.test(n.textContent ?? '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const nodes: Text[] = [];
  while (walk.nextNode()) nodes.push(walk.currentNode as Text);
  for (const n of nodes) {
    const span = document.createElement('span');
    span.innerHTML = esc(n.textContent).replace(new RegExp(MAIL_ID.source, 'g'), (id: string) => `<a href="#" class="threadlink" data-thread-link="${id}">${icon('mail', 'xs')}<span>${id}</span></a>`);
    n.replaceWith(...span.childNodes);
  }
}
export interface ThreadRef { thread_id: string; subject: string }
const subjects = new Map<string, Promise<ThreadRef | null>>(); // mail id -> Promise<{thread_id, subject} | null>
// Fills in each thread link's subject, using fetch(id) -> {thread_id, subject} | null.
export function resolveThreadLinks(el: ParentNode, fetch: (id: string) => Promise<ThreadRef | null>): void {
  for (const a of el.querySelectorAll<HTMLElement>('[data-thread-link]')) {
    const id = a.dataset.threadLink!;
    if (!subjects.has(id)) subjects.set(id, fetch(id).catch(() => null));
    subjects.get(id)!.then((t) => {
      if (!t) { a.classList.add('missing'); a.title = 'No daemon has this mail.'; return; }
      a.dataset.tid = t.thread_id;
      if (!a.dataset.keep) a.querySelector('span')!.textContent = String(t.subject).replace(/^(re:\s*)+/i, '').replace(/`/g, '');
      a.title = 'Open this thread';
    });
  }
}
// Copies a code block's text; returns true when the click was a copy.
export function handleCopy(e: { target: EventTarget | null }): boolean {
  const b = (e.target as Element).closest<HTMLElement>('[data-copy]');
  if (!b) return false;
  const text = b.parentElement!.querySelector('pre')!.textContent ?? '';
  const done = () => { b.innerHTML = icon('check', 'xs'); b.title = 'Copied'; setTimeout(() => { b.innerHTML = icon('copy', 'xs'); b.title = 'Copy'; }, 1500); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => {});
  else { const t = document.createElement('textarea'); t.value = text; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); done(); }
  return true;
}

// A mail body as sanitized HTML, components rendered.
export function renderMail(body: unknown): string {
  const mk = parser();
  decisions = 0;
  const { tldr, rest } = splitTldr(body);
  const html = (tldr ? `<p class="mb-tldr">${mk.parseInline(tldr)}</p>` : '') + mk.parse(rest);
  const tpl = document.createElement('template');
  tpl.innerHTML = DOMPurify.sanitize(html, { ADD_ATTR: ['data-choose', 'data-decision', 'data-own'] });
  // A mail's own markup can't carry a reference link's data (DOMPurify keeps data-*); only refLinks sets them.
  for (const a of tpl.content.querySelectorAll('[data-ref-pick], [data-ref-act]')) { a.removeAttribute('data-ref-pick'); a.removeAttribute('data-ref-act'); }
  callouts(tpl.content);
  mentions(tpl.content);
  itsaLinks(tpl.content);
  threadLinks(tpl.content);
  refLinks(tpl.content); // #494, Settings › Spending (refs.ts)
  for (const p of tpl.content.querySelectorAll('p')) {
    const a = p.querySelector(':scope > a:only-child');
    if (!a || p.textContent.trim() !== a.textContent.trim()) continue;
    const e = embedUrl(a.getAttribute('href') ?? '');
    if (e?.kind === 'frame' && /YouTube|Vimeo|Loom/.test(e.site)) { const t = document.createElement('template'); t.innerHTML = embedHtml(e); p.replaceWith(t.content); }
  }
  for (const t of tpl.content.querySelectorAll<HTMLTableElement>('table:not(.mb-dtable)')) if (!t.closest('.mb-cdata')) enhanceTable(t);
  for (const pre of tpl.content.querySelectorAll('pre')) {
    if (pre.closest('.mb-diff, .mb-tests, .mb-error, .mb-diagram, .mb-chart')) continue;
    const box = document.createElement('div');
    box.className = 'mb-code';
    pre.replaceWith(box);
    box.append(pre);
    box.insertAdjacentHTML('beforeend', `<button class="mb-copy" data-copy type="button" title="Copy">${icon('copy', 'xs')}</button>`);
  }
  for (const d of tpl.content.querySelectorAll('details:not(.mb-file, .mb-fail, .mb-passes, .mb-cdata)')) {
    d.classList.add('mb-details');
    d.querySelector(':scope > summary')?.insertAdjacentHTML('afterbegin', icon('chevron-right', 'xs'));
  }
  const div = document.createElement('div');
  div.append(tpl.content);
  return div.innerHTML;
}

// Plain text for one-line previews: the TLDR when there is one.
export function preview(body: unknown, n = 160): string {
  const { tldr, rest } = splitTldr(body);
  const text = tldr ?? rest.replace(/```decision\n([\s\S]*?)```/g, (_, d) => parseDecision(d).question || 'Decision')
    .replace(/```[\s\S]*?```/g, ' ').replace(/<\/?(details|summary)>/g, ' ').replace(/\[!\w+\]/g, ' ');
  return text.replace(/[#*_`>|\[\]-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}

// Marks each decision in a rendered mail answered when a later mail in the thread replies
// to it with a choice or a note. A deferral is shown as such, but the block stays open: its
// buttons stay live for the viewer to answer (S-353). The buttons are enabled only where the viewer can answer.
export interface ThreadMail { from_id: string; created_at: string; body?: string | null }
export function markDecisions(el: ParentNode, mail: { created_at: string }, thread: ThreadMail[], canAnswer: boolean): void {
  const blocks = el.querySelectorAll('.mb-decision');
  if (!blocks.length) return;
  // An answer is any later mail from the human in the thread that quotes the question.
  const replies = thread.filter((r) => r.from_id === 'human' && r.created_at > mail.created_at).map((r) => r.body ?? '');
  for (const b of blocks) {
    const opts = [...b.querySelectorAll<HTMLButtonElement>('[data-choose]')];
    const q = b.querySelector('.mb-q')?.textContent?.trim().split('\n')[0] ?? '';
    const mine = replies.filter((r) => !q || r.includes(q));
    if (b.classList.contains('rank')) {
      const r = mine.find((x) => x.includes(RANKED));
      const order = r ? [...r.slice(r.indexOf(RANKED)).matchAll(/\d+\. \*\*(.+?)\*\*/g)].map((x) => x[1]) : null;
      const deferred = !order && mine.some((x) => x.includes(DEFER_MARK));
      const noted = !order && mine.some((x) => x.includes(NOTED));
      const done = !!order || noted;
      if (order) setRankOrder(b, order);
      b.classList.toggle('answered', done);
      for (const x of b.querySelectorAll<HTMLButtonElement>('button')) { x.disabled = done || !canAnswer; if (x.closest('.mb-foot')) x.hidden = done || !canAnswer; }
      for (const row of b.querySelectorAll<HTMLElement>('.mb-rrow')) row.draggable = !done && canAnswer;
      b.querySelector('.mb-status')!.textContent = order ? `You ranked: ${order.join(', ')}.` : noted ? 'You answered with a note.' : deferred ? 'You deferred this.' : canAnswer ? '' : 'Open the thread to answer.';
      continue;
    }
    const multi = b.classList.contains('multi');
    const picks = multi ? mine.find((r) => r.includes(PICKED)) : null;
    const picked = picks ? opts.filter((o) => picks.includes(`**${o.dataset.choose}**`)) : [];
    const chosen = multi ? picked[0] : opts.find((o) => mine.some((r) => r.includes(choiceText(o.dataset.choose!))));
    const deferred = !chosen && mine.some((r) => r.includes(DEFER_MARK));
    const noted = !chosen && mine.some((r) => r.includes(NOTED));
    const done = !!chosen || noted;
    b.classList.toggle('answered', done);
    b.classList.toggle('deferred', deferred);
    for (const o of opts) {
      o.disabled = done || !canAnswer;
      const on = multi ? picked.includes(o) : o === chosen;
      o.classList.toggle('chosen', on);
      if (multi && done) { o.classList.toggle('sel', on); o.setAttribute('aria-pressed', String(on)); o.querySelector('.mb-box')!.innerHTML = icon(on ? 'square-check' : 'square', 'xs'); }
    }
    for (const x of b.querySelectorAll<HTMLElement>('.mb-foot button')) x.hidden = done || !canAnswer;
    if (multi && !done) for (const o of opts) o.disabled = !canAnswer;
    b.querySelector('.mb-status')!.textContent = multi && chosen ? `You picked ${picked.map((o) => o.dataset.choose).join(', ')}.` : chosen ? `You chose ${chosen.dataset.choose}.`
      : noted ? 'You answered with a note.'
      : deferred ? 'You deferred this; it stays open.'
      : canAnswer ? '' : 'Open the thread to answer.';
  }
}
