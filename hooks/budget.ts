import { atom, update, type EngineInterface } from 'claude-code'
import type { Meter } from '../types/index'
import type { Config } from './config'
import { setEvent } from './compact'
import { current, fail, lastMainCtx } from './session'
import { totalCost, MAX_RATE } from './ledger'

const DAY = 86_400_000
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

// U+00B7, written as an escape so no editor or shell encoding can corrupt it.
export const SEP = ' \u00b7 '

// Unused MCP tokens at which the context-health heads-up is worth a line.
export const NOTICE_MCP = 10_000

// Too early in the week the rate says nothing: no projection before this much of it has passed.
const MIN_PROJECT = 6 * 3_600_000

export type Pace = { weekly: number; today: number; allowance: number; resetsAt: number; runsOutAt: number | null }

export const shortDay = (t: number): string => SHORT[new Date(t).getDay()]
export const longDay = (t: number): string => LONG[new Date(t).getDay()]

// Local YYYY-MM-DD.
export function localDate(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function pace(i: { percent: number; resetsAt: number; now: number; midnightPercent: number }): Pace {
  const start = i.resetsAt - 7 * DAY
  const elapsed = i.now - start
  const left = (i.resetsAt - i.now) / DAY
  const room = Math.max(0, 100 - i.percent)
  const allowance = left > 0 ? Math.min(room, room / left) : 0
  const out = i.percent > 0 && elapsed >= MIN_PROJECT ? start + (100 / i.percent) * elapsed : null
  return {
    weekly: i.percent,
    today: Math.max(0, i.percent - i.midnightPercent),
    allowance,
    resetsAt: i.resetsAt,
    runsOutAt: out !== null && out <= i.resetsAt ? out : null,
  }
}

// resetsAt is an ISO string; an epoch-seconds string is accepted too.
export function parseReset(s: string | undefined): number | null {
  if (!s) return null
  const n = /^\d+(\.\d+)?$/.test(s) ? Number(s) * 1000 : Date.parse(s)
  return Number.isFinite(n) ? n : null
}

let loggedKinds = false

// What the band's meter row draws; band.tsx spells the same atom, as the engine needs in the file that reads it.
const meterAtom = atom({ plugin: 'longhaul', key: 'meter' } as const, null)

async function setMeter($: EngineInterface, m: Meter | null): Promise<void> {
  await update($, meterAtom, () => m)
}

// A compaction changes the context size: the gauge shows it now, not at the next turn end.
export async function refreshMeter($: EngineInterface): Promise<void> {
  await update($, meterAtom, (m) => (m ? { ...m, ctx: lastMainCtx } : m))
}

// After each main turn: the meter, the rate point, and the once-a-day over-pace heads-up.
export async function updateBudget($: EngineInterface, cfg: Config): Promise<void> {
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
  if (!off && resetsAt > now && p.runsOutAt !== null && p.today > p.allowance * 1.5 && !(await $.store.get(`warned:${date}`))) {
    await $.store.set(`warned:${date}`, true)
    await setEvent($, { kind: 'over-pace', today: Math.floor(p.today), allowance: Math.floor(p.allowance), runsOutAt: p.runsOutAt })
  }
}

export async function budgetAfterTurn($: EngineInterface, cfg: Config): Promise<void> {
  try {
    await updateBudget($, cfg)
  } catch (err) {
    fail($, 'budget', err)
  }
}
