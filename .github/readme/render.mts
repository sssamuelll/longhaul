// Draws the README images with the band's own code (meterSegs, eventText), in a terminal like Claude Code's.
// Numbers are examples. Needs Chrome for Playwright, ffmpeg and Cascadia Mono:
//   npm i --no-save playwright-core && npx tsx .github/readme/render.mts
// CHROME and FONT override the browser and font paths.
import { chromium } from 'playwright-core'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { meterSegs, eventText } from '../../hooks/band.tsx'

const OUT = fileURLToPath(new URL('.', import.meta.url))
const COLS = 96
const HARD = 300_000
const FONT = readFileSync(process.env.FONT ?? 'C:/Windows/Fonts/CascadiaMono.ttf').toString('base64')
const day = (d: number) => new Date(2026, 9, 19 + ((d - 1 + 7) % 7), 12).getTime() // 2026-10-19 is a Monday

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
type Line = { cls?: string; html: string }
const blank: Line = { html: '' }
const dim = (s: string): Line => ({ cls: 'dim', html: esc(s) })
const reply = (...ls: string[]): Line[] => ls.map((l, i) => ({ html: (i ? '  ' : '⏺ ') + esc(l) }))
const user = (s: string): Line => ({ cls: 'user', html: `<span class="dim">❯</span> ${esc(s)}` })
const meter = (m: any): Line => ({
  html: meterSegs(m, COLS).map((s) => `<span class="${s.dim ? 'dim' : ''}" style="${s.color ? `color:${s.color}` : ''}">${esc(s.text)}</span>`).join(''),
})
const pace = (weekly: number, today: number, allowance: number, runsOutAt: number | null) => ({ weekly, today, allowance, resetsAt: day(1), runsOutAt, stale: false })

type Scene = { name: string; convo: Line[]; event?: any; meter: any; rows?: number }

const scenes: Scene[] = [
  {
    name: 'over-pace',
    convo: [...reply('The three flaky tests share one fixture that leaks a server between runs.', 'Fixed it and ran the suite ten times: no failures.'), blank, dim('✻ Brewed for 11m 05s')],
    event: { kind: 'over-pace', today: 18, allowance: 11, runsOutAt: day(4) },
    meter: { ctx: 142_000, hard: HARD, pace: pace(63, 18, 11, day(4)) },
  },
  {
    name: 'health',
    convo: [user('what changed in the auth module last week?'), blank, ...reply('Two commits: the session cookie is now SameSite=Lax, and logout clears it.'), blank, dim('✻ Brewed for 41s')],
    event: { kind: 'health', total: 68_000, unusedMcp: 24_000, duplicate: 0 },
    meter: { ctx: 71_000, hard: HARD, pace: pace(22, 2, 14, null) },
  },
]

// The hero: a plan worked step by step, the context climbing past the soft limit, then compacted after a commit.
const step = (n: number, what: string) => reply(`Step ${n} of 6, ${what}: done, tests pass, committed.`)
const steps = [user('work through the import plan, one commit per step'), blank, ...step(1, 'the upload form'), blank, ...step(2, 'parsing in a worker'), blank, ...step(3, 'rows into the database')]
const hero: [Scene, number][] = [
  [{ name: 'h1', convo: steps.slice(0, 3), meter: { ctx: 96_000, hard: HARD, pace: pace(41, 6, 14, null) } }, 1.3],
  [{ name: 'h2', convo: steps.slice(0, 5), meter: { ctx: 141_000, hard: HARD, pace: pace(42, 7, 14, null) } }, 1.3],
  [{ name: 'h3', convo: steps, meter: { ctx: 184_000, hard: HARD, pace: pace(44, 8, 14, null) } }, 1.6],
  [{ name: 'h4', convo: [...steps, blank, ...reply('Picking up at step 4 of 6: the progress bar.')], event: { kind: 'compacted', before: 184_000, after: 66_000 }, meter: { ctx: 66_000, hard: HARD, pace: pace(44, 8, 14, null) } }, 4],
]
const heroRows = Math.max(...hero.map(([s]) => s.convo.length + (s.event ? 1 : 0)))
hero.forEach(([s]) => (s.rows = heroRows))

