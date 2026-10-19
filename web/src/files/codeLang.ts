// Which language a file's path selects in the code viewer. Pure, so it loads with the page and
// the editor chunk loads the matching parser only when the file opens (codeEditor.ts).
export type LangKey = 'ts' | 'tsx' | 'js' | 'jsx' | 'python' | 'css' | 'html' | 'json' | 'markdown' | 'yaml' | 'rust' | 'go' | 'shell'

const BY_EXT: Record<string, LangKey> = {
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  py: 'python', pyi: 'python',
  css: 'css', html: 'html', htm: 'html',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  yaml: 'yaml', yml: 'yaml', rs: 'rust', go: 'go',
  sh: 'shell', bash: 'shell', zsh: 'shell',
}
const BY_NAME: Record<string, LangKey> = {
  '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell', '.bash_profile': 'shell',
  'package.json': 'json', 'tsconfig.json': 'json',
}

export function langForPath(path: string): LangKey | null {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? BY_EXT[name.slice(dot + 1)] ?? null : null
}
