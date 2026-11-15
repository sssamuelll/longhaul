// Which MCP servers are held back in which folder. No engine calls, no environment, no value imports from ./health.
import type { History } from './health'
import { KEEP_DAYS, type SessionRecord } from './ledger'
import { localDate } from './budget'

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

export type Here = { root: string; real?: string }
export type Verb = 'only' | 'here' | 'everywhere' | 'off'
export type Command =
  | { kind: 'report' } | { kind: 'health' } | { kind: 'list' }
  | { kind: 'verb'; server: string; verb: Verb; patterns: string[] }
  | { kind: 'help'; why: string }

const VERBS: string[] = ['only', 'here', 'everywhere', 'off']

export const HELP = [
  '/longhaul                                 the weekly report',
  '/longhaul health                          what every session loads before any work',
  '/longhaul mcp                             MCP servers: cost, where they are used, rule',
  '/longhaul mcp <server> only <folder…>     load only in folders that match',
  '/longhaul mcp <server> here               also load in this folder',
  '/longhaul mcp <server> everywhere         remove the rule',
  '/longhaul mcp <server> off                off in every folder',
].join('\n')

// Words split on spaces; a part in double quotes is one word.
export function parseCommand(args: string): Command {
  const words = [...args.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2])
  const head = words[0]?.toLowerCase()
  if (head === undefined) return { kind: 'report' }
  if (head === 'health' && words.length === 1) return { kind: 'health' }
  if (head !== 'mcp') return { kind: 'help', why: `There is no "${words.join(' ')}" command.` }
  const rest = words.slice(1)
  if (!rest.length) return { kind: 'list' }
  const at = rest.findIndex((w) => VERBS.includes(w.toLowerCase()))
  if (at === -1) return { kind: 'help', why: `After "${rest.join(' ')}", type only, here, everywhere or off.` }
  const verb = rest[at].toLowerCase() as Verb
  const patterns = rest.slice(at + 1)
  if (at === 0) return { kind: 'help', why: `Name the server before ${verb}.` }
  if (verb === 'only' && !patterns.length) return { kind: 'help', why: 'After only, type at least one folder name or full path.' }
  if (verb !== 'only' && patterns.length) return { kind: 'help', why: `Type ${verb} with nothing after it.` }
  return { kind: 'verb', server: rest.slice(0, at).join(' '), verb, patterns }
}

// ---- what is known about each server ----

export const MAX_ONLY_FOLDERS = 3
export const MAX_LISTED_FOLDERS = 5

export type Seen = { name: string; isHeld: boolean }
const seen = new Map<string, Seen>() // the module's one piece of state: what the hook saw, newest answer wins
export const noteSeen = (name: string, isHeld: boolean): void => void seen.set(nameKey(name), { name, isHeld })
export const seenServers = (): Seen[] => [...seen.values()]

export type Known = {
  key: string
  name: string
  isOn: boolean // on in this session: in the breakdown, or the hook passed it
  isSeen: boolean // false: known by its rule alone
  rule?: string[]
  tools?: number
  tokens?: number // from the newest kept snapshot that has it
  calls: [folder: string, calls: number][] // most calls first
  idleIn: string[] // a kept snapshot had it and no kept record has a call
}

const folderOf = (r: SessionRecord): string => r.root ?? r.project

