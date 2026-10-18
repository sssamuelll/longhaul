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
