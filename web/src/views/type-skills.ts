// The rules of the type page's Skills tab (S-891): which skills a type names, and the tokens the
// "Skills available" block costs. Kept apart from the markup so they are testable.
import type { Skill } from './SkillsSettings'

// Mirrors SKILL_LINE_MAX in src/instructions.ts: the block shows at most this many characters of a description.
const DESCRIPTION_MAX = 240

// About four characters a token, as the inventory estimates; one line is `- name: description (path)`.
export function lineTokens(s: Pick<Skill, 'name' | 'description' | 'path'>): number {
  const d = Math.min(s.description.length, DESCRIPTION_MAX)
  return Math.ceil((s.name.length + d + `${s.path}/SKILL.md`.length + 8) / 4)
}

// The block's header and instruction, about 25 tokens, once there is a skill.
const HEADER_TOKENS = 25
export const blockTokens = (skills: Skill[], names: string[]): number => {
  const picked = skills.filter((s) => names.includes(s.name))
  return picked.length ? HEADER_TOKENS + picked.reduce((n, s) => n + lineTokens(s), 0) : 0
}

export const toggleSkill = (names: string[], name: string, on: boolean): string[] => (on ? (names.includes(name) ? names : [...names, name]) : names.filter((n) => n !== name))
export const sameSkills = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((n, i) => n === [...b].sort()[i])
// The body's `skills`: null clears the field.
export const skillsPayload = (names: string[]): string[] | null => (names.length ? names : null)