export function knownServers(src: { seen: Seen[]; tools: { name: string; serverName?: string }[]; records: SessionRecord[]; rules: RuleSet }): Known[] {
  type Acc = { names: Record<'seen' | 'rule' | 'tool' | 'label' | 'key', string | undefined>; isOn: boolean; isSeen: boolean; snap?: { at: number; tools: number; tokens: number }; calls: Map<string, number>; withSnap: Set<string> }
  const acc = new Map<string, Acc>()
  const get = (wire: string): Acc => {
    const k = nameKey(wire)
    let a = acc.get(k)
    if (!a) acc.set(k, (a = { names: { seen: undefined, rule: undefined, tool: undefined, label: undefined, key: wire }, isOn: false, isSeen: false, calls: new Map(), withSnap: new Set() }))
    return a
  }
  for (const s of src.seen) {
    const a = get(s.name)
    a.names.seen = s.name
    a.isSeen = true
    if (!s.isHeld) a.isOn = true
  }
  for (const t of src.tools) {
    const wire = t.name.match(/^mcp__(.+?)__/)?.[1]
    if (!wire) continue
    const a = get(wire)
    a.names.tool = t.serverName
    a.isOn = a.isSeen = true
  }
  for (const key of Object.keys(src.rules)) get(key).names.rule = key
  const called = new Set<string>() // every folder with a call, any server
  for (const r of src.records) {
    const f = folderOf(r)
    for (const [wire, n] of Object.entries(r.mcpCalls)) {
      const a = get(wire)
      a.isSeen = true
      a.calls.set(f, (a.calls.get(f) ?? 0) + n)
      called.add(nameKey(wire) + '\n' + f)
    }
    for (const [wire, e] of Object.entries(r.base?.mcp ?? {})) {
      const a = get(wire)
      a.isSeen = true
      a.withSnap.add(f)
      a.names.label ??= e.label
      if (!a.snap || r.base!.at > a.snap.at) a.snap = { at: r.base!.at, tools: e.tools, tokens: e.tokens }
    }
  }
  const out: Known[] = []
  for (const [key, a] of acc) {
    const name = a.names.seen ?? a.names.rule ?? a.names.tool ?? a.names.label ?? a.names.key!
    if (isProtected(name)) continue
    const rule = findRule(src.rules, name)?.[1]
    out.push({
      key,
      name,
      isOn: a.isOn,
      isSeen: a.isSeen,
      ...(rule && { rule }),
      ...(a.snap && { tools: a.snap.tools, tokens: a.snap.tokens }),
      calls: [...a.calls].sort((x, y) => y[1] - x[1]),
      idleIn: [...a.withSnap].filter((f) => !called.has(key + '\n' + f)),
    })
  }
  return out.sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.name.localeCompare(b.name))
}

export const foldersOf = (records: SessionRecord[]): string[] => [...new Set(records.map(folderOf))]

