import type { BandEvent, Meter } from '../types/index'
import { longDay, shortDay, NOTICE_MCP, SEP } from './budget'

const k = (n: number): string => `${Math.floor(n / 1000)}k`

// The meter's palette: one colour per gauge, mid-tones that hold on a dark or a light theme.
// Red is only the mark at the start of the row, never a value.
export const TEAL = '#4FBFAF'
export const VIOLET = '#A58AE8'
export const GOLD = '#D6B16E'
const MARK = '#C8102E'
const GAP = '   '
const MAX_BAR = 14
const MIN_BAR = 4

export type Seg = { text: string; color?: string; dim?: boolean }

// One row of gauges laid out for `cols` cells: the bars shrink first, then the pace words go, then the bars.
export function meterSegs(m: Meter, cols: number): Seg[] {
  const p = m.pace
  const gauges = [{ label: 'context', fill: m.ctx / m.hard, value: k(m.ctx), color: TEAL }]
  if (p) gauges.push({ label: 'week', fill: p.weekly / 100, value: `${Math.floor(p.weekly)}%`, color: VIOLET })
  if (p && !p.stale)
    gauges.push({ label: 'today', fill: p.allowance > 0 ? p.today / p.allowance : 1, value: `${Math.floor(p.today)}% of ${Math.floor(p.allowance)}%`, color: GOLD })
  let tail = !p || p.stale ? '' : p.runsOutAt !== null ? `at this pace${SEP}lasts to ${shortDay(p.runsOutAt)}` : `on pace${SEP}lasts to ${shortDay(p.resetsAt)}`
  const fit = (): number => {
    const fixed = 2 + gauges.reduce((s, g) => s + g.label.length + g.value.length + 2, 0) + GAP.length * (gauges.length - 1) + (tail ? GAP.length + tail.length : 0)
    return Math.min(MAX_BAR, Math.floor((cols - fixed) / gauges.length))
  }
  let bar = fit()
  if (bar < MIN_BAR && tail) {
    tail = ''
    bar = fit()
  }
  if (bar < MIN_BAR) bar = 0
  const segs: Seg[] = [{ text: '\u258e ', color: MARK }]
  gauges.forEach((g, i) => {
    if (i) segs.push({ text: GAP })
    segs.push({ text: `${g.label} `, dim: true })
    if (bar) {
      const full = Math.max(0, Math.min(bar, Math.round(g.fill * bar)))
      segs.push({ text: '\u2501'.repeat(full), color: g.color }, { text: `${'\u2500'.repeat(bar - full)} `, dim: true })
    }
    segs.push({ text: g.value, color: g.color })
  })
  if (tail) segs.push({ text: GAP }, { text: tail, dim: true })
  return segs.filter((s) => s.text)
}

export function eventText(ev: Exclude<BandEvent, { kind: 'ask-compact' }>): string {
  if (ev.kind === 'compacted') return `compacted ${k(ev.before)} \u2192 ${k(ev.after)}${SEP}plan, decisions and open items kept`
  if (ev.kind === 'over-pace') return `today ${ev.today}% of ${ev.allowance}%${SEP}at this pace the week lasts to ${longDay(ev.runsOutAt)}${SEP}/longhaul shows where it went`
  return ev.unusedMcp >= NOTICE_MCP
    ? `sessions start at ${k(ev.total)}${SEP}${k(ev.unusedMcp)} of it is MCP tools unused this week${SEP}/longhaul health`
    : `sessions start at ${k(ev.total)}${SEP}${ev.duplicate} tokens of it repeat across memory files${SEP}/longhaul health`
}
