import type { EngineInterface } from 'claude-code'
import type { Config } from './config'
import { listRecords, totalCost, dataDir, type SessionRecord } from './ledger'
import { PRICES_AS_OF, type Bucket } from './prices'
import { parseReset, SEP } from './budget'
import { fail } from './session'
import { REASON_LABEL } from './compact'
import type { CompactReason } from './ledger'

const DAY = 86_400_000
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const EST = ' (est.)'
const GUESS_LIMIT = 200_000 // the context size the guard suggestion points at

// Weekly rise that no local session's cost can account for: other devices, the web, or time between sessions.
export const ELSEWHERE = '(elsewhere)'

export type Share = { points: number; percent: number }
type Line = { kind: 'text' | 'bullet' | 'sub'; text: string }
type Section = { title: string; lines: Line[] }
export type ReportData = {
  where: { read: number; newContext: number; output: number } // whole percent of total cost
  sections: Section[]
  footer: string
}

// Weekly percent each session is credited with. Each rise between consecutive points of the merged
// timeline is split by how much each session's cost grew in that interval (interpolated between the
// session's own points); a rise with no growth anywhere goes to ELSEWHERE.
export function measuredShares(records: SessionRecord[]): Record<string, Share> {
  const out: Record<string, Share> = {}
  const pts = records.flatMap((r) => r.rate.map(([at, pct, cum]) => ({ id: r.id, at, pct, cum })))
  pts.sort((a, b) => a.at - b.at || a.pct - b.pct)
  const own = new Map(records.map((r) => [r.id, [...r.rate].sort((a, b) => a[0] - b[0])]))
  const cumAt = (id: string, t: number): number => {
    const p = own.get(id) ?? []
    if (!p.length) return 0
    if (t <= p[0][0]) return p[0][2]
    for (let i = 1; i < p.length; i++) {
      if (t <= p[i][0]) {
        const [a, , ca] = p[i - 1]
        const [b, , cb] = p[i]
        return b === a ? cb : ca + ((cb - ca) * (t - a)) / (b - a)
      }
    }
    return p[p.length - 1][2]
  }
  const ids = [...own.keys()]
  for (let i = 1; i < pts.length; i++) {
    const rise = pts[i].pct - pts[i - 1].pct
    if (rise <= 0) continue // a drop is a reset
    const t0 = pts[i - 1].at
    const t1 = pts[i].at
    const grew = ids.map((id) => [id, Math.max(0, cumAt(id, t1) - cumAt(id, t0))] as const).filter(([, g]) => g > 0)
    const sum = grew.reduce((s, [, g]) => s + g, 0)
    const split = sum > 0 ? grew.map(([id, g]) => [id, (rise * g) / sum] as const) : [[ELSEWHERE, rise] as const]
    for (const [id, part] of split) {
      const s = (out[id] ??= { points: 0, percent: 0 })
      s.percent += part
      s.points += Math.floor(rise)
    }
  }
  return out
}