const THEMES = {
  dark: { bg: '#0c0c0c', frame: '#1b1b1b', border: '#2e2e2e', fg: '#e6e6e6', dim: '#8a8a8a', rule: '#5a5a5a', userbg: '#2a2a2a', dot: '#3a3a3a' },
  light: { bg: '#ffffff', frame: '#f3f3f3', border: '#d8d8d8', fg: '#1f1f1f', dim: '#767676', rule: '#b5b5b5', userbg: '#ececec', dot: '#cfcfcf' },
}

function html(sc: Scene, t: (typeof THEMES)['dark']): string {
  const band = [...(sc.event ? [dim(eventText(sc.event))] : []), meter(sc.meter)]
  const pad = Array.from({ length: Math.max(0, (sc.rows ?? 0) - sc.convo.length - band.length + 1) }, () => blank)
  const lines = [...pad, ...sc.convo, blank, ...band, { cls: 'rule', html: '' }, { html: '<span class="dim">❯</span> <span class="cur"></span>' }, { cls: 'rule', html: '' }]
  return `<!doctype html><meta charset="utf-8"><style>
  @font-face { font-family: T; src: url(data:font/ttf;base64,${FONT}); }
  html, body { margin: 0; background: transparent; }
  .win { display: inline-block; border-radius: 12px; background: ${t.bg}; border: 1px solid ${t.border}; overflow: hidden; }
  .bar { height: 38px; background: ${t.frame}; display: flex; align-items: center; padding: 0 14px; gap: 8px; border-bottom: 1px solid ${t.border}; }
  .bar i { width: 12px; height: 12px; border-radius: 50%; background: ${t.dot}; display: block; }
  .bar b { flex: 1; text-align: center; font: 500 13px system-ui, sans-serif; color: ${t.dim}; margin-right: 52px; }
  pre { margin: 0; padding: 18px 24px 20px; width: ${COLS}ch; font: 15px/1.6 T, monospace; color: ${t.fg}; white-space: pre; }
  .dim { color: ${t.dim}; }
  .user { background: ${t.userbg}; margin: 0 -24px; padding: 0 24px; }
  .rule { border-top: 1px solid ${t.rule}; margin: 10px 0; }
  .cur { display: inline-block; width: 1px; height: 1.1em; background: ${t.fg}; vertical-align: -0.2em; }
  </style><div class="win"><div class="bar"><i></i><i></i><i></i><b>claude</b></div><pre>${lines
    .map((l) => (l.cls === 'rule' ? `<div class="rule"></div>` : `<div class="${l.cls ?? ''}">${l.html || ' '}</div>`))
    .join('')}</pre></div>`
}

const tmp = mkdtempSync(join(tmpdir(), 'longhaul-readme-'))
const browser = await chromium.launch({ executablePath: process.env.CHROME })
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1100, height: 900 } })
const shot = async (sc: Scene, t: (typeof THEMES)['dark'], path: string) => {
  await page.setContent(html(sc, t))
  await page.locator('.win').screenshot({ path, omitBackground: true })
}
for (const [theme, t] of Object.entries(THEMES)) {
  for (const sc of scenes) await shot(sc, t, join(OUT, `${sc.name}-${theme}.png`))
  // the concat demuxer takes each frame's duration and wants the last frame listed twice
  const list: string[] = []
  for (const [sc, secs] of hero) {
    const f = join(tmp, `${sc.name}-${theme}.png`)
    await shot(sc, t, f)
    list.push(`file '${f.replace(/\\/g, '/')}'`, `duration ${secs}`)
  }
  list.push(list.at(-2)!)
  writeFileSync(join(tmp, `${theme}.txt`), list.join('\n'))
  const gif = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(tmp, `${theme}.txt`)]
  execFileSync('ffmpeg', [...gif, '-vf', 'split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=dither=none', '-loop', '0', join(OUT, `hero-${theme}.gif`)])
}
await browser.close()
