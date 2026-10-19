import { join } from 'node:path';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { ROOT, STAM_HOME } from './config.ts';
import { settings, mayMailHuman } from './settings.ts';
import { agentTypes, typeTemplate } from './agent-types.ts';
import { hasBlocks, blocksText, composedText } from './blocks.ts';

// Every text stam sends to agents comes from a template. A file with the same name in
// STAM_HOME/templates overrides the default: the repo's templates folder, or for a template built
// from block files (blocks/NAME/, S-883) their bodies in order.
// `type` is the agent type the text is for: its `blocks` composition (off, replace) applies to a
// template built from blocks, not to a user override, which is the whole file.
export function template(name: string, type?: string | null): string {
  const blocks = type ? agentTypes()[type]?.blocks : undefined;
  for (const dir of [join(STAM_HOME, 'templates'), join(ROOT, 'templates')]) {
    try {
      return readFileSync(join(dir, `${name}.md`), 'utf8');
    } catch {}
    if (dir !== join(STAM_HOME, 'templates') && hasBlocks(name)) return blocks ? composedText(name, blocks) : blocksText(name);
  }
  // A type the user added has no shipped instructions: empty until they write some.
  if (isTypeTemplate(name)) return '';
  throw new Error(`no template ${name}`);
}

// Whether `name` is rendered from its blocks, so a type's composition applies: not when the user
// (STAM_HOME/templates) or the repo's templates folder overrides it with a whole file.
export const rendersFromBlocks = (name: string): boolean =>
  hasBlocks(name) && !existsSync(join(STAM_HOME, 'templates', `${name}.md`)) && !existsSync(join(ROOT, 'templates', `${name}.md`));

const isTypeTemplate = (name: string) => Object.keys(agentTypes()).some((t) => typeTemplate(t) === name);

export function render(name: string, vars: Record<string, string | number>, type?: string | null): string {
  return template(name, type)
    .replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''))
    .trim();
}

// The retro reminder (S-710) for a notice that comes before an agent loses context: '' when
// settings.retro.reminders is off, else the reminder, for a notice to embed or append.
export function retroReminder(): string {
  return settings().retro.reminders.enabled ? render('retro-reminder', {}) : '';
}

// A notice with the reminder embedded where its template has {{retro}}; the blank lines
// an empty reminder leaves collapse.
export function renderWithRetro(name: string, vars: Record<string, string | number>): string {
  return render(name, { ...vars, retro: retroReminder() }).replace(/\n{3,}/g, '\n\n');
}

export function withRetroReminder(text: string): string {
  const r = retroReminder();
  return r ? `${text}\n\n${r}` : text;
}

// The retro reminder (S-726) for a notice that reports a failure: '' when settings.retro.reminders
// is off, else the failure line, which asks for the failure itself as the evidence. Same setting
// as the context reminder (S-710); only the wording differs.
export function retroFailureReminder(): string {
  return settings().retro.reminders.enabled ? render('retro-reminder-failure', {}) : '';
}

// A notice that reports a failure, with the failure retro reminder appended; unchanged when off.
export function withFailureRetro(text: string): string {
  const r = retroFailureReminder();
  return r ? `${text}\n\n${r}` : text;
}

// The rules for mailing the human, with the user's choice of when to mail them. An agent whose
// model may not mail the human (settings.humanMail.models) gets the short rules instead; pass its
// model, or nothing for the full rules.
export function humanMailPrompt(model?: string | null, type?: string | null): string {
  if (model !== undefined && !mayMailHuman(model)) return render('mail-to-human-restricted', {}, type);
  return render('mail-to-human', { when: render(`human-mail-when-${settings().humanMail.when}`, {}) }, type);
}

// For the UI: every template with its current text and whether the user overrode it,
// including each agent type's instructions, shipped or not.
export function listTemplates(): { name: string; text: string; overridden: boolean; default: string }[] {
  const shipped = [...readdirSync(join(ROOT, 'templates')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)), ...readdirSync(join(ROOT, 'blocks')).filter(hasBlocks)];
  const names = [...new Set([...shipped.filter((n) => !n.startsWith('type-') || isTypeTemplate(n)), ...Object.keys(agentTypes()).map(typeTemplate)])];
  return names.map((name) => {
    const file = join(ROOT, 'templates', `${name}.md`);
    return { name, text: template(name), overridden: existsSync(join(STAM_HOME, 'templates', `${name}.md`)), default: existsSync(file) ? readFileSync(file, 'utf8') : hasBlocks(name) ? blocksText(name) : '' };
  });
}

export function saveTemplate(name: string, text: string): void {
  if (!/^[\w-]+$/.test(name) || !(existsSync(join(ROOT, 'templates', `${name}.md`)) || hasBlocks(name) || isTypeTemplate(name))) throw new Error(`no template ${name}`);
  mkdirSync(join(STAM_HOME, 'templates'), { recursive: true });
  writeFileSync(join(STAM_HOME, 'templates', `${name}.md`), text);
}

export function resetTemplate(name: string): void {
  if (!/^[\w-]+$/.test(name)) throw new Error(`no template ${name}`);
  rmSync(join(STAM_HOME, 'templates', `${name}.md`), { force: true });
}
