// Everything one agent receives, in the order it arrives, for the web UI's Instructions
// view: stam's system prompt split along the real template, the files its harness loads
// itself, the first prompt it was spawned with, and the skills and MCP servers it gets.
// The parts are rendered at request time, so they show what the agent gets at its next
// start, not a snapshot of what it was launched with.
import { cachedLessons } from './retro-lessons.ts';
import { workspacePrompt } from './workspace-prompt.ts';
import { itsaPrompt } from './itsa-owners.ts';
import { prompt as requirementsPrompt } from './requirements.ts';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Agent } from './db.ts';
import { render, humanMailPrompt } from './templates.ts';
import { mayMailHuman } from './settings.ts';
import { orgRest, typeSegments, chiefOfStaff, managerCostPrompt } from './org.ts';
import { typeTemplate } from './agent-types.ts';
import { instructionsDetail, nativeFiles, GLOBAL_INSTRUCTIONS, skillFolders, extraMcpServers } from './instructions.ts';

// Who a part comes from: stam's own settings and templates, the prompt stam renders from
// them, a file in the agent's repo, or a user-global harness file.
export type InstructionSource = 'stam' | 'stam-generated' | 'repo' | 'user-global';

export interface InstructionPart {
  label: string;
  source: InstructionSource;
  // The file the part is read from, when it is a file.
  path?: string;
  // The stam template or settings item the part comes from; the view uses it as the
  // Settings key to edit.
  origin?: string;
  // Markdown reads best for prompts and instruction files; plain monospace for names.
  format: 'markdown' | 'text';
  text: string;
}

const FILE_LIMIT = 50_000;

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(0, FILE_LIMIT);
  } catch {
    return '';
  }
}

// A template is rendered with a unique marker for each placeholder, so the literal text and
// the substituted values stay in the template's own order.
const mark = (key: string) => `\u0000stam:${key}\u0000`;

function splitMarked(text: string): { key?: string; text: string }[] {
  const re = /\u0000stam:(\w+)\u0000/g;
  const out: { key?: string; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ key: m[1], text: '' });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function literal(text: string, label: string, origin: string): InstructionPart | undefined {
  const t = text.trim();
  return t ? { label, source: 'stam-generated', origin, format: 'markdown', text: t } : undefined;
}

// The org paragraph's template, when it is one: the agent's own role paragraph.
function orgTemplate(a: Agent): string | undefined {
  return a.kind === 'assistant' ? 'assistant' : chiefOfStaff()?.id === a.id ? 'chief-of-staff' : undefined;
}