const pct = (x: number, of: number): number => (of > 0 ? Math.round((x / of) * 100) : 0)
const money = (n: number): string => `$${n.toFixed(2)}`
const k = (n: number): string => `${Math.floor(n / 1000)}k`
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
const stamp = (t: number): string => {
  const d = new Date(t)
  return `${WEEKDAY[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const BUCKETS: [Bucket, string][] = [
  ['lt100k', 'under 100k tokens'],
  ['100to200k', '100k to 200k'],
  ['200to400k', '200k to 400k'],
  ['gt400k', 'over 400k'],
]

// The week's records: window from the latest reset minus 7 days, else the last 7 days.
// A reset already in the past is moved forward by whole weeks, so the window is [reset - 7d, reset).
export function windowOf(records: SessionRecord[], now: number): { week: SessionRecord[]; resetsAt: number | null; start: number; end: number } {
  const resets = records.map((r) => parseReset(r.weekResetsAt)).filter((n): n is number => n !== null)
  let resetsAt: number | null = resets.length ? Math.max(...resets) : null
  if (resetsAt !== null && resetsAt <= now) resetsAt += Math.ceil((now - resetsAt + 1) / (7 * DAY)) * 7 * DAY
  const start = (resetsAt ?? now) - 7 * DAY
  const end = resetsAt ?? Infinity
  const week = records.filter((r) => {
    const t = Math.max(r.startedAt, r.rate.at(-1)?.[0] ?? 0)
    return t >= start && t < end
  })
  return { week, resetsAt, start, end }
}

// `unusedServers` are preformatted ("name (N tools)"); `cfg` is only needed for the guard suggestion.
export function buildReport(
  records: SessionRecord[],
  now: number,
  unusedServers: string[],
  cfg?: Pick<Config, 'guardMode' | 'softLimit'>,
): ReportData {
  const { week, resetsAt, start, end } = windowOf(records, now)

  const sum = { input: 0, write: 0, read: 0, output: 0 }
  const buckets: Record<Bucket, number> = { lt100k: 0, '100to200k': 0, '200to400k': 0, gt400k: 0 }
  for (const r of week) {
    for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += r.cost[key]
    for (const b of Object.keys(buckets) as Bucket[]) buckets[b] += r.byBucket[b]
  }
  const total = totalCost(sum)
  const main = Object.values(buckets).reduce((a, b) => a + b, 0)
  const where = {
    read: pct(sum.read, total),
    newContext: pct(sum.write + sum.input, total),
    output: pct(sum.output, total),
  }

  // only meter readings inside the week feed the measured figures, as for the headline
  const inside = week.map((r) => ({ ...r, rate: r.rate.filter(([at]) => at >= start && at < end) }))
  const shares = measuredShares(inside)
  const inWindow = inside.flatMap((r) => r.rate.map(([, p]) => p))
  const measuredTotal = Object.values(shares).reduce((s, x) => s + x.percent, 0)
  const sections: Section[] = []

  const head: Line[] = []
  if (inWindow.length) {
    const latest = Math.max(...inWindow)
    head.push({ kind: 'text', text: `Used ${Math.floor(latest)}% of the weekly limit${resetsAt !== null ? `, resets ${stamp(resetsAt)}` : ''}.` })
  } else head.push({ kind: 'text', text: 'Weekly figures need a Pro or Max plan.' })
  head.push({ kind: 'text', text: `About ${money(total)} at API prices across ${plural(week.length, 'session')} (an equivalent, not a bill)${EST}` })
  sections.push({ title: 'This week', lines: head })

  sections.push({
    title: 'Where it went',
    lines: [
      { kind: 'bullet', text: `${where.read}% re-reading earlier context (cache reads)${EST}` },
      { kind: 'bullet', text: `${where.newContext}% new context (cache writes and fresh input)${EST}` },
      { kind: 'bullet', text: `${where.output}% output${EST}` },
    ],
  })

  sections.push({
    title: 'Why',
    lines: [
      { kind: 'text', text: 'Cost by context size, main session:' },
      ...BUCKETS.map(([b, name]) => ({ kind: 'bullet' as const, text: `${pct(buckets[b], main)}% at ${name}${EST}` })),
    ],
  })

  const top = [...week].sort((a, b) => totalCost(b.cost) - totalCost(a.cost)).slice(0, 5)
  const bigLines: Line[] = []
  for (const r of top) {
    const comp = r.compactions.auto + r.compactions.manual + r.compactions.plugin
    bigLines.push({
      kind: 'bullet',
      text: `${r.project}${SEP}${stamp(r.startedAt)}${SEP}${pct(totalCost(r.cost), total)}% of cost${SEP}${plural(r.steps, 'step')}${SEP}peak ${k(r.peakCtx)}${SEP}${plural(comp, 'compaction')}${EST}`,
    })
    const m = shares[r.id]
    if (m) bigLines.push({ kind: 'sub', text: `measured: ${m.percent.toFixed(1)}% of the week, from ${plural(m.points, 'point')}` })
  }
  const away = shares[ELSEWHERE]
  if (away && away.percent > 0)
    bigLines.push({ kind: 'bullet', text: `elsewhere or between sessions: ${away.percent.toFixed(1)}% of the week, from ${plural(away.points, 'point')}` })
  if (!top.length) bigLines.push({ kind: 'text', text: 'No sessions recorded yet.' })
  else if (measuredTotal > 0) bigLines.push({ kind: 'text', text: `Measured across all sessions: ${measuredTotal.toFixed(1)}% of the week.` })
  sections.push({ title: 'Biggest sessions', lines: bigLines })

  const decisions = week.flatMap((r) => r.decisions)
  const count = (o: string): number => decisions.filter((d) => d.outcome === o).length
  sections.push({
    title: 'Sonnet handoffs',
    lines: [
      {
        kind: 'text',
        text: decisions.length
          ? `${plural(decisions.length, 'handoff')}: ${count('accepted')} accepted, ${count('fixed')} fixed, ${count('redone')} redone, ${count('unreported')} not reported.`
          : 'No handoffs this week.',
      },
    ],
  })

  const log = week.flatMap((r) => r.compactionLog)
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  }
  const compLines: Line[] = []
  if (!log.length) compLines.push({ kind: 'text', text: 'No compactions this week.' })
  else {
    const by = (Object.keys(REASON_LABEL) as CompactReason[])
      .map((r) => [r, log.filter((e) => e.reason === r).length] as const)
      .filter(([, n]) => n > 0)
    compLines.push({ kind: 'text', text: `${plural(log.length, 'compaction')}: ${by.map(([r, n]) => `${n} ${REASON_LABEL[r]}`).join(', ')}.` })
    const sized = log.filter((e) => typeof e.before === 'number' && typeof e.after === 'number')
    if (sized.length)
      compLines.push({ kind: 'text', text: `Typically ${k(median(sized.map((e) => e.before as number)))} down to ${k(median(sized.map((e) => e.after as number)))}.` })
    const hard = week.filter((r) => r.compactionLog.some((e) => e.reason === 'hard-limit')).length
    if (hard) compLines.push({ kind: 'text', text: `${plural(hard, 'session')} reached the hard limit.` })
  }
  sections.push({ title: 'Compactions', lines: compLines })

  // Fix first: only what applies, biggest estimated saving first.
  const fixes: string[] = []
  if (cfg && (cfg.guardMode === 'off' || cfg.softLimit > 300_000)) {
    const above = pct(buckets['200to400k'] + buckets.gt400k, main)
    if (above > 0) {
      const what = cfg.guardMode === 'off' ? 'Turn the context guard on' : `Lower soft_limit from ${k(cfg.softLimit)}`
      fixes.push(`${what} so sessions compact near ${k(GUESS_LIMIT)}: ${above}% of main-session cost sat above that${EST}`)
    }
  }
  const byRule = new Map<string, { decided: number; redone: number }>()
  for (const d of decisions) {
    if (d.outcome !== 'accepted' && d.outcome !== 'fixed' && d.outcome !== 'redone') continue
    for (const id of d.ruleIds) {
      const s = byRule.get(id) ?? { decided: 0, redone: 0 }
      s.decided++
      if (d.outcome === 'redone') s.redone++
      byRule.set(id, s)
    }
  }
  for (const [id, s] of byRule) {
    if (s.decided >= 3 && s.redone / s.decided >= 0.3) {
      fixes.push(`Handoff rule ${id} was redone in ${s.redone} of ${s.decided} handoffs: narrow it or keep that work on the main model${EST}`)
    }
  }
  if (week.length) for (const s of unusedServers) fixes.push(`MCP server ${s} was not called this week: disable it if you do not need it.`)
  sections.push({
    title: 'Fix first',
    lines: fixes.length ? fixes.map((text) => ({ kind: 'bullet' as const, text })) : [{ kind: 'text', text: 'Nothing to fix this week.' }],
  })

  return {
    where,
    sections,
    footer: `Prices as of ${PRICES_AS_OF}, at public API prices. Shares are estimates from token counts; measured figures come from the plan's weekly meter.`,
  }
}

