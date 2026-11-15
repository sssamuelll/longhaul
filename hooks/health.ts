import type { SessionUsage } from 'claude-code'
import type { SessionRecord } from './ledger'
import { localDate } from './budget'
import { START_CAP } from './session'

const DAY = 86_400_000
const MIN_LINE = 40 // characters, after trimming and collapsing whitespace
export const MAX_FILE = 1_000_000 // characters; a bigger memory file is counted by the breakdown but not scanned
const BIG_FILE_LINES = 200
const BIG_FILE_TOKENS = 3000
export const DUP_TOKENS = 500
export const NOTICE_TOTAL = 60_000
const MIN_HISTORY = 3 * DAY // the mod's records must reach back this far before a server counts as unused
const WIRE = /^mcp__(.+?)__/ // same key as the call counts in register.tsx
export const NOTICE_EVERY = 7 * DAY
// Characters per token for tool names and server instructions; measured 2.1 on 2026-11-14 (12,078 characters, 5,749 tokens).
export const ON_DEMAND_CHARS = 2

export type McpEntry = { tools: number; tokens: number; label?: string; loaded?: number } // loaded: tools whose schema is loaded; absent means all
export type SnapshotExtra = { startCtx?: number; instructions?: [number, number][][] }

export type BaseSnapshot = {
  at: number
  total: number
  afterFirstReply?: true // no Messages row to subtract: the total includes the first turn
  measured?: number // the first request, as measured; absent when there was no clean measure
  mcp: Record<string, McpEntry> // keyed by wire name; label is what /mcp lists
  memory: { path: string; tokens: number; lines?: number; type?: string }[]
  skills: { count: number; tokens: number }
  duplicate: { lines: number; tokens: number; files: string[] }
}
export type Advice = { text: string; tokens: number }
export type History = { mature: boolean; since: number }

const n = (x: number): string => Math.round(x).toLocaleString('en-US')
const plural = (c: number, w: string): string => `${c} ${w}${c === 1 ? '' : 's'}`
const EST = '(est.)'

// Lines of 40+ characters that two or more files share. Only counts and paths leave this function.
export function findDuplicates(files: { path: string; text: string }[]): BaseSnapshot['duplicate'] {
  const seen = new Map<string, Set<string>>()
  for (const f of files) {
    for (const raw of f.text.split('\n')) {
      const l = raw.trim().replace(/\s+/g, ' ')
      if (l.length < MIN_LINE || !/[\p{L}\p{N}]/u.test(l)) continue // rules and table separators
      let s = seen.get(l)
      if (!s) seen.set(l, (s = new Set()))
      s.add(f.path)
    }
  }
  let chars = 0
  let lines = 0
  const paths = new Set<string>()
  for (const [l, s] of seen) {
    if (s.size < 2) continue
    lines++
    chars += (s.size - 1) * l.length
    s.forEach((p) => paths.add(p))
  }
  return { lines, tokens: Math.round(chars / 4), files: files.map((f) => f.path).filter((p) => paths.has(p)) }
}

type Breakdown = NonNullable<NonNullable<SessionUsage['context']>['breakdown']>

