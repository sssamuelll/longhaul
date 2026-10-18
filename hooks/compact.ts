import { atom, update, type EngineInterface } from 'claude-code'
import type { BandEvent } from '../types/index'
import type { CompactReason } from './ledger'
import { SEP, refreshMeter } from './budget'
import { current, fail, setCompactPending, setMainCtx, setFloor, takeAboveSoftLog } from './session'

export const KEEP_LIST =
  'Keep, in this order: the current plan and its next step; the decisions made and why; the files touched; open items and failing tests; anything the user corrected or asked for in this session.'

export const withKeepList = (instructions: string | undefined): string =>
  instructions ? `${instructions}\n${KEEP_LIST}` : KEEP_LIST

// The band reads this; the hooks write it.
export const eventAtom = atom({ plugin: 'longhaul', key: 'event' } as const, null)
export async function setEvent($: EngineInterface, ev: BandEvent | null): Promise<void> {
  await update($, eventAtom, () => ev)
}

// Decline flags: the band sets them (Task 8), register.ts reads them.
let declinedThisTask = false
let declinedHard = false
export const declineAsk = (hard: boolean): void => void (hard ? (declinedHard = true) : (declinedThisTask = true))
export const resetDeclines = (): void => void (declinedThisTask = false)
// Back under the hard limit: a later crossing asks again.
export const clearHardDecline = (): void => void (declinedHard = false)
export const declines = () => ({ declinedThisTask, declinedHard })

// The soft limit, set once by register; only used to word the one "still above" note.
let softLimit = Infinity
export const setSoftLimit = (n: number): void => void (softLimit = n)

export const REASON_LABEL: Record<CompactReason, string> = {
  'task-done': 'task finished',
  'new-task': 'new task',
  'hard-limit': 'hard limit',
  retry: 'retry',
  button: 'you asked',
  manual: '/compact',
  auto: 'Claude Code auto-compact',
}

const k = (n: number): string => `${Math.floor(n / 1000)}k`

type Compacted = { tokensBefore?: number; tokensAfter?: number; skip?: string }

// The one place a finished compaction is counted, drawn on the band and written back to the guard's
// view of the context. The session.compact hook calls it for manual/auto; compactNow for the plugin's own.
export async function afterCompact($: EngineInterface, trigger: string, r: Compacted, reason?: CompactReason): Promise<void> {
  if (r.skip !== undefined || !(trigger === 'manual' || trigger === 'auto' || trigger === 'plugin')) return
  const rec = await current($)
  rec.compactions[trigger]++
  const why: CompactReason = reason ?? (trigger === 'plugin' ? 'button' : trigger)
  const before = typeof r.tokensBefore === 'number' ? r.tokensBefore : undefined
  const sized = before !== undefined && typeof r.tokensAfter === 'number'
  rec.compactionLog.push({
    at: await $.clock.now().catch(() => Date.now()),
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
  const after = typeof r.tokensAfter === 'number' ? r.tokensAfter : 0
  setMainCtx(after) // the next step re-measures
  setFloor(after)
  if (typeof r.tokensAfter === 'number')
    try {
      await refreshMeter($) // the gauge shows the new size now, not at the next turn end
    } catch (err) {
      fail($, 'meter after compact', err)
    }
  if (after > softLimit && takeAboveSoftLog()) {
    try {
      $.ui.log('the conversation is still above the soft limit after compacting; raise soft_limit or trim CLAUDE.md and MCP servers', { to: 'transcript' })
    } catch {
      // a note must not break the count
    }
  }
  if (typeof r.tokensBefore === 'number' && typeof r.tokensAfter === 'number')
    await setEvent($, { kind: 'compacted', before: r.tokensBefore, after: r.tokensAfter })
}

// Claude Code 2.1.302 also runs the mod's own compaction through the mod's session.compact hook, as
// 'manual'. While one is in flight that hook passes it through, and it is counted here, once, for
// every caller (timers, the band button).
let selfCompacting = false
export const isSelfCompacting = (): boolean => selfCompacting

export async function compactNow($: EngineInterface, reason: CompactReason): Promise<void> {
  selfCompacting = true
  let r: Compacted
  try {
    r = await $.session.compact({ instructions: KEEP_LIST })
  } finally {
    selfCompacting = false
  }
  await afterCompact($, 'plugin', r, reason)
}
