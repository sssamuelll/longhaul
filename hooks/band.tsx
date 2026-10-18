import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { BandEvent, Meter } from '../types/index'
import { setEvent, compactNow, declineAsk } from './compact'
import { fail } from './session'
import { longDay, shortDay, NOTICE_MCP, SEP } from './budget'

// Same references as compact.ts's and budget.ts's atoms: the module scan needs them spelled in the file that reads them.
const eventAtom = atom({ plugin: 'longhaul', key: 'event' } as const, null)
const meterAtom = atom({ plugin: 'longhaul', key: 'meter' } as const, null)

const k = (n: number): string => `${Math.floor(n / 1000)}k`

// A new main prompt ends whatever the band was showing. A prompt typed over an ask means "Not now".
// Lives here because the engine only lets the file that declares the atom read it.
export async function clearBandOnPrompt($: EngineInterface): Promise<void> {
  const ev = await read($, eventAtom)
  if (!ev) return
  if (ev.kind === 'ask-compact') declineAsk(ev.hard)
  await setEvent($, null)
}

export async function eventIsEmpty($: EngineInterface): Promise<boolean> {
  return (await read($, eventAtom)) === null
}

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

function eventText(ev: Exclude<BandEvent, { kind: 'ask-compact' }>): string {
  if (ev.kind === 'compacted') return `compacted ${k(ev.before)} \u2192 ${k(ev.after)}${SEP}plan, decisions and open items kept`
  if (ev.kind === 'over-pace') return `today ${ev.today}% of ${ev.allowance}%${SEP}at this pace the week lasts to ${longDay(ev.runsOutAt)}${SEP}/longhaul shows where it went`
  return ev.unusedMcp >= NOTICE_MCP
    ? `sessions start at ${k(ev.total)}${SEP}${k(ev.unusedMcp)} of it is MCP tools unused this week${SEP}/longhaul health`
    : `sessions start at ${k(ev.total)}${SEP}${ev.duplicate} tokens of it repeat across memory files${SEP}/longhaul health`
}

// The band: the latest event in calm grey, and under it, right above the prompt, the meter row.
export const registerBand: Register = (on) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const ev = await read($, eventAtom)
    const m = await read($, meterAtom)
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
                await compactNow($, 'button')
                if ((await read($, eventAtom))?.kind === 'ask-compact') await setEvent($, null)
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
}