export function renderText(d: ReportData): string {
  const out: string[] = ['longhaul report', '']
  for (const s of d.sections) {
    out.push(s.title)
    for (const l of s.lines) out.push(l.kind === 'bullet' ? `- ${l.text}` : l.kind === 'sub' ? `    ${l.text}` : `  ${l.text}`)
    out.push('')
  }
  out.push(d.footer)
  return out.join('\n')
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

export function renderHtml(d: ReportData): string {
  const body = d.sections
    .map((s) => {
      const lines = s.lines.map((l) => `<p${l.kind === 'sub' ? ' class="sub"' : ''}>${esc(l.text)}</p>`)
      return `<section><h2>${esc(s.title)}</h2>${lines.join('')}</section>`
    })
    .join('\n')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>longhaul report</title>
<style>
:root{--bg:#fbfaf8;--fg:#1d1b19;--dim:#6b6560;--line:#e2ded8}
@media (prefers-color-scheme: dark){:root{--bg:#161412;--fg:#ece8e3;--dim:#9a938b;--line:#2e2a26}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:42rem;margin:0 auto;padding:2rem 1rem}
h1{font-size:1.5rem;margin:0 0 1.5rem}
h2{font-size:1.1rem;margin:1.5rem 0 .5rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}
p{margin:.25rem 0}
p.sub{margin-left:1.5rem;color:var(--dim)}
footer{margin-top:2rem;color:var(--dim);font-size:.875rem}
</style></head>
<body><main><h1>longhaul report</h1>
${body}
<footer>${esc(d.footer)}</footer></main></body></html>
`
}

// Servers whose tools exist but were never called this week, as "name (N tools)".
async function unusedServers($: EngineInterface, week: SessionRecord[]): Promise<string[]> {
  const tools = new Map<string, number>()
  for (const t of await $.tool.list()) {
    const m = /^mcp__(.+?)__/.exec(t.name)
    if (m && m[1] !== 'longhaul') tools.set(m[1], (tools.get(m[1]) ?? 0) + 1)
  }
  const called = new Set(week.flatMap((r) => Object.entries(r.mcpCalls).filter(([, n]) => n > 0).map(([s]) => s)))
  return [...tools].filter(([s]) => !called.has(s)).map(([s, n]) => `${s} (${plural(n, 'tool')})`)
}

async function reportFor($: EngineInterface, cfg: Config): Promise<ReportData> {
  const now = await $.clock.now()
  const records = await listRecords($, now - 21 * DAY)
  let unused: string[] = []
  try {
    unused = await unusedServers($, windowOf(records, now).week)
  } catch (err) {
    fail($, 'list tools for report', err)
  }
  return buildReport(records, now, unused, cfg)
}

async function open($: EngineInterface, path: string): Promise<boolean> {
  const win = (await $.env.get('OS')) === 'Windows_NT'
  if (win) {
    try {
      await $.process.run(['explorer.exe', path.replace(/\//g, '\\')]) // exits 1 even on success: not checked
      return true
    } catch {
      return false
    }
  }
  try {
    if ((await $.process.run(['open', path])).exitCode === 0) return true // macOS
  } catch {
    // not macOS: try xdg-open
  }
  try {
    return (await $.process.run(['xdg-open', path])).exitCode === 0
  } catch {
    return false
  }
}

export async function runReport($: EngineInterface, cfg: Config, args: string): Promise<{ text: string }> {
  const d = await reportFor($, cfg)
  if (args.trim().toLowerCase() !== 'page') return { text: renderText(d) }
  const path = `${await dataDir($)}/report.html`
  await $.fs.write(path, renderHtml(d))
  const opened = await open($, path)
  return { text: opened ? `Report page opened: ${path}` : `Report page written to ${path}. Open the file yourself.` }
}

export async function registerReport($: EngineInterface): Promise<void> {
  try {
    await $.command.register({ name: 'longhaul', description: "Where this week's tokens went and why", argumentHint: '[page|health]' })
  } catch (err) {
    fail($, 'register longhaul command', err)
  }
}
