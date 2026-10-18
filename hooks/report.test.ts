import { test, expect } from 'claude-code/testing'
import { measuredShares, ELSEWHERE, buildReport, renderText, renderHtml } from './report'
import { newRecord, type SessionRecord, type Decision } from './ledger'
import { PRICES_AS_OF } from './prices'

const DAY = 86_400_000
const resets = new Date(2026, 9, 23, 4, 0).getTime()
const mk = (id: string, o: Partial<SessionRecord> = {}): SessionRecord => ({
  ...newRecord(id, 'proj', new Date(2026, 9, 19, 14, 5).getTime()),
  ...o,
})
const dec = (outcome: Decision['outcome'], ruleIds = ['en.search']): Decision => ({
  at: 1, verdict: 'sonnet', ruleIds, mode: 'auto', outcome, subFiles: [], turnsSince: 3,
})
const big = mk('a', {
  steps: 40, peakCtx: 310_000,
  cost: { input: 0.1, write: 2.0, read: 6.3, output: 1.6 },
  byBucket: { lt100k: 1, '100to200k': 2, '200to400k': 5, gt400k: 2 },
  compactions: { auto: 1, manual: 0, plugin: 1 },
  rate: [[resets - 3 * DAY, 30, 1], [resets - 2 * DAY, 36, 10]],
  weekResetsAt: new Date(resets).toISOString(),
  decisions: [dec('redone'), dec('redone'), dec('accepted'), dec('pending')],
  mcpCalls: { github: 2 },
})
const now = resets - DAY

test('measured share splits overlapping increases by cost', async () => {
  const a = mk('A', { rate: [[10, 36, 0], [20, 38, 3]] })
  const b = mk('B', { rate: [[10, 36, 0], [20, 38, 1]] })
  const m = measuredShares([a, b])
  expect(m.A.percent).toBe(1.5)
  expect(m.B.percent).toBe(0.5)
  expect(m.A.points).toBe(2)
})

test('single session, ignoring a reset drop', async () => {
  const s = mk('S', { rate: [[1, 30, 0], [2, 33, 2]] })
  expect(measuredShares([s]).S).toEqual({ points: 3, percent: 3 })
  const r = mk('R', { rate: [[1, 30, 0], [2, 5, 2], [3, 6, 3]] })
  expect(measuredShares([r]).R.percent).toBe(1)
})

test("a rise with no cost growth goes to the elsewhere bucket", async () => {
  const a = mk('A', { rate: [[1, 10, 5]] })
  const b = mk('B', { rate: [[2, 12, 0]] })
  const m = measuredShares([a, b])
  expect(m.B).toBeUndefined()
  expect(m[ELSEWHERE].percent).toBe(2)
})

test('buildReport shares fold input into new context', async () => {
  const d = buildReport([big], now, [])
  expect(d.where).toEqual({ read: 63, newContext: 21, output: 16 })
})

const text = renderText(buildReport([big], now, ['slack (4 tools)'], { guardMode: 'off', softLimit: 150_000 }))

test('renderText headings in order, estimates marked, footer', async () => {
  const heads = ['This week', 'Where it went', 'Why', 'Biggest sessions', 'Sonnet handoffs', 'Compactions', 'Fix first']
  const at = heads.map((h) => text.split('\n').indexOf(h))
  expect(at.every((i) => i >= 0)).toBe(true)
  expect([...at].sort((x, y) => x - y)).toEqual(at)
  const lines = text.split('\n')
  const bullets = lines.slice(at[1], at[4]).filter((l) => l.startsWith('- '))
  expect(bullets.length).toBeGreaterThan(5)
  expect(bullets.every((l) => l.endsWith('(est.)'))).toBe(true)
  expect(text).toContain(PRICES_AS_OF)
  expect(text).toContain('by context size, main session'.replace('by', 'Cost by'))
})

test('sessions are labelled project, weekday and time', async () => {
  expect(text).toContain('proj · Mon 14:05')
  expect(text).toContain('measured: 6.0% of the week, from 6 points')
})

test('fix first ranks what applies', async () => {
  const fix = text.slice(text.indexOf('Fix first'))
  expect(fix).toContain('Turn the context guard on')
  expect(fix).toContain('en.search was redone in 2 of 3')
  expect(fix).toContain('slack (4 tools)')
  expect(fix.indexOf('guard')).toBeLessThan(fix.indexOf('slack'))
  const none = renderText(buildReport([big], now, [], { guardMode: 'auto', softLimit: 150_000 }))
  expect(none).toContain('en.search')
  const clean = renderText(buildReport([mk('c')], now, []))
  expect(clean).toContain('Nothing to fix this week.')
})

