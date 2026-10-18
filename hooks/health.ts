import type { EngineInterface } from 'claude-code'
import type { Config } from './config'
import { setEvent } from './compact'
import { eventIsEmpty } from './band'
import { current, fail } from './session'
import { listRecords, saveRecord, type SessionRecord } from './ledger'
import { windowOf } from './report'
import { localDate, NOTICE_MCP } from './budget'

const DAY = 86_400_000
const MIN_LINE = 40 // characters, after trimming and collapsing whitespace
const MAX_FILE = 1_000_000 // characters; a bigger memory file is counted by the breakdown but not scanned
const BIG_FILE_LINES = 200
const BIG_FILE_TOKENS = 3000
const DUP_TOKENS = 500
const NOTICE_TOTAL = 60_000
const MIN_HISTORY = 3 * DAY // the mod's records must reach back this far before a server counts as unused
const WIRE = /^mcp__(.+?)__/ // same key as the call counts in register.ts
const NOTICE_EVERY = 7 * DAY

export type BaseSnapshot = {
  at: number
  total: number
  afterFirstReply?: true // no Messages row to subtract: the total includes the first turn
  mcp: Record<string, { tools: number; tokens: number; label?: string }> // keyed by wire name; label is what /mcp lists
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

// The free local estimate of what a session loads before any work. Null when there is none.
export async function takeSnapshot($: EngineInterface): Promise<BaseSnapshot | null> {
  const b = (await $.session.usage({ breakdown: 'summary' }))?.context?.breakdown
  if (!b) return null
  const mcp: BaseSnapshot['mcp'] = {}
  for (const t of b.mcpTools ?? []) {
    const key = WIRE.exec(t.name)?.[1] ?? t.serverName
    if (!t.isLoaded || key === 'longhaul') continue
    const s = (mcp[key] ??= { tools: 0, tokens: 0, ...(t.serverName !== key ? { label: t.serverName } : {}) })
    s.tools++
    s.tokens += t.tokens
  }
  const memory: BaseSnapshot['memory'] = []
  const texts: { path: string; text: string }[] = []
  for (const m of b.memoryFiles ?? []) {
    if (memory.some((x) => x.path === m.path)) continue
    let lines: number | undefined
    try {
      const text = await $.fs.read(m.path)
      if (typeof text === 'string' && text.length <= MAX_FILE) {
        const rows = text.split('\n')
        if (rows.at(-1) === '') rows.pop() // a trailing newline is not a line
        lines = rows.length
        texts.push({ path: m.path, text })
      }
    } catch {
      // unreadable: counted by the breakdown, not scanned
    }
    memory.push({ path: m.path, tokens: m.tokens, ...(lines === undefined ? {} : { lines }), ...(m.type ? { type: m.type } : {}) })
  }
  const messages = (b.categories ?? []).find((c) => c.name === 'Messages')?.tokens
  return {
    at: await $.clock.now(),
    total: messages === undefined ? b.totalTokens : Math.max(0, b.totalTokens - messages),
    ...(messages === undefined ? { afterFirstReply: true as const } : {}),
    mcp,
    memory,
    skills: { count: b.skills?.totalSkills ?? 0, tokens: b.skills?.tokens ?? 0 },
    duplicate: findDuplicates(texts),
  }
}

const unusedOf = (snap: BaseSnapshot, calls: Record<string, number>, mature = true): [string, { tools: number; tokens: number; label?: string }][] =>
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
    items.push([v.tokens, `${nameOf(s, v.label)} MCP: ${plural(v.tools, 'tool')}, ${n(v.tokens)} tokens ${EST}, ${calls[s] > 0 ? 'used this week' : history && !history.mature ? `no calls recorded since ${localDate(history.since)}` : 'not used this week'}`])
  for (const m of snap.memory) items.push([m.tokens, `${m.path}: ${m.lines === undefined ? '' : `${plural(m.lines, 'line')}, `}${n(m.tokens)} tokens ${EST}`])
  if (snap.skills.count) items.push([snap.skills.tokens, `skills: ${snap.skills.count} listed, ${n(snap.skills.tokens)} tokens ${EST}`])
  const d = snap.duplicate
  if (d.lines) items.push([d.tokens, `repeated text: ${plural(d.lines, 'line')} across ${plural(d.files.length, 'file')}, ${n(d.tokens)} tokens ${EST}`])
  items.sort((a, b) => b[0] - a[0])
  return [
    'Context health',
    '',
    `Sessions start at ${n(snap.total)} tokens ${EST}${snap.afterFirstReply ? ', counted after the first reply' : ''}. What loads before any work:`,
    ...items.map(([, t]) => `- ${t}`),
    '',
    'Advice',
    ...advice.map((a) => `- ${a.text}`),
  ].join('\n')
}

