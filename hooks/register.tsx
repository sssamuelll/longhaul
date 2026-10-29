import type { EngineInterface, Register } from 'claude-code'
import type { BandEvent, Meter } from '../types/index'
import { readConfig, type Config } from './config'
import { contextOf } from './prices'
import { KEEP_LIST, REASON_LABEL, withKeepList, buildCompactInstructions, setSoftLimit, getSoftLimit, declineAsk, resetDeclines, clearHardDecline, declines, isSelfCompacting, setSelfCompacting, type Compacted, type CompactContext } from './compact'
import { lastMainCtx, setMainCtx, setCompactPending, isCompactPending, setFloor, takeAboveSoftLog, newEpoch, epoch, peekRecord, setRecord, getFloor, getEpochFiles, addEpochFiles, clearEpochFiles } from './session'
import { emptyFacts, observeTool, isTaskDone, isNewTask, guardDecision, type TurnFacts } from './guard'
import { addStep, capRecord, lastActivity, newRecord, parse, projectOf, totalCost, MAX_RATE, SESSION_PREFIX, type CompactReason, type SessionRecord } from './ledger'
import { SEP, NOTICE_MCP, localDate, parseReset, pace } from './budget'
import { eventText, meterSegs } from './band'
import { buildReport, renderText, unusedServers, windowOf, type ReportData } from './report'
import { NOTICE_TOTAL, NOTICE_EVERY, DUP_TOKENS, snapshotOf, unusedOf, addCalls, historyOf, healthAdvice, renderHealth, type BaseSnapshot } from './health'
import { DEFAULT_RULES, parseRules, takeRulesWarn, type Rule } from './rules'
import { classify } from './classifier'
import { HANDOFF, ASK_HANDOFF, SUBAGENT_NOTE, REVIEW_TOOL, OUTCOMES, isExpensiveMain, noteEdit, applyReview, ageDecisions, getRules, setRules, clearMainEdited, resetHandoff } from './handoff'

const DAY = 86_400_000
const KEEP_DAYS = 21 // a session record this long without activity leaves the store

// Guard state, memory only: nothing about prompts is ever written down.
let facts: TurnFacts = emptyFacts()
let recent: string[] = []
let isInteractive = false // from session.start; only an interactive session may have a prompt dropped
let loggedKinds = false
let tries = { id: '', n: 0 } // a failing or empty breakdown is tried at most twice per session
let judged = '' // the session whose heads-up has been decided (shown, or not due)
let pending: Promise<SessionRecord> | null = null
let pendingId = ''

const k = (n: number): string => `${Math.floor(n / 1000)}k`

// Everything that takes $ is a top-level declaration here: the directory reads $ only in this form.