// The folder's last name when, as a pattern, it matches no other recorded folder; else the full path.
const labelOf = (folder: string, folders: string[]): string => {
  const last = normPath(folder).split('/').filter(Boolean).pop()
  return last && !matchesFolder([last], folders.filter((f) => f !== folder)) ? last : folder
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const num = (x: number) => x.toLocaleString('en-US')
const periodOf = (h: History, now: number) => `in the last ${plural(Math.min(KEEP_DAYS, Math.floor((now - h.since) / 86_400_000)), 'day')}`

export type Suggestion = { key: string; name: string; tools?: number; why: string; command: string }

export function suggestionsOf(known: Known[], folders: string[], history: History, now: number): Suggestion[] {
  if (!history.mature) return []
  const period = periodOf(history, now)
  const out: Suggestion[] = []
  for (const k of known) {
    if (k.rule) continue
    const base = { key: k.key, name: k.name, ...(k.tools !== undefined && { tools: k.tools }) }
    if (!k.calls.length) out.push({ ...base, why: `was not called ${period}`, command: `/longhaul mcp ${k.name} off` })
    else if (k.calls.length <= MAX_ONLY_FOLDERS && k.idleIn.length) {
      const labels = k.calls.map(([f]) => labelOf(f, folders))
      out.push({ ...base, why: `was called only in ${labels.join(', ')} ${period}`, command: `/longhaul mcp ${k.name} only ${labels.map((l) => (l.includes(' ') ? `"${l}"` : l)).join(' ')}` })
    }
  }
  return out
}

export const MODE_OFF = 'Rules are saved but not applied. To apply them, set mcp_mode to on in /plugin and run /reload-plugins.'

export type Typed = { pattern: string; isPath: boolean; isMissing?: true } // isMissing: a full path whose folder was not found
export type VerbPlan = { rules?: RuleSet; connect: boolean; lines: string[] } // rules absent: nothing to save

export const NOT_SAVED = 'The rule could not be saved, so nothing changed. Try the command again.'
export const NOT_READ = 'The rules could not be read, so nothing changed. Try the command again.'
export const STAYS_ON = 'It stays on in this session and is held from the next one. /mcp turns it off now.'

export function resolveServer(known: Known[], typed: string): Known | { error: string } {
  if (isProtected(typed)) return { error: "longhaul's own server is never held." }
  const k = nameKey(typed).toLowerCase()
  const found = known.find((x) => nameKey(x.name).toLowerCase() === k)
  if (found) return found
  const names = known.map((x) => x.name).sort((a, b) => a.localeCompare(b))
  return { error: `No MCP server is called "${typed}". ${names.length ? `Known: ${names.join(', ')}.` : 'None is known yet.'}` }
}

export function planVerb(k: Known, verb: Verb, typed: Typed[], rules: RuleSet, here: Here, isOn: boolean): VerbPlan {
  const cur = findRule(rules, k.name)?.[1]
  const folders = [here.root, ...(here.real ? [here.real] : [])]
  const next =
    verb === 'only' ? typed.map((t) => t.pattern)
    : verb === 'off' ? []
    : verb === 'everywhere' ? undefined
    : cur && (matchesFolder(cur, folders) ? cur : [...cur, normPath(here.real ?? here.root)])
  const isKept = next === cur
  const lines = [!next ? `${k.name} has no rule and loads everywhere.` : next.length ? `${k.name} loads only in ${next.join(', ')}.` : `${k.name} is off in every folder.`]
  for (const t of typed) if (t.isMissing) lines.push(`${t.pattern} was not found, so it was saved as typed.`)
  const isHere = !next || matchesFolder(next, folders)
  if (isOn && k.isOn && !isHere) lines.push(STAYS_ON)
  if (!isOn) lines.push(MODE_OFF)
  const connect = isOn && (verb === 'here' ? !!cur : verb === 'everywhere' || (verb === 'only' && isHere))
  if (isKept) return { connect, lines }
  const out = Object.fromEntries(Object.entries(rules).filter(([key]) => nameKey(key) !== nameKey(k.name)))
  if (next) out[k.name] = next
  return { rules: out, connect, lines }
}

export const connectLine = (r: { isConnected?: boolean; message?: string } | undefined): string =>
  r?.isConnected ? 'It is on in this session.' : r?.message ? `It did not connect: ${r.message}` : 'It did not connect.'

export function renderList(known: Known[], o: { suggestions: Suggestion[]; folders: string[]; here: Here; isOn: boolean; history: History; now: number }): string {
  const lines = o.isOn ? [] : [MODE_OFF, '']
  lines.push('MCP servers', '')
  if (!known.length) return [...lines, 'No MCP servers known yet.'].join('\n')
  const hereFolders = [o.here.root, ...(o.here.real ? [o.here.real] : [])]
  const period = periodOf(o.history, o.now)
  const since = localDate(o.history.since)
  for (const k of known) {
    lines.push(`${k.name}: ${k.tools !== undefined && k.tokens !== undefined ? `${plural(k.tools, 'tool')}, about ${num(k.tokens)} tokens (est.) per session` : 'cost not measured yet'}`)
    if (!k.rule) lines.push('  rule: none, loads everywhere')
    else if (!k.rule.length) lines.push('  rule: off in every folder')
    else lines.push(`  rule: only ${k.rule.join(', ')}${o.isOn ? (matchesFolder(k.rule, hereFolders) ? ' (loads in this folder)' : ' (held in this folder)') : ''}`)
    if (!k.isSeen) lines.push(`  not seen in the last ${KEEP_DAYS} days`)
    else if (!k.calls.length) lines.push(o.history.mature ? `  not called ${period}` : `  no calls recorded since ${since}`)
    else {
      const shown = k.calls.slice(0, MAX_LISTED_FOLDERS).map(([f, c]) => `${labelOf(f, o.folders)} (${c})`).join(', ')
      const more = k.calls.length - MAX_LISTED_FOLDERS
      lines.push(`  called ${o.history.mature ? period : `since ${since}`}: ${shown}${more > 0 ? ` and ${more} more` : ''}`)
    }
    const s = o.suggestions.find((x) => x.key === k.key)
    if (s) lines.push(`  suggestion: ${s.command}`)
  }
  return lines.join('\n')
}