// system-prompt.md as the agent gets it: its literal text and each substituted block, in
// template order, so overrides, reordering, and omitted placeholders all show where the
// agent sees them.
function systemPromptParts(a: Agent): InstructionPart[] {
  const text = render('system-prompt', { id: a.id, name: a.name, machine: a.machine, role: mark('role'), org: mark('org'), instructions: mark('instructions'), cost: mark('cost'), retro: mark('retro'), lessons: mark('lessons'), workspace: mark('workspace'), itsa: mark('itsa'), requirements: mark('requirements'), human_mail: mark('human_mail') }, a.type);
  const parts: InstructionPart[] = [];
  for (const seg of splitMarked(text)) {
    if (!seg.key) {
      const p = literal(seg.text, 'System prompt', 'system-prompt');
      if (p) parts.push(p);
    } else if (seg.key === 'role') {
      parts.push({ label: 'Role', source: 'stam', format: 'markdown', text: a.role || 'not set' });
    } else if (seg.key === 'org') {
      for (const seg of typeSegments(a)) {
        if (seg.key === 'skills') parts.push({ label: 'Skills available', source: 'stam-generated', origin: 'type-skills', format: 'markdown', text: seg.text });
        else parts.push({ label: `Type: ${a.type}`, source: 'stam', origin: typeTemplate(a.type!), format: 'markdown', text: seg.text });
      }
      const org = orgRest(a);
      if (org) parts.push({ label: 'Org', source: 'stam-generated', origin: orgTemplate(a), format: 'markdown', text: org });
    } else if (seg.key === 'instructions') {
      parts.push(...instructionFileParts(a.harness, a.cwd));
    } else if (seg.key === 'cost') {
      const cost = managerCostPrompt(a);
      if (cost) parts.push({ label: 'Cost', source: 'stam-generated', format: 'markdown', text: cost });
    } else if (seg.key === 'retro') {
      const p = literal(render('retro', {}, a.type), 'Retros', 'retro');
      if (p) parts.push(p);
    } else if (seg.key === 'lessons') {
      const p = literal(cachedLessons(a.id) ?? '', 'Lessons from similar work', 'lessons');
      if (p) parts.push(p);
    } else if (seg.key === 'workspace') {
      const p = literal(workspacePrompt(a), 'Your workspace', 'workspace');
      if (p) parts.push(p);
    } else if (seg.key === 'itsa') {
      const t = itsaPrompt(a.id).trim();
      if (t) parts.push({ label: 'ITSAs', source: 'stam-generated', origin: 'itsa', format: 'markdown', text: t });
    } else if (seg.key === 'requirements') {
      const t = requirementsPrompt();
      if (t) parts.push({ label: 'Requirements', source: 'stam-generated', origin: 'requirements', format: 'markdown', text: t });
    } else if (seg.key === 'human_mail') {
      const mail = humanMailPrompt(a.model, a.type);
      if (mail) parts.push({ label: 'Mail to your user', source: 'stam-generated', origin: mayMailHuman(a.model) ? 'mail-to-human' : 'mail-to-human-restricted', format: 'markdown', text: mail });
    }
  }
  return parts;
}

// instruction-files.md as the agent gets it: its literal heading, then the all-agents text
// and the skipped-files note, in the template's order.
function instructionFileParts(harness: string, cwd: string): InstructionPart[] {
  const { global, note } = instructionsDetail(harness, cwd);
  if (!global && !note) return [];
  const text = render('instruction-files', { global: mark('global'), files: mark('files') });
  const parts: InstructionPart[] = [];
  for (const seg of splitMarked(text)) {
    if (!seg.key) {
      const p = literal(seg.text, 'Instructions', 'instruction-files');
      if (p) parts.push(p);
    } else if (seg.key === 'global' && global) {
      parts.push({ label: 'Instructions for all agents', source: 'stam', path: GLOBAL_INSTRUCTIONS, origin: 'instructions', format: 'markdown', text: global });
    } else if (seg.key === 'files' && note) {
      parts.push({ label: 'Instruction files your harness skips', source: 'stam-generated', origin: 'instruction-files', format: 'markdown', text: note });
    }
  }
  return parts;
}

export function agentInstructionParts(a: Agent): { parts: InstructionPart[] } {
  const parts: InstructionPart[] = systemPromptParts(a);
  for (const f of nativeFiles(a.harness, a.cwd)) parts.push({ label: basename(f.path), source: f.source, path: f.path, format: 'markdown', text: readText(f.path) });
  parts.push({ label: 'First prompt', source: 'stam', format: 'markdown', text: a.first_prompt ?? 'Not recorded for this agent.' });
  const skills = skillFolders().map((s) => s.name).sort();
  parts.push({ label: 'Skills', source: 'stam', format: 'text', text: skills.length ? skills.map((s) => `- ${s}`).join('\n') : 'None.' });
  const servers = [...new Set([...Object.keys(extraMcpServers()), 'stam'])];
  parts.push({ label: 'MCP servers', source: 'stam', format: 'text', text: servers.map((s) => `- ${s}`).join('\n') });
  parts.push({
    label: 'Harness built-in prompt',
    source: 'stam-generated',
    format: 'text',
    text: `This is everything stam gives ${a.name}. The harness's own built-in system prompt is not shown here.`,
  });
  return { parts };
}