function fail($: EngineInterface, what: string, err: unknown): void {
  try {
    $.ui.log(`longhaul: ${what} failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  } catch {
    // logging must not break the session either
  }
}

// ---- the session record, kept in the plugin store ----

async function oldestOther($: EngineInterface, key: string): Promise<string | undefined> {
  const names = await $.store.keys()
  let victim: string | undefined
  let oldest = Infinity
  for (const name of names) {
    if (!name.startsWith(SESSION_PREFIX) || name === key) continue
    const stored = await $.store.get(name)
    const rec = parse(stored, newRecord('', '', 0))
    const t = rec ? lastActivity(rec) : 0 // an unreadable record goes first
    if (t < oldest) {
      oldest = t
      victim = name
    }
  }
  return victim
}

// The store holds 4 MiB in all: when it refuses, the oldest other session record makes room.
async function saveRecord($: EngineInterface, rec: SessionRecord): Promise<void> {
  capRecord(rec)
  const key = SESSION_PREFIX + rec.id
  const dropped = new Set<string>()
  for (;;) {
    try {
      await $.store.set(key, rec)
      return
    } catch (err) {
      const victim = await oldestOther($, key)
      if (victim === undefined || dropped.has(victim)) {
        fail($, 'save session record', err)
        return
      }
      dropped.add(victim)
      await $.store.delete(victim)
    }
  }
}

async function loadRecord($: EngineInterface, id: string, project: string, now: number): Promise<SessionRecord> {
  const fresh = newRecord(id, project, now)
  try {
    const stored = await $.store.get(SESSION_PREFIX + id)
    return (stored !== undefined && parse(stored, fresh)) || fresh
  } catch {
    return fresh
  }
}

// Records with activity at or after sinceMs; any older than KEEP_DAYS are deleted on the way.
async function listRecords($: EngineInterface, sinceMs: number): Promise<SessionRecord[]> {
  const now = await $.clock.now()
  let names: string[]
  try {
    names = await $.store.keys()
  } catch {
    return []
  }
  const out: SessionRecord[] = []
  for (const name of names) {
    if (!name.startsWith(SESSION_PREFIX)) continue
    try {
      const stored = await $.store.get(name)
      const rec = parse(stored, newRecord('', '', 0))
      if (!rec) continue
      const t = lastActivity(rec)
      if (t < now - KEEP_DAYS * DAY) await $.store.delete(name)
      else if (t >= sinceMs) out.push(rec)
    } catch {
      // unreadable record: skip it
    }
  }
  return out
}

async function switchTo($: EngineInterface, old: SessionRecord | null, id: string): Promise<SessionRecord> {
  if (old) await saveRecord($, old) // nothing in memory is discarded
  const cwd = await $.session.cwd()
  let now = Date.now()
  try {
    now = await $.clock.now()
  } catch {
    // the wall clock will do
  }
  const next = await loadRecord($, id, projectOf(cwd), now)
  setRecord(next)
  return next
}

// Concurrent callers (parallel subagents) share one in-flight load, so they share one record.
async function current($: EngineInterface): Promise<SessionRecord> {
  const id = await $.session.id()
  const have = peekRecord()
  if (have && have.id === id) return have
  if (!pending || pendingId !== id) {
    pendingId = id
    pending = switchTo($, have, id)
  }
  const p = pending
  try {
    return await p
  } finally {
    if (pending === p) pending = null
  }
}

// ---- the band's state ----

async function readEvent($: EngineInterface): Promise<BandEvent | null> {
  const s = await $.state.get({ plugin: 'longhaul', key: 'event' })
  return s.value ?? null
}

async function setEvent($: EngineInterface, ev: BandEvent | null): Promise<void> {
  await $.state.set({ plugin: 'longhaul', key: 'event' }, ev)
}

async function setMeter($: EngineInterface, m: Meter | null): Promise<void> {
  await $.state.set({ plugin: 'longhaul', key: 'meter' }, m)
}

// A compaction changes the context size: the gauge shows it now, not at the next turn end.
async function refreshMeter($: EngineInterface): Promise<void> {
  const s = await $.state.get({ plugin: 'longhaul', key: 'meter' })
  const m = s.value ?? null
  if (m) await $.state.set({ plugin: 'longhaul', key: 'meter' }, { ...m, ctx: lastMainCtx })
}

// A new main prompt ends whatever the band was showing. A prompt typed over an ask means "Not now".
async function clearBandOnPrompt($: EngineInterface): Promise<void> {
  const ev = await readEvent($)
  if (!ev) return
  if (ev.kind === 'ask-compact') declineAsk(ev.hard)
  await setEvent($, null)
}

// ---- compaction ----

function snapshotCompactContext(reason?: CompactReason): CompactContext {
  return {
    reason,
    editedFiles: getEpochFiles(),
    committed: facts.committed,
    testsPassed: facts.testsPassed,
    editedAfterTests: facts.editedAfterTests,
  }
}

// The one place a finished compaction is counted, drawn on the band and written back to the guard's
// view of the context. The session.compact hook calls it for manual/auto; compactNow for the plugin's own.
async function afterCompact($: EngineInterface, trigger: string, r: Compacted, reason?: CompactReason): Promise<void> {
  if (r.skip !== undefined || !(trigger === 'manual' || trigger === 'auto' || trigger === 'plugin')) return
  const rec = await current($)
  rec.compactions[trigger]++
  const why: CompactReason = reason ?? (trigger === 'plugin' ? 'button' : trigger)
  const before = typeof r.tokensBefore === 'number' ? r.tokensBefore : undefined
  const sized = before !== undefined && typeof r.tokensAfter === 'number'
  let at = Date.now()
  try {
    at = await $.clock.now()
  } catch {
    // the wall clock will do
  }
  rec.compactionLog.push({
    at,
    trigger,
    reason: why,
    ...(before !== undefined ? { before } : {}),
    ...(typeof r.tokensAfter === 'number' ? { after: r.tokensAfter } : {}),
  })
  try {
    $.ui.log(`compacted${sized ? ` ${k(before)} \u2192 ${k(r.tokensAfter as number)}` : ''}${SEP}${REASON_LABEL[why]}`, { to: 'transcript' })
  } catch {
    // a note must not break the count
  }
  setCompactPending(false)
  clearEpochFiles()
  facts = emptyFacts()
  const after = typeof r.tokensAfter === 'number' ? r.tokensAfter : 0
  setMainCtx(after) // the next step re-measures
  setFloor(after)
  if (typeof r.tokensAfter === 'number')
    try {
      await refreshMeter($) // the gauge shows the new size now, not at the next turn end
    } catch (err) {
      fail($, 'meter after compact', err)
    }
  if (after > getSoftLimit() && takeAboveSoftLog()) {
    try {
      $.ui.log('the conversation is still above the soft limit after compacting; raise soft_limit or trim CLAUDE.md and MCP servers', { to: 'transcript' })
    } catch {
      // a note must not break the count
    }
  }
  if (typeof r.tokensBefore === 'number' && typeof r.tokensAfter === 'number')
    await setEvent($, { kind: 'compacted', before: r.tokensBefore, after: r.tokensAfter })
}

async function compactNow($: EngineInterface, reason: CompactReason, ctx?: CompactContext): Promise<void> {
  setSelfCompacting(true)
  let r: Compacted
  try {
    r = await $.session.compact({ instructions: buildCompactInstructions({ ...ctx, reason }) })
  } finally {
    setSelfCompacting(false)
  }
  await afterCompact($, 'plugin', r, reason)
}

// ---- the weekly meter ----

// After each main turn: the meter, the rate point, and the once-a-day over-pace heads-up.
async function updateBudget($: EngineInterface, cfg: Config): Promise<void> {
  const off = cfg.budgetMode === 'off' // off hides the meter and the heads-up; the weekly reading is still recorded
  const usage = await $.session.usage()
  if (!loggedKinds) {
    loggedKinds = true
    $.ui.log(`longhaul: rate limit kinds: ${usage.rateLimits.map((r) => r.kind).join(', ') || 'none'}`, { to: 'debug' })
  }
  const seven = usage.rateLimits.find((r) => r.kind === 'seven_day') ?? usage.rateLimits.find((r) => /seven|7|week/i.test(r.kind))
  const resetsAt = parseReset(seven?.resetsAt)
  if (!seven || resetsAt === null) {
    await setMeter($, off ? null : { ctx: lastMainCtx, hard: cfg.hardLimit, pace: null })
    return
  }
  const now = await $.clock.now()
  const date = localDate(now)
  const percent = seven.percentUsed
  const key = `day:${date}`
  let midnight = await $.store.get(key)
  if (typeof midnight !== 'number') {
    midnight = percent
    await $.store.set(key, percent)
  } else if (percent < midnight) {
    midnight = 0 // the week reset after the snapshot
    await $.store.set(key, 0)
  }
  const rec = await current($)
  if (rec.rate.at(-1)?.[1] !== percent) {
    rec.rate.push([now, percent, totalCost(rec.cost)])
    rec.rate = rec.rate.slice(-MAX_RATE)
  }
  rec.weekResetsAt = seven.resetsAt
  const p = pace({ percent, resetsAt, now, midnightPercent: midnight as number })
  await setMeter($, off ? null : { ctx: lastMainCtx, hard: cfg.hardLimit, pace: { ...p, stale: resetsAt <= now } })
  if (!off && resetsAt > now && p.runsOutAt !== null && p.today > p.allowance * 1.5) {
    const warned = await $.store.get(`warned:${date}`)
    if (!warned) {
      await $.store.set(`warned:${date}`, true)
      await setEvent($, { kind: 'over-pace', today: Math.floor(p.today), allowance: Math.floor(p.allowance), runsOutAt: p.runsOutAt })
    }
  }
}

async function budgetAfterTurn($: EngineInterface, cfg: Config): Promise<void> {
  try {
    await updateBudget($, cfg)
  } catch (err) {
    fail($, 'budget', err)
  }
}

// ---- context health ----

// The free local estimate of what a session loads before any work. Null when there is none.
async function takeSnapshot($: EngineInterface): Promise<BaseSnapshot | null> {
  const usage = await $.session.usage({ breakdown: 'summary' })
  const b = usage?.context?.breakdown
  if (!b) return null
  const texts = new Map<string, string>()
  for (const m of b.memoryFiles ?? []) {
    if (texts.has(m.path)) continue
    try {
      const text = await $.fs.read(m.path)
      if (typeof text === 'string') texts.set(m.path, text)
    } catch {
      // unreadable: counted by the breakdown, not scanned
    }
  }
  const at = await $.clock.now()
  return snapshotOf(b, texts, at)
}

async function weekRecords($: EngineInterface, now: number): Promise<SessionRecord[]> {
  const all = await listRecords($, now - KEEP_DAYS * DAY)
  return windowOf(all, now).week
}

type TurnCtx = { interactive: boolean; compacting: boolean }

// Heads-up: decided once per session, but kept for a later turn while a more urgent event is on the band
// or a compaction is starting. The cheap gates come first; the week's records are read last.
async function maybeNotice($: EngineInterface, cfg: Config, rec: SessionRecord, snap: BaseSnapshot, ctx: TurnCtx): Promise<void> {
  if (cfg.healthMode === 'off' || !ctx.interactive || snap.total < NOTICE_TOTAL) return void (judged = rec.id)
  if (ctx.compacting) return
  const now = await $.clock.now()
  const last = await $.store.get('health:notice')
  if (typeof last === 'number' && now - last < NOTICE_EVERY) return void (judged = rec.id)
  const shown = await readEvent($)
  if (shown !== null) return // keep the cooldown unspent; try again at a later turn
  const stored = await weekRecords($, now)
  const week = [...stored.filter((r) => r.id !== rec.id), rec]
  const unusedMcp = unusedOf(snap, addCalls(week), historyOf(week, now).mature).reduce((s, [, v]) => s + v.tokens, 0)
  if (unusedMcp < NOTICE_MCP && snap.duplicate.tokens < DUP_TOKENS) return void (judged = rec.id)
  await $.store.set('health:notice', now)
  await setEvent($, { kind: 'health', total: snap.total, unusedMcp, duplicate: snap.duplicate.tokens })
  judged = rec.id
}

// Call last in the turn end. First main turn: take the snapshot once and save it; then the heads-up.
async function healthAfterFirstTurn($: EngineInterface, cfg: Config, ctx: TurnCtx): Promise<void> {
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
async function runHealth($: EngineInterface): Promise<{ text: string }> {
  const now = await $.clock.now()
  const rec = await current($)
  const stored = await weekRecords($, now)
  const week = [...stored.filter((r) => r.id !== rec.id), rec]
  const byAt = week.filter((r) => r.base).sort((a, b) => b.base!.at - a.base!.at)
  const pick = rec.base ? rec : (byAt.find((r) => r.project === rec.project) ?? byAt[0])
  if (!pick?.base) return { text: "No snapshot yet: it's taken after the first reply of a session." }
  const calls = addCalls(week)
  const history = historyOf(week, now)
  return { text: `Snapshot from project ${pick.project}.\n\n${renderHealth(pick.base, healthAdvice(pick.base, calls, history), calls, history)}` }
}

// ---- the report ----

async function reportFor($: EngineInterface, cfg: Config): Promise<ReportData> {
  const now = await $.clock.now()
  const records = await listRecords($, now - KEEP_DAYS * DAY)
  let unused: string[] = []
  try {
    const tools = await $.tool.list()
    unused = unusedServers(tools.map((t) => t.name), windowOf(records, now).week)
  } catch (err) {
    fail($, 'list tools for report', err)
  }
  return buildReport(records, now, unused, cfg)
}

async function runReport($: EngineInterface, cfg: Config): Promise<{ text: string }> {
  const d = await reportFor($, cfg)
  return { text: renderText(d) }
}

async function registerReport($: EngineInterface): Promise<void> {
  try {
    await $.command.register({ name: 'longhaul', description: "Where this week's tokens went and why", argumentHint: '[health]' })
  } catch (err) {
    fail($, 'register longhaul command', err)
  }
}

// ---- Sonnet handoffs ----

// The rules file named in the options replaces the built-in rules; no file is ever written.
async function loadRules($: EngineInterface, cfg: Config): Promise<Rule[]> {
  const file = cfg.rulesFile
  if (!file) return DEFAULT_RULES
  let text: string
  try {
    text = await $.fs.read(file)
  } catch {
    if (takeRulesWarn()) $.ui.log(`longhaul: could not read the rules file ${file}; using the built-in rules`, { to: 'debug' })
    return DEFAULT_RULES
  }
  const rules = parseRules(text)
  if (!rules) {
    if (takeRulesWarn()) $.ui.log(`longhaul: the rules file ${file} is not a valid rules array; using the built-in rules`, { to: 'debug' })
    return DEFAULT_RULES
  }
  return rules
}

// New main prompt: age pending decisions, then classify. Returns the context to attach, if any.
async function handoffContext($: EngineInterface, cfg: Config, text: string): Promise<string | undefined> {
  try {
    const rec = await current($)
    ageDecisions(rec)
    if (cfg.classifierMode === 'off') return undefined
    let rules = getRules()
    if (!rules) {
      rules = await loadRules($, cfg)
      setRules(rules)
    }
    const r = classify(text, rules)
    if (r.verdict !== 'sonnet') return undefined
    const model = await $.session.model()
    if (!isExpensiveMain(model)) return undefined
    const at = await $.clock.now()
    rec.decisions.push({ at, verdict: 'sonnet', ruleIds: r.ruleIds, mode: cfg.classifierMode, outcome: 'pending', subFiles: [], turnsSince: 0 })
    clearMainEdited()
    return cfg.classifierMode === 'ask' ? ASK_HANDOFF : HANDOFF
  } catch (err) {
    fail($, 'handoff', err)
    return undefined
  }
}

async function registerReview($: EngineInterface): Promise<void> {
  try {
    await $.tool.register({
      name: 'review',
      description: 'Record how a Sonnet handoff went after you reviewed it.',
      inputSchema: { type: 'object', properties: { outcome: { type: 'string', enum: [...OUTCOMES] } }, required: ['outcome'] },
      isDeferred: true,
    })
  } catch (err) {
    fail($, 'register review tool', err)
  }
}

// ---- the guard ----

// New session or /clear: forget everything the guard knew; timers of the old one become no-ops.
function resetGuard(): void {
  newEpoch()
  facts = emptyFacts()
  recent = []
  resetDeclines()
  clearHardDecline()
  resetHandoff()
}

// Turn end, main loop: compact or ask once the task is done, or at the hard limit.
// Compacting runs from a timer so the turn is never held; a rejection there leaves a pending flag.
async function atTurnEnd($: EngineInterface, cfg: Config): Promise<string> {
  if (lastMainCtx < cfg.hardLimit) clearHardDecline()
  const act = guardDecision({
    mode: cfg.guardMode,
    ctx: lastMainCtx,
    floor: getFloor(),
    soft: cfg.softLimit,
    hard: cfg.hardLimit,
    at: 'turn-end',
    taskDone: isTaskDone(facts),
    newTask: false,
    ...declines(),
  })
  if (act === 'ask') await setEvent($, { kind: 'ask-compact', hard: lastMainCtx >= cfg.hardLimit })
  else if (act === 'compact-at-turn-end') {
    const ep = epoch()
    const reason: CompactReason = lastMainCtx >= cfg.hardLimit ? 'hard-limit' : 'task-done' // decided now, not when the timer fires
    const snap = snapshotCompactContext(reason)
    $.clock.after(0, () => void compactTimer($, ep, reason, snap))
  }
  return act
}

async function compactTimer($: EngineInterface, ep: number, reason: CompactReason, ctx?: CompactContext): Promise<void> {
  if (ep !== epoch()) return
  try {
    await compactNow($, reason, ctx)
  } catch (err) {
    setCompactPending(true) // the next prompt compacts first
    fail($, 'compact at turn end', err)
  }
}

// Interactive new-task prompt: the hook has already returned { drop }; compact, then send the text again.
async function compactThenSubmit($: EngineInterface, text: string, ep: number, reason: CompactReason, ctx?: CompactContext): Promise<void> {
  if (ep !== epoch()) return
  try {
    await compactNow($, reason, ctx)
  } catch (err) {
    fail($, 'compact before prompt', err)
  }
  setCompactPending(false) // whatever happened: a failing summariser must not drop every prompt
  if (ep !== epoch()) return
  try {
    await $.prompt.submit({ text, asUser: true }) // skips this plugin's own prompt.submit hook
    // the drop put the text back in the box; clear it unless the person has typed since
    if ((await $.prompt.read()).text.trim() === text.trim()) await $.prompt.fill({ text: '' })
  } catch (err) {
    fail($, 'resubmit after compact', err)
    try {
      await $.prompt.fill({ text })
      $.ui.log("couldn't resend your prompt; it's back in the box", { to: 'transcript' })
    } catch (err2) {
      fail($, 'refill prompt', err2)
    }
  }
}

// New main prompt: maybe compact first. Returns a drop reason when the prompt was held back.
// Never drops in a non-interactive session, or when `canDrop` is false; the turn-end path handles those.
async function atPrompt($: EngineInterface, cfg: Config, text: string, canDrop: boolean): Promise<string | undefined> {
  const waiting = isCompactPending() && cfg.guardMode !== 'off'
  const newTask = isNewTask(text, recent)
  const act = waiting
    ? 'compact-before-prompt'
    : guardDecision({
        mode: cfg.guardMode,
        ctx: lastMainCtx,
        floor: getFloor(),
        soft: cfg.softLimit,
        hard: cfg.hardLimit,
        at: 'prompt',
        taskDone: false,
        newTask,
        ...declines(),
      })
  const prevSnap = snapshotCompactContext()
  recent = [...recent, text].slice(-3)
  if (newTask) clearEpochFiles()
  facts = emptyFacts()
  resetDeclines()
  if (act !== 'compact-before-prompt' || !isInteractive || !canDrop) return undefined
  const ep = epoch()
  const reason: CompactReason = waiting ? 'retry' : lastMainCtx >= cfg.hardLimit ? 'hard-limit' : 'new-task'
  $.clock.after(0, () => void compactThenSubmit($, text, ep, reason, { ...prevSnap, reason }))
  return 'longhaul: compacting before the new task'
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  setSoftLimit(cfg.softLimit)

  // The band: the latest event in calm grey, and under it, right above the prompt, the meter row.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const shown = await $.state.get({ plugin: 'longhaul', key: 'event' })
    const meter = await $.state.get({ plugin: 'longhaul', key: 'meter' })
    const ev = shown.value ?? null
    const m = meter.value ?? null
    const { Box, Button, Text } = $.ui.resolve(e)
    const rows = []
    if (ev && ev.kind !== 'ask-compact') rows.push(<Text dimColor>{eventText(ev)}</Text>)
    else if (ev?.kind === 'ask-compact' && !e.props.isWorking)
      // the ask waits for an idle prompt
      rows.push(
        <Box>
          <Text dimColor>{`a good moment to compact${SEP}keeps the plan, decisions and open items `}</Text>
          <Button
            key="compact"
            label="Compact now"
            onPress={async () => {
              try {
                await compactNow($, 'button', snapshotCompactContext('button'))
                const now = await readEvent($)
                if (now?.kind === 'ask-compact') await setEvent($, null)
              } catch (err) {
                fail($, 'compact from band', err)
              }
            }}
          />
          <Button
            key="later"
            label="Not now"
            onPress={async () => {
              declineAsk(ev.hard)
              await setEvent($, null)
            }}
          />
        </Box>,
      )
    if (m)
      rows.push(
        <Text wrap="truncate-end">
          {meterSegs(m, e.props.bodyColumns ?? 120).map((s) => (
            <Text {...(s.color ? { color: s.color } : {})} {...(s.dim ? { dimColor: true } : {})}>
              {s.text}
            </Text>
          ))}
        </Text>,
      )
    if (!rows.length) return next(e)
    return <Box flexDirection="column">{rows}</Box>
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      if (r.usage) {
        const sub = Boolean(e.agentId)
        const rec = await current($)
        addStep(rec, r.usage.model, r.usage, sub)
        if (!sub) setMainCtx(contextOf(r.usage))
      }
    } catch (err) {
      fail($, 'turn.step', err)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!e.agentId && !('deny' in r && r.deny)) {
        facts = observeTool(facts, { tool: e.tool, input: e.input as Record<string, unknown>, ...('isError' in r && r.isError ? { isError: true as const } : {}) })
        addEpochFiles(facts.editedFiles)
      }
      if (!('deny' in r && r.deny)) {
        const rec = await current($)
        noteEdit(rec, { tool: e.tool, input: e.input, ...(e.agentId ? { agentId: e.agentId } : {}) })
      }
      const m = /^mcp__(.+?)__/.exec(e.tool)
      if (m) {
        const rec = await current($)
        rec.mcpCalls[m[1]] = (rec.mcpCalls[m[1]] ?? 0) + 1
      }
    } catch (err) {
      fail($, 'tool.call', err)
    }
    return r
  })

  on('tool.call', { tool: REVIEW_TOOL }, async ($, e) => {
    try {
      const rec = await current($)
      return applyReview(rec, e.input)
    } catch (err) {
      fail($, 'review', err)
      return { deny: 'longhaul: could not record the outcome.' }
    }
  })

  // On Opus or Fable, the system prompt asks for Sonnet subagents on execution work.
  on('prompt.compose', async ($, e, next) => {
    if (cfg.classifierMode === 'off' || !isExpensiveMain(e.model) || !e.tools.includes('Agent')) return next(e)
    const r = await next(e)
    return { sections: [...r.sections, { id: 'longhaul:subagents', text: SUBAGENT_NOTE, scope: 'session' as const }] }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      await budgetAfterTurn($, cfg) // before the save, so this turn's rate point is in the store
      try {
        const rec = await current($)
        await saveRecord($, rec)
      } catch (err) {
        fail($, 'turn.complete', err)
      }
      if (e.isAborted) {
        await healthAfterFirstTurn($, cfg, { interactive: isInteractive, compacting: false }) // an interrupted turn is no safe moment for the guard
        return r
      }
      let act = ''
      try {
        act = await atTurnEnd($, cfg)
      } catch (err) {
        fail($, 'guard at turn end', err)
      }
      // last: its heads-up never replaces a more urgent event, nor lands as a compaction starts
      await healthAfterFirstTurn($, cfg, { interactive: isInteractive, compacting: act === 'compact-at-turn-end' })
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    // other plugins' prompts, commands and meta prompts pass untouched
    if (e.command || e.isMeta || e.turnId || e.origin?.kind === 'plugin') return next(e)
    // classify first: a handoff prompt is never held back, its compaction waits for the turn end
    const note = await handoffContext($, cfg, e.text)
    let drop: string | undefined
    try {
      drop = await atPrompt($, cfg, e.text, !note && !e.attachments?.length)
    } catch (err) {
      fail($, 'prompt.submit', err)
    }
    try {
      await clearBandOnPrompt($)
    } catch (err) {
      fail($, 'clear band', err)
    }
    if (drop) return { drop }
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    resetGuard()
    $.ui.status(undefined) // clears the plain status line an earlier build pinned; the meter is in the band now
    await registerReview($)
    await registerReport($)
    return next(e)
  })

  on('command.run', { command: 'longhaul' }, async ($, e) => {
    try {
      const args = (e.args ?? '').trim().toLowerCase()
      if (args === 'health') return await runHealth($)
      return await runReport($, cfg)
    } catch (err) {
      fail($, 'longhaul report', err)
      return { text: 'longhaul: could not build the report.' }
    }
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId || isSelfCompacting()) return next(e) // a subagent's, or the mod's own: no keep-list, not counted here
    const reason: CompactReason | undefined = e.trigger === 'manual' || e.trigger === 'auto' ? e.trigger : undefined
    const r = await next({ ...e, instructions: withKeepList(e.instructions, snapshotCompactContext(reason)) })
    try {
      await afterCompact($, e.trigger, r, reason)
    } catch (err) {
      fail($, 'session.compact', err)
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    try {
      const rec = peekRecord()
      if (rec) await saveRecord($, rec)
    } catch (err) {
      fail($, 'session.end', err)
    }
    if (e.reason === 'clear') resetGuard()
    return r
  })
}
