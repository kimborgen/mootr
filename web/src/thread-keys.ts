// The keys that act on the open mail thread of a `t:` world (S-2286): `e` archives it, or unarchives
// it when it is archived, and `d` defers it, or undefers it. Any other world, key or none gives null.
export function threadKey(key: string, world: string | null): 'archive' | 'defer' | null {
  if (!world?.startsWith('t:')) return null
  if (key === 'e') return 'archive'
  if (key === 'd') return 'defer'
  return null
}