// Stands for a heading (32-bit FNV-1a of its UTF-16 code units) so that no instruction text is held.
export function headingKey(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

// The parts of the MCP Server Instructions text: one per line starting `## `, as a key of the heading
// (the server's name as /mcp lists it) and the part's length in characters. Only numbers are kept.
export function instructionParts(text: string): [number, number][] {
  const starts = [...text.matchAll(/^## /gm)].map((m) => m.index)
  return starts.map((a, i) => {
    const end = starts[i + 1] ?? text.length
    const nl = text.indexOf('\n', a)
    return [headingKey(text.slice(a + 3, nl < 0 || nl > end ? end : nl).trim()), end - a]
  })
}

// Characters of instructions per server. A part that is not a server belongs to the server before it.
// ponytail: a server with instructions and no tools is counted into the server listed before it; the servers seen by mcp.connect (pull request 2) can replace the breakdown's names.
export function instructionChars(parts: [number, number][], servers: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  let last: string | undefined
  for (const [key, len] of parts) {
    const name = servers.find((s) => headingKey(s) === key)
    if (name !== undefined) last = name
    if (last !== undefined) out[last] = (out[last] ?? 0) + len
  }
  return out
}

// The local estimate of what a session loads before any work, from the usage breakdown and the text of
// each memory file (absent when it could not be read).
export function snapshotOf(b: Breakdown, texts: Map<string, string>, at: number, extra: SnapshotExtra = {}): BaseSnapshot {
  const mcp: BaseSnapshot['mcp'] = {}
  const loaded: Record<string, number> = {}
  const keyOf: Record<string, string> = {} // /mcp name -> key
  for (const t of b.mcpTools ?? []) {
    const key = WIRE.exec(t.name)?.[1] ?? t.serverName
    keyOf[t.serverName] = key
    if (key === 'longhaul') continue
    const s = (mcp[key] ??= { tools: 0, tokens: 0, ...(t.serverName !== key ? { label: t.serverName } : {}) })
    s.tools++
    // an on-demand tool costs only its name until it loads
    s.tokens += t.isLoaded ? t.tokens : Math.ceil(t.name.length / ON_DEMAND_CHARS)
    if (t.isLoaded) loaded[key] = (loaded[key] ?? 0) + 1
  }
  // a server announced again takes its newest total; a heading never folds into a server of another announcement
  const names = Object.keys(keyOf)
  const total: Record<string, number> = {}
  for (const list of extra.instructions ?? []) Object.assign(total, instructionChars(list, names))
  for (const [name, chars] of Object.entries(total))
    if (mcp[keyOf[name]]) mcp[keyOf[name]].tokens += Math.round(chars / ON_DEMAND_CHARS)
  for (const [k, s] of Object.entries(mcp)) if ((loaded[k] ?? 0) < s.tools) s.loaded = loaded[k] ?? 0
  const memory: BaseSnapshot['memory'] = []
  const scanned: { path: string; text: string }[] = []
  for (const m of b.memoryFiles ?? []) {
    if (memory.some((x) => x.path === m.path)) continue
    let lines: number | undefined
    const text = texts.get(m.path)
    if (text !== undefined && text.length <= MAX_FILE) {
      const rows = text.split('\n')
      if (rows.at(-1) === '') rows.pop() // a trailing newline is not a line
      lines = rows.length
      scanned.push({ path: m.path, text })
    }
    memory.push({ path: m.path, tokens: m.tokens, ...(lines === undefined ? {} : { lines }), ...(m.type ? { type: m.type } : {}) })
  }
  const messages = (b.categories ?? []).find((c) => c.name === 'Messages')?.tokens
  return {
    at,
    ...(extra.startCtx !== undefined && extra.startCtx > 0 && extra.startCtx < START_CAP ? { measured: extra.startCtx } : {}),
    total: messages === undefined ? b.totalTokens : Math.max(0, b.totalTokens - messages),
    ...(messages === undefined ? { afterFirstReply: true as const } : {}),
    mcp,
    memory,
    skills: { count: b.skills?.totalSkills ?? 0, tokens: b.skills?.tokens ?? 0 },
    duplicate: findDuplicates(scanned),
  }
}

export const unusedOf = (snap: BaseSnapshot, calls: Record<string, number>, mature = true): [string, McpEntry][] =>
  mature ? Object.entries(snap.mcp).filter(([s]) => !(calls[s] > 0)) : []

const nameOf = (key: string, label?: string): string => (label ? `${key} (${label})` : key)

export function healthAdvice(snap: BaseSnapshot, calls: Record<string, number>, history?: History): Advice[] {
  const out: Advice[] = []
  for (const [s, v] of unusedOf(snap, calls, history?.mature ?? true))
    out.push({
      tokens: v.tokens,
      text: `${nameOf(s, v.label)} has ${plural(v.tools, 'tool')}, about ${n(v.tokens)} tokens ${EST} in every session, and was not used this week: turn it off for projects that don't use it (${s.startsWith('plugin_') ? '/plugin' : '/mcp'}).`,
    })
  for (const m of snap.memory)
    if (m.type !== 'Managed' && ((m.lines ?? 0) > BIG_FILE_LINES || m.tokens > BIG_FILE_TOKENS))
      out.push({
        tokens: m.tokens,
        text: `${m.path} is ${m.lines === undefined ? '' : `${plural(m.lines, 'line')} and `}about ${n(m.tokens)} tokens ${EST}: shorten it, or split it so each part loads only where it is needed.`,
      })
  const d = snap.duplicate
  if (d.tokens >= DUP_TOKENS)
    out.push({
      tokens: d.tokens,
      text: `About ${n(d.tokens)} tokens ${EST} are ${plural(d.lines, 'line')} repeated across ${d.files.join(', ')}: keep the shared text in one file.`,
    })
  if (!out.length) return [{ tokens: 0, text: 'Your sessions start light.' }]
  return out.sort((a, b) => b.tokens - a.tokens)
}

export function renderHealth(snap: BaseSnapshot, advice: Advice[], calls: Record<string, number> = {}, history?: History): string {
  const items: [number, string][] = []
  for (const [s, v] of Object.entries(snap.mcp))
    items.push([v.tokens, `${nameOf(s, v.label)} MCP: ${plural(v.tools, 'tool')}${v.loaded === 0 ? ' (on demand)' : v.loaded === undefined ? '' : ` (${v.loaded} loaded)`}, ${n(v.tokens)} tokens ${EST}, ${calls[s] > 0 ? 'used this week' : history && !history.mature ? `no calls recorded since ${localDate(history.since)}` : 'not used this week'}`])
  for (const m of snap.memory) items.push([m.tokens, `${m.path}: ${m.lines === undefined ? '' : `${plural(m.lines, 'line')}, `}${n(m.tokens)} tokens ${EST}`])
  if (snap.skills.count) items.push([snap.skills.tokens, `skills: ${snap.skills.count} listed, ${n(snap.skills.tokens)} tokens ${EST}`])
  const d = snap.duplicate
  if (d.lines) items.push([d.tokens, `repeated text: ${plural(d.lines, 'line')} across ${plural(d.files.length, 'file')}, ${n(d.tokens)} tokens ${EST}`])
  items.sort((a, b) => b[0] - a[0])
  return [
    'Context health',
    '',
    `Sessions start at ${n(snap.total)} tokens ${EST}${snap.afterFirstReply ? ', counted after the first reply' : ''}${snap.measured ? `; the first request measured ${n(snap.measured)}` : ''}. What loads before any work:`,
    ...items.map(([, t]) => `- ${t}`),
    '',
    'Advice',
    ...advice.map((a) => `- ${a.text}`),
  ].join('\n')
}

export const addCalls = (recs: SessionRecord[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const r of recs) for (const [s, c] of Object.entries(r.mcpCalls)) out[s] = (out[s] ?? 0) + c
  return out
}

export const historyOf = (recs: SessionRecord[], now: number): History => {
  const since = Math.min(now, ...recs.map((r) => r.startedAt))
  return { mature: now - since >= MIN_HISTORY, since }
}
