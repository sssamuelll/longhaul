// Which MCP servers are held back in which folder. Pure: no engine calls, no environment, no imports from ./health.
export const RULES_KEY = 'mcp:rules'
export const PROTECTED = ['longhaul'] // name keys that are never held
export type RuleSet = Record<string, string[]>

// /mcp spells a server `claude.ai Docs`, a tool name spells it `claude_ai_Docs`: one key for both.
export const nameKey = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, '_')

// Every \ becomes /, a trailing / goes unless the path is only a root (`D:/`, `/`). Case is kept.
export const normPath = (p: string): string => {
  const t = p.replace(/\\/g, '/')
  return t.length > 1 && t.endsWith('/') && !/^[A-Za-z]:\/$/.test(t) ? t.replace(/\/+$/, '') || '/' : t
}

export function checkPattern(raw: string): { pattern: string; isPath: boolean } | { error: string } {
  const s = raw.trim()
  if (s.startsWith('~')) return { error: "~ is not read as your home folder, so nothing was saved. Type the folder's name or its full path, or use here from inside the folder." }
  if (!s) return { error: 'Type a folder name or a full path.' }
  const pattern = normPath(s)
  if (!pattern.includes('/')) return { pattern, isPath: false }
  if (!/^([A-Za-z]:[\\/]|[\\/])/.test(s)) return { error: `"${raw}" is not a full path, so nothing was saved. Type a folder name with no slash, or a full path.` }
  return { pattern, isPath: true }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// True when any pattern matches any spelling of the folder.
export function matchesFolder(patterns: string[], folders: string[]): boolean {
  const fs = folders.map((f) => normPath(f).toLowerCase())
  return patterns.some((raw) => {
    const p = normPath(raw).toLowerCase()
    if (p.includes('/')) return fs.some((f) => f === p || f.startsWith(p.endsWith('/') ? p : p + '/'))
    const re = new RegExp(`(^|[\\\\/_.-])${esc(p)}($|[\\\\/_.-])`, 'i')
    return fs.some((f) => re.test(f))
  })
}

export function readRuleSet(stored: unknown): RuleSet | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
  for (const v of Object.values(stored)) if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return null
  return stored as RuleSet
}

export function findRule(rules: RuleSet, server: string): [key: string, patterns: string[]] | undefined {
  const k = nameKey(server)
  return Object.entries(rules).find(([key]) => nameKey(key) === k)
}

export function isProtected(server: string, provider?: string): boolean {
  return PROTECTED.includes(nameKey(server).toLowerCase()) || (!!provider?.startsWith('longhaul@') && server.toLowerCase().includes('longhaul'))
}

export function holds(rules: RuleSet | null, server: string, provider: string | undefined, folders: string[]): boolean {
  if (!rules || isProtected(server, provider)) return false
  const rule = findRule(rules, server)
  return !!rule && !matchesFolder(rule[1], folders)
}

export const holdMessage = (server: string): string => `longhaul holds ${server} in this folder: /longhaul mcp ${server} here turns it on.`