test('report without rate points', async () => {
  const t = renderText(buildReport([mk('x', { steps: 3, cost: { input: 1, write: 0, read: 0, output: 0 } })], now, []))
  expect(t).toContain('Weekly figures need a Pro or Max plan.')
  for (const h of ['Where it went', 'Why', 'Biggest sessions', 'Sonnet handoffs', 'Compactions', 'Fix first']) expect(t).toContain(h)
})

test('records outside the week are excluded', async () => {
  const old = mk('old', { startedAt: resets - 20 * DAY, cost: { input: 50, write: 0, read: 0, output: 0 } })
  const t = renderText(buildReport([big, old], now, []))
  expect(t).toContain('across 1 session')
})

test('renderHtml has the headings, a dark rule, no scripts, and escapes', async () => {
  const evil = mk('e', { project: '<b>&x', steps: 1, cost: { input: 1, write: 0, read: 0, output: 0 } })
  const h = renderHtml(buildReport([big, evil], now, []))
  for (const t of ['This week', 'Where it went', 'Why', 'Biggest sessions', 'Sonnet handoffs', 'Compactions', 'Fix first']) expect(h).toContain(`<h2>${t}</h2>`)
  expect(h).toContain('prefers-color-scheme: dark')
  expect(h).not.toMatch(/<script|https?:\/\//)
  expect(h).toContain('&lt;b&gt;&amp;x')
  expect(h).not.toContain('<b>&x')
})

function stub(on: any, o: { os?: string; home?: string; files: Record<string, string>; ran: string[][]; openOk?: (argv: string[]) => boolean }) {
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'OS' ? o.os : e.name === 'HOME' ? (o.home ?? '/h') : undefined }))
  on('fs.list', async () => ({ value: [{ name: 'a.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }))
  on('fs.read', async () => ({ value: JSON.stringify({ ...big, startedAt: Date.now(), rate: [], weekResetsAt: undefined }) }))
  on('fs.write', async (_$: any, e: any) => ((o.files[e.path] = e.text), { value: undefined }))
  on('clock.now', async () => ({ value: Date.now() }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [{ name: 'mcp__github__a', description: '', mcp: true }, { name: 'mcp__slack__b', description: '', mcp: true }] }))
  on('command.register', async () => ({ value: undefined }))
  on('process.run', async (_$: any, e: any) => {
    o.ran.push([...e.argv])
    return { value: { exitCode: o.openOk && !o.openOk(e.argv) ? 1 : 0, stdout: '', stderr: '' } as never }
  })
}

test('/longhaul prints the text report', async ($, on) => {
  stub(on, { files: {}, ran: [] })
  const r = await $.command.run({ command: 'longhaul', args: 'weird' })
  expect(r.text).toContain('Biggest sessions')
  expect(r.text).toContain('slack (1 tool)')
  expect(r.text).not.toContain('github (')
})

test('/longhaul page writes and opens with argv on Windows', async ($, on) => {
  const files: Record<string, string> = {}
  const ran: string[][] = []
  stub(on, { os: 'Windows_NT', files, ran })
  const r = await $.command.run({ command: 'longhaul', args: ' Page ' })
  const path = Object.keys(files).find((p) => p.endsWith('report.html'))!
  expect(files[path]).toContain('<h2>Fix first</h2>')
  expect(ran).toEqual([['explorer.exe', '\\h\\.claude\\longhaul\\report.html']])
  expect(path).toMatch(/longhaul.report.html$/)
  expect(r.text).toContain('report.html')
})

test('/longhaul page falls back to xdg-open and still answers the path', async ($, on) => {
  const files: Record<string, string> = {}
  const ran: string[][] = []
  stub(on, { files, ran, openOk: (a) => a[0] === 'xdg-open' })
  await $.command.run({ command: 'longhaul', args: 'page' })
  expect(ran.map((a) => a[0])).toEqual(['open', 'xdg-open'])
})

test('/longhaul page still answers the path when nothing opens it', async ($, on) => {
  stub(on, { files: {}, ran: [], openOk: () => false })
  const r = await $.command.run({ command: 'longhaul', args: 'page' })
  expect(r.text).toContain('report.html')
})

test('dollar figure and footer say API equivalent', async () => {
  expect(text).toContain('About $10.00 at API prices across 1 session (an equivalent, not a bill) (est.)')
  expect(text).toContain(`Prices as of ${PRICES_AS_OF}, at public API prices.`)
})

test('windows opener passes one backslash path to explorer, no cmd', async ($, on) => {
  const ran: string[][] = []
  stub(on, { os: 'Windows_NT', files: {}, ran, home: 'C:/Users/A&B C' })
  await $.command.run({ command: 'longhaul', args: 'page' })
  expect(ran).toEqual([['explorer.exe', 'C:\\Users\\A&B C\\.claude\\longhaul\\report.html']])
})

test('a stale reset moves forward a whole week and old points do not count', async () => {
  const stale = resets - 9 * DAY // 2 days before `now2`
  const now2 = stale + 2 * DAY
  const r = mk('s', {
    startedAt: stale - 6 * DAY,
    weekResetsAt: new Date(stale).toISOString(),
    rate: [[stale - 3 * DAY, 80, 1]],
    cost: { input: 1, write: 0, read: 0, output: 0 },
  })
  const t = renderText(buildReport([r], now2, []))
  expect(t).toContain('Weekly figures need a Pro or Max plan.')
  expect(t).not.toContain('Used 80%')
  const fresh = mk('f', { startedAt: now2 - DAY, weekResetsAt: new Date(stale).toISOString(), rate: [[now2 - DAY, 12, 1]] })
  const t2 = renderText(buildReport([r, fresh], now2, []))
  expect(t2).toContain('Used 12% of the weekly limit, resets ')
  expect(t2).toContain('across 1 session')
})

test('an unexplained rise shows as its own line in Biggest sessions', async () => {
  const a = mk('A', { rate: [[resets - 3 * DAY, 10, 5]], weekResetsAt: new Date(resets).toISOString() })
  const b = mk('B', { rate: [[resets - 2 * DAY, 12, 0]], weekResetsAt: new Date(resets).toISOString() })
  const out = renderText(buildReport([a, b], now, []))
  expect(out).toContain('elsewhere or between sessions: 2.0% of the week, from 2 points')
  expect(renderText(buildReport([big], now, []))).not.toContain('elsewhere or between sessions')
})

test('measured figures use only meter readings inside the week', async () => {
  const old = mk('O', { rate: [[resets - 20 * DAY, 80, 0], [resets - 19 * DAY, 90, 5], [resets - 3 * DAY, 30, 6], [resets - 2 * DAY, 36, 16]], weekResetsAt: new Date(resets).toISOString() })
  const out = renderText(buildReport([old], now, []))
  expect(out).toContain('measured: 6.0% of the week, from 6 points')
  expect(out).toContain('Used 36% of the weekly limit')
})

test('a fresh install, with no records, does not suggest disabling MCP servers', async () => {
  const out = renderText(buildReport([], now, ['slack (4 tools)']))
  expect(out).not.toContain('was not called this week')
})

test('Compactions section: counts by reason, medians, hard-limit sessions; empty message', async () => {
  const e = (reason: any, before?: number, after?: number) => ({ at: 1, trigger: 'plugin' as const, reason, ...(before ? { before } : {}), ...(after ? { after } : {}) })
  const a = mk('a', { compactionLog: [e('task-done', 300_000, 40_000), e('hard-limit', 500_000, 60_000), e('auto')], rate: [[resets - 2 * DAY, 30, 1]], weekResetsAt: new Date(resets).toISOString() })
  const b = mk('b', { compactionLog: [e('task-done', 100_000, 20_000)], rate: [[resets - 2 * DAY, 31, 2]], weekResetsAt: new Date(resets).toISOString() })
  const t = renderText(buildReport([a, b], now, []))
  const sec = t.slice(t.indexOf('Compactions'), t.indexOf('Fix first'))
  expect(sec).toContain('4 compactions: 2 task finished, 1 hard limit, 1 Claude Code auto-compact.')
  expect(sec).toContain('Typically 300k down to 40k.')
  expect(sec).toContain('1 session reached the hard limit.')
  expect(renderHtml(buildReport([a], now, []))).toContain('<h2>Compactions</h2>')
  expect(renderText(buildReport([mk('c')], now, []))).toContain('No compactions this week.')
})