const addCalls = (recs: SessionRecord[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const r of recs) for (const [s, c] of Object.entries(r.mcpCalls)) out[s] = (out[s] ?? 0) + c
  return out
}

async function weekRecords($: EngineInterface, now: number): Promise<SessionRecord[]> {
  return windowOf(await listRecords($, now - 21 * DAY), now).week
}

const historyOf = (recs: SessionRecord[], now: number): History => {
  const since = Math.min(now, ...recs.map((r) => r.startedAt))
  return { mature: now - since >= MIN_HISTORY, since }
}

let tries = { id: '', n: 0 } // a failing or empty breakdown is tried at most twice per session
let judged = '' // the session whose heads-up has been decided (shown, or not due)

// Heads-up: decided once per session, but kept for a later turn while a more urgent event is on the band
// or a compaction is starting. The cheap gates come first; the week's records are read last.
async function maybeNotice($: EngineInterface, cfg: Config, rec: SessionRecord, snap: BaseSnapshot, ctx: TurnCtx): Promise<void> {
  if (cfg.healthMode === 'off' || !ctx.interactive || snap.total < NOTICE_TOTAL) return void (judged = rec.id)
  if (ctx.compacting) return
  const now = await $.clock.now()
  const last = await $.store.get('health:notice')
  if (typeof last === 'number' && now - last < NOTICE_EVERY) return void (judged = rec.id)
  if (!(await eventIsEmpty($))) return // keep the cooldown unspent; try again at a later turn
  const week = [...(await weekRecords($, now)).filter((r) => r.id !== rec.id), rec]
  const unusedMcp = unusedOf(snap, addCalls(week), historyOf(week, now).mature).reduce((s, [, v]) => s + v.tokens, 0)
  if (unusedMcp < NOTICE_MCP && snap.duplicate.tokens < DUP_TOKENS) return void (judged = rec.id)
  await $.store.set('health:notice', now)
  await setEvent($, { kind: 'health', total: snap.total, unusedMcp, duplicate: snap.duplicate.tokens })
  judged = rec.id
}

type TurnCtx = { interactive: boolean; compacting: boolean }

// Call last in the turn end. First main turn: take the snapshot once and save it; then the heads-up.
export async function healthAfterFirstTurn($: EngineInterface, cfg: Config, ctx: TurnCtx): Promise<void> {
  try {
    const rec = await current($)
    if (!rec.base) {
      if (tries.id !== rec.id) tries = { id: rec.id, n: 0 }
      if (tries.n++ >= 2) return
      const snap = await takeSnapshot($)
      if (!snap) return
      rec.base = snap
      await saveRecord($, rec)
    }
    if (judged !== rec.id) await maybeNotice($, cfg, rec, rec.base, ctx)
  } catch (err) {
    fail($, 'context health', err)
  }
}

// This session's snapshot, else the latest of the same project, else the latest overall.
export async function runHealth($: EngineInterface): Promise<{ text: string }> {
  const now = await $.clock.now()
  const rec = await current($)
  const week = [...(await weekRecords($, now)).filter((r) => r.id !== rec.id), rec]
  const byAt = week.filter((r) => r.base).sort((a, b) => b.base!.at - a.base!.at)
  const pick = rec.base ? rec : (byAt.find((r) => r.project === rec.project) ?? byAt[0])
  if (!pick?.base) return { text: "No snapshot yet: it's taken after the first reply of a session." }
  const calls = addCalls(week)
  const history = historyOf(week, now)
  return { text: `Snapshot from project ${pick.project}.\n\n${renderHealth(pick.base, healthAdvice(pick.base, calls, history), calls, history)}` }
}
