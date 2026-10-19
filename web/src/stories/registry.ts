// Every story in web/src, found by file name, in the sidebar's order: by group, then by path.
import { GROUPS, type Story } from './types'

export interface Entry extends Story { id: string; file: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function collect(mods: Record<string, { stories?: Story[] }>): Entry[] {
  const out: Entry[] = []
  for (const file of Object.keys(mods).sort()) for (const s of mods[file].stories ?? []) out.push({ ...s, id: slug(s.name), file })
  return out.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group))
}

export const STORIES: Entry[] = collect(import.meta.glob<{ stories?: Story[] }>('../**/*.stories.tsx', { eager: true }))
export const storyById = (id: string | null) => STORIES.find((s) => s.id === id)
