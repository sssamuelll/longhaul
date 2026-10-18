import { test, expect } from 'claude-code/testing'
import { findDuplicates, healthAdvice, renderHealth, type BaseSnapshot } from './health'
import { newRecord } from './ledger'

const DAY = 86_400_000
const now = new Date(2026, 9, 18, 12, 0).getTime()
const L = (c: string): string => c.repeat(50)
const A = [L('a'), L('b'), L('c')]

test('findDuplicates counts distinct shared lines once per extra copy', async () => {
  const d = findDuplicates([
    { path: '/a.md', text: [...A, 'only in a, and long enough to count as a line here'].join('\n') },
    { path: '/b.md', text: ['other text that is long enough to count as a line, too', ...A.map((l) => `  ${l}  `)].join('\n') },
  ])
  expect(d.lines).toBe(3)
  expect(d.tokens).toBe(Math.round(150 / 4))
  expect(d.files).toEqual(['/a.md', '/b.md'])
})

test('findDuplicates ignores short lines and whitespace-only differences, and a single file', async () => {
  const short = 'short line repeated'
  expect(findDuplicates([{ path: '/a', text: short }, { path: '/b', text: short }]).lines).toBe(0)
  const spaced = findDuplicates([
    { path: '/a', text: `${'word '.repeat(12)}end` },
    { path: '/b', text: `\t${'word  '.repeat(12)} end` },
  ])
  expect(spaced.lines).toBe(1)
  expect(findDuplicates([{ path: '/a', text: `${A[0]}\n${A[0]}` }])).toEqual({ lines: 0, tokens: 0, files: [] })
  const three = findDuplicates([{ path: '/a', text: A[0] }, { path: '/b', text: A[0] }, { path: '/c', text: A[0] }])
  expect(three.tokens).toBe(25) // two extra copies of 50 characters
})

const snap = (o: Partial<BaseSnapshot> = {}): BaseSnapshot => ({
  at: 1,
  total: 93_000,
  mcp: { github: { tools: 30, tokens: 25_000 }, linear: { tools: 12, tokens: 16_000 }, tiny: { tools: 2, tokens: 600 } },
  memory: [{ path: '/p/CLAUDE.md', tokens: 900, lines: 40 }],
  skills: { count: 20, tokens: 3000 },
  duplicate: { lines: 0, tokens: 0, files: [] },
  ...o,
})

test('healthAdvice: unused servers, long memory files, duplicates, and the all-clear', async () => {
  const adv = healthAdvice(
    snap({
      memory: [{ path: '/p/BIG.md', tokens: 4000, lines: 120 }, { path: '/p/LONG.md', tokens: 900, lines: 250 }],
      duplicate: { lines: 4, tokens: 700, files: ['/p/a.md', '/p/b.md'] },
    }),
    { github: 3 },
  )
  const text = adv.map((a) => a.text).join('\n')
  expect(adv.length).toBe(5) // linear, tiny, BIG, LONG, duplicates
  expect(text).toContain('linear')
  expect(text).toContain("turn it off for projects that don't use it (/mcp)")
  expect(text).toContain('12 tools')
  expect(text).toContain('16,000 tokens (est.)')
  expect(text).not.toContain('github')
  expect(text).toContain('/p/BIG.md')
  expect(text).toContain('/p/LONG.md')
  expect(text).toContain('shorten')
  expect(text).toContain('keep the shared text in one file')
  expect(text).toContain('/p/a.md')
  expect(text).not.toContain('!')
  const light = healthAdvice(snap({ mcp: { github: { tools: 30, tokens: 25_000 } } }), { github: 1 })
  expect(light.map((a) => a.text)).toEqual(['Your sessions start light.'])
  const low = healthAdvice(snap({ mcp: {}, duplicate: { lines: 2, tokens: 499, files: ['/a', '/b'] } }), {})
  expect(low.map((a) => a.text)).toEqual(['Your sessions start light.'])
})

test('renderHealth lists items biggest first, marks estimates, and shows no contents', async () => {
  const s = snap({ duplicate: { lines: 3, tokens: 700, files: ['/p/a.md', '/p/b.md'] } })
  const out = renderHealth(s, healthAdvice(s, { github: 3 }), { github: 3 })
  expect(out.indexOf('github')).toBeLessThan(out.indexOf('linear'))
  expect(out.indexOf('linear')).toBeLessThan(out.indexOf('skills'))
  expect(out).toMatch(/github.*used this week/)
  expect(out).toMatch(/linear.*not used this week/)
  expect(out).toContain('93,000 tokens (est.)')
  const [items] = out.split('\nAdvice')
  for (const l of items.split('\n')) if (/\d.*tokens/.test(l)) expect(l).toContain('(est.)')
  expect(out).toContain('3 lines')
  expect(out).not.toContain(L('a'))
})

// ---- wiring ----

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

type Opt = { id: string; breakdown?: unknown; reject?: boolean; files?: Record<string, string>; store?: Map<string, unknown>; cwd?: string; history?: boolean; seeds?: object[]; ctx?: number }
const SEED = '/cfg/longhaul/sessions/old-1.json'
const seedRec = (): string => JSON.stringify(newRecord('old-1', 'proj', now - 4 * DAY))
function stub(on: any, o: Opt) {
  const files: Record<string, string> = { ...(o.files ?? {}) }
  if (o.history !== false) files[SEED] = seedRec() // four days of history, so unused-server verdicts are due
  for (const [i, r] of (o.seeds ?? []).entries()) files[`/cfg/longhaul/sessions/seed-${i}.json`] = JSON.stringify(r)
  const store = o.store ?? new Map<string, unknown>()
  const state = new Map<string, unknown>()
  const calls = { breakdown: [] as unknown[], lists: 0 }
  const find = (p: string): string | undefined => Object.keys(files).find((k) => norm(k) === norm(p))
  on('session.id', async () => ({ value: o.id }))
  on('session.cwd', async () => ({ value: o.cwd ?? '/w/p' }))
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))
  on('fs.read', async (_$: any, e: any) => {
    const k = find(e.path)
    return k ? { value: files[k] } : { deny: 'ENOENT' }
  })
  on('fs.write', async (_$: any, e: any) => ((files[find(e.path) ?? e.path] = e.text), { value: undefined }))
  on('fs.list', async () => (calls.lists++, {
    value: Object.keys(files)
      .filter((k) => /sessions/.test(k))
      .map((k) => ({ name: norm(k).split('/').pop()!, kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('clock.now', async () => ({ value: now }))
  on('store.get', async (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('state.get', async (_$: any, e: any) => ({ value: { value: state.get(e.key), version: 0 } as never }))
  on('state.set', async (_$: any, e: any) => (state.set(e.key, e.value), { value: { isSet: true, version: 1 } as never }))
  on('tool.list', async () => ({ value: [] }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('session.usage', async (_$: any, e: any) => {
    if (e?.breakdown) calls.breakdown.push(e.breakdown)
    if (o.reject && e?.breakdown) return { deny: 'no breakdown' }
    return { value: { rateLimits: [], context: e?.breakdown && o.breakdown ? { breakdown: o.breakdown } : {} } as never }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('session.start', async () => ({ cwd: '/w/p' }))
  if (o.ctx) {
    on('turn.step', async function* () {
      return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: o.ctx, cache_creation_input_tokens: 0 } } as never
    })
  }
  return { files, store, state, calls }
}

const bd = (o: Record<string, unknown> = {}) => ({
  totalTokens: 93_000,
  mcpTools: [
    { name: 'mcp__github__a', serverName: 'github', tokens: 30_000, isLoaded: true },
    { name: 'mcp__github__b', serverName: 'github', tokens: 11_000, isLoaded: true },
    { name: 'mcp__linear__a', serverName: 'linear', tokens: 500, isLoaded: true },
  ],
  memoryFiles: [{ path: '/p/CLAUDE.md', type: 'Project', tokens: 600 }, { path: '/p/AGENTS.md', type: 'User', tokens: 600 }],
  skills: { totalSkills: 9, includedSkills: 9, tokens: 2000 },
  ...o,
})
const started = new WeakSet<object>()
const begin = ($: any, interactive = true) => (started.add($), $.session.start({ cwd: '/w/p', surface: null, isInteractive: interactive }))
const done = async ($: any, id = 't') => {
  if (!started.has($)) await begin($)
  await $.turn.complete({ turnId: id, reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
}
const step = async ($: any) => {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
}
const saved = (files: Record<string, string>, id: string) => JSON.parse(files[Object.keys(files).find((k) => k.endsWith(`${id}.json`))!])
const healthEvent = (state: Map<string, unknown>) => [...state.values()].find((v: any) => v?.kind === 'health') as any
const mem = { '/p/CLAUDE.md': `${L('x')}\n${L('y')}\nunique one ${'q'.repeat(10)}`, '/p/AGENTS.md': `${L('x')}\n${L('y')}\nunique two` }

test('the snapshot is taken once, at the first main turn end, and saved on the record', async ($, on) => {
  const s = stub(on, { id: 'h1', breakdown: bd(), files: mem })
  await done($)
  await done($, 't2')
  expect(s.calls.breakdown).toEqual(['summary'])
  const base = saved(s.files, 'h1').base
  expect(base.total).toBe(93_000)
  expect(base.mcp.github).toEqual({ tools: 2, tokens: 41_000 })
  expect(base.skills).toEqual({ count: 9, tokens: 2000 })
  expect(base.memory.map((m: any) => m.lines)).toEqual([3, 3])
  expect(base.duplicate.lines).toBe(2)
  expect(base.duplicate.tokens).toBe(25)
  expect(JSON.stringify(base)).not.toContain('qqqq') // no contents
})

test('a rejecting breakdown leaves base unset and never throws', async ($, on) => {
  const s = stub(on, { id: 'h2', reject: true })
  await done($)
  expect(saved(s.files, 'h2').base).toBeUndefined()
})

test('a missing breakdown leaves base unset', async ($, on) => {
  const s = stub(on, { id: 'h3' })
  await done($)
  expect(saved(s.files, 'h3').base).toBeUndefined()
})

test('an unreadable memory file is skipped for the duplicate scan but still listed', async ($, on) => {
  const s = stub(on, { id: 'h4', breakdown: bd(), files: { '/p/CLAUDE.md': mem['/p/CLAUDE.md'] } })
  await done($)
  const m = saved(s.files, 'h4').base.memory
  expect(m.map((x: any) => x.path)).toEqual(['/p/CLAUDE.md', '/p/AGENTS.md'])
  expect(m[1].lines).toBeUndefined()
  expect('lines' in m[1]).toBe(false)
})

test('the heads-up names the unused MCP tokens, once a week', async ($, on) => {
  const store = new Map<string, unknown>()
  const o: Opt = { id: 'h5', breakdown: bd(), store }
  const s = stub(on, o)
  await done($)
  expect(healthEvent(s.state)).toEqual({ kind: 'health', total: 93_000, unusedMcp: 41_500, duplicate: 0 })
  expect(store.get('health:notice')).toBe(now)
  s.state.clear()
  o.id = 'h6' // a second session within 7 days
  await done($)
  expect(healthEvent(s.state)).toBeUndefined()
  store.set('health:notice', now - 8 * DAY)
  o.id = 'h7'
  await done($)
  expect(healthEvent(s.state)).toBeDefined()
})

test('health_mode off never shows the heads-up, but the snapshot is still taken', { options: { health_mode: 'off' } }, async ($, on) => {
  const s = stub(on, { id: 'h8', breakdown: bd() })
  await done($)
  expect(healthEvent(s.state)).toBeUndefined()
  expect(saved(s.files, 'h8').base.total).toBe(93_000)
})

test('light sessions show no heads-up', async ($, on) => {
  const s = stub(on, { id: 'h9', breakdown: bd({ totalTokens: 30_000, mcpTools: [] }) })
  await done($)
  expect(healthEvent(s.state)).toBeUndefined()
})

test('the duplicate variant is chosen when MCP is not the problem', async ($, on) => {
  const big = Array.from({ length: 30 }, (_, i) => String(i).padStart(2, '0') + 'z'.repeat(98)).join('\n')
  const s = stub(on, { id: 'h10', breakdown: bd({ mcpTools: [] }), files: { '/p/CLAUDE.md': big, '/p/AGENTS.md': big } })
  await done($)
  expect(healthEvent(s.state)).toEqual({ kind: 'health', total: 93_000, unusedMcp: 0, duplicate: 750 })
})

test('/longhaul health prints the latest snapshot of the week, or says there is none', async ($, on) => {
  stub(on, { id: 'h11', breakdown: bd(), files: mem })
  let r: any = await $.command.run({ command: 'longhaul', args: ' Health ' })
  expect(r.text).toBe("No snapshot yet: it's taken after the first reply of a session.")
  await done($)
  r = await $.command.run({ command: 'longhaul', args: 'health' })
  expect(r.text).toContain('93,000 tokens (est.)')
  expect(r.text).toMatch(/github.*not used this week/)
  expect(r.text).not.toContain(L('x'))
  r = await $.command.run({ command: 'longhaul', args: '' })
  expect(r.text).toContain('longhaul report')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the band shows both heads-up texts`, async ($, on) => {
    const s = stub(on, { id: `b-${surface}` })
    const mount = () => $.ui.mount({ plugin: 'longhaul', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
    s.state.set('event', { kind: 'health', total: 93_000, unusedMcp: 41_000, duplicate: 0 })
    expect(await (await mount()).find({ text: 'sessions start at 93k \u00b7 41k of it is MCP tools unused this week \u00b7 /longhaul health' })).toBeDefined()
    s.state.set('event', { kind: 'health', total: 93_000, unusedMcp: 0, duplicate: 700 })
    expect(await (await mount()).find({ text: 'sessions start at 93k \u00b7 700 tokens of it repeat across memory files \u00b7 /longhaul health' })).toBeDefined()
  })
}

test('a pending over-pace event is not clobbered; the cooldown is kept and the heads-up shows on a later turn', async ($, on) => {
  const store = new Map<string, unknown>()
  const s = stub(on, { id: 'h12', breakdown: bd(), store })
  const urgent = { kind: 'over-pace', today: 18, allowance: 11, runsOutAt: now + DAY }
  s.state.set('event', urgent)
  await done($)
  expect(s.state.get('event')).toEqual(urgent)
  expect(store.has('health:notice')).toBe(false)
  s.state.set('event', null)
  await done($, 't2')
  expect(s.state.get('event')).toEqual({ kind: 'health', total: 93_000, unusedMcp: 41_500, duplicate: 0 })
  expect(store.get('health:notice')).toBe(now)
})

test('a breakdown that keeps failing is tried at most twice per session', async ($, on) => {
  const s = stub(on, { id: 'h13', reject: true })
  for (const t of ['a', 'b', 'c', 'd']) await done($, t)
  expect(s.calls.breakdown.length).toBe(2)
})

test('a memory file with unknown size is advised by tokens only, with no line count', async () => {
  const snapU: BaseSnapshot = { ...snap(), mcp: {}, memory: [{ path: '/p/HUGE.md', tokens: 5000 }] }
  const adv = healthAdvice(snapU, {})
  expect(adv[0].text).toContain('/p/HUGE.md')
  expect(adv[0].text).not.toMatch(/line/)
  const out = renderHealth(snapU, adv)
  expect(out).not.toMatch(/0 lines?/)
  expect(out).toContain('/p/HUGE.md: 5,000 tokens (est.)')
})

test('separator lines are not duplicates, and our own server is not listed', async ($, on) => {
  const rule = '|' + '-|'.repeat(30)
  expect(findDuplicates([{ path: '/a', text: rule }, { path: '/b', text: rule }]).lines).toBe(0)
  const s = stub(on, {
    id: 'h14',
    breakdown: bd({ mcpTools: [{ name: 'mcp__longhaul__review', serverName: 'longhaul', tokens: 900, isLoaded: true }] }),
  })
  await done($)
  expect(saved(s.files, 'h14').base.mcp).toEqual({})
})

// ---- fix wave 2 ----

const wireBd = bd({
  mcpTools: [
    { name: 'mcp__plugin_foo_bar__send', serverName: 'plugin:foo:bar', tokens: 12_000, isLoaded: true },
    { name: 'mcp__claude_ai_Claude_Docs__read', serverName: 'claude.ai Claude Docs', tokens: 11_000, isLoaded: true },
    { name: 'mcp__github__a', serverName: 'github', tokens: 11_000, isLoaded: true },
    { name: 'mcp__longhaul__review', serverName: 'longhaul', tokens: 900, isLoaded: true },
  ],
})

test('1: servers are keyed by wire name, so plugin servers and connectors with calls are used', async ($, on) => {
  const s = stub(on, {
    id: 'w1',
    breakdown: wireBd,
    seeds: [{ ...newRecord('seed-a', 'proj', now - 3 * DAY), mcpCalls: { plugin_foo_bar: 2, claude_ai_Claude_Docs: 1 } }],
  })
  await done($)
  expect(Object.keys(saved(s.files, 'w1').base.mcp).sort()).toEqual(['claude_ai_Claude_Docs', 'github', 'plugin_foo_bar'])
  const r: any = await $.command.run({ command: 'longhaul', args: 'health' })
  expect(r.text).toMatch(/plugin_foo_bar.*[^t] used this week/)
  expect(r.text).toMatch(/claude_ai_Claude_Docs.*[^t] used this week/)
  expect(r.text).toMatch(/github.*not used this week/)
  expect(r.text).toContain('plugin:foo:bar') // the name /mcp lists, for display
  expect(healthEvent(s.state)).toEqual({ kind: 'health', total: 93_000, unusedMcp: 11_000, duplicate: 0 })
})

test('2: the start size leaves out the Messages row', async ($, on) => {
  const cats = [
    { name: 'System prompt', tokens: 8000, color: 'c', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 6000, color: 'c', isDeferred: false, kind: 'used' },
  ]
  const s = stub(on, { id: 'm1', breakdown: bd({ categories: cats }) })
  await done($)
  expect(saved(s.files, 'm1').base.total).toBe(87_000)
  expect(saved(s.files, 'm1').base.afterFirstReply).toBeUndefined()
  const r: any = await $.command.run({ command: 'longhaul', args: 'health' })
  expect(r.text).toContain('87,000 tokens (est.)')
  expect(r.text).not.toContain('after the first reply')
})

test('2: no Messages row keeps the total and says so', async ($, on) => {
  const s = stub(on, { id: 'm2', breakdown: bd({ categories: [] }) })
  await done($)
  expect(saved(s.files, 'm2').base.total).toBe(93_000)
  const r: any = await $.command.run({ command: 'longhaul', args: 'health' })
  expect(r.text).toContain('counted after the first reply')
})

test('3: under 3 days of history there is no turn-off advice and no MCP heads-up', async ($, on) => {
  const s = stub(on, { id: 'y1', breakdown: bd(), history: false })
  await done($)
  expect(healthEvent(s.state)).toBeUndefined()
  const r: any = await $.command.run({ command: 'longhaul', args: 'health' })
  expect(r.text).toMatch(/no calls recorded since \d{4}-\d{2}-\d{2}/)
  expect(r.text).not.toContain('/mcp')
})

test('3: duplicates still raise the heads-up without history', async ($, on) => {
  const big = Array.from({ length: 30 }, (_, i) => String(i).padStart(2, '0') + 'z'.repeat(98)).join('\n')
  const s = stub(on, { id: 'y2', breakdown: bd({ mcpTools: [] }), history: false, files: { '/p/CLAUDE.md': big, '/p/AGENTS.md': big } })
  await done($)
  expect(healthEvent(s.state)).toEqual({ kind: 'health', total: 93_000, unusedMcp: 0, duplicate: 750 })
})

test('3: advice and list by history flag', async () => {
  const a = healthAdvice(snap(), {}, { mature: false, since: now })
  expect(a.map((x) => x.text).join('\n')).not.toContain('/mcp')
  expect(renderHealth(snap(), a, {}, { mature: false, since: new Date(2026, 9, 16).getTime() })).toContain('no calls recorded since 2026-10-16')
})

test('4a: a non-interactive session snapshots but never raises or stamps the heads-up', async ($, on) => {
  const store = new Map<string, unknown>()
  const s = stub(on, { id: 'n1', breakdown: bd(), store })
  await begin($, false)
  await done($)
  expect(saved(s.files, 'n1').base.total).toBe(93_000)
  expect(healthEvent(s.state)).toBeUndefined()
  expect(store.has('health:notice')).toBe(false)
})

test('4b: a compaction scheduled this turn holds the heads-up back', { options: { guard_mode: 'auto', soft_limit: 100000, hard_limit: 200000 } }, async ($, on) => {
  const store = new Map<string, unknown>()
  const s = stub(on, { id: 'c1', breakdown: bd(), store, ctx: 250_000 })
  await begin($)
  await step($)
  await done($)
  expect(healthEvent(s.state)).toBeUndefined()
  expect(store.has('health:notice')).toBe(false)
})

test('10: in ask mode a first turn that asks shows ask-compact and spends no cooldown', { options: { guard_mode: 'ask', soft_limit: 100000, hard_limit: 200000 } }, async ($, on) => {
  const store = new Map<string, unknown>()
  const s = stub(on, { id: 'k1', breakdown: bd(), store, ctx: 250_000 })
  await begin($)
  await step($)
  await done($)
  expect(s.state.get('event')).toEqual({ kind: 'ask-compact', hard: true })
  expect(store.has('health:notice')).toBe(false)
})

test('5/6: the band rounds sizes down and prints duplicate tokens plain', async ($, on) => {
  const s = stub(on, { id: 'r1' })
  const mount = () => $.ui.mount({ plugin: 'longhaul', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
  s.state.set('event', { kind: 'compacted', before: 312_900, after: 41_900 })
  expect(await (await mount()).find({ text: 'compacted 312k \u2192 41k \u00b7 plan, decisions and open items kept' })).toBeDefined()
  s.state.set('event', { kind: 'health', total: 93_900, unusedMcp: 0, duplicate: 500 })
  expect(await (await mount()).find({ text: 'sessions start at 93k \u00b7 500 tokens of it repeat across memory files \u00b7 /longhaul health' })).toBeDefined()
})

test('7: a trailing newline is not a line', async ($, on) => {
  const text = Array.from({ length: 200 }, (_, i) => `row ${i}`).join('\n') + '\n'
  const s = stub(on, { id: 'l1', breakdown: bd(), files: { '/p/CLAUDE.md': text, '/p/AGENTS.md': 'x' } })
  await done($)
  expect(saved(s.files, 'l1').base.memory[0].lines).toBe(200)
})

const seedWithBase = (id: string, project: string, at: number, total: number) => ({
  ...newRecord(id, project, now - 2 * DAY),
  base: { at, total, mcp: {}, memory: [], skills: { count: 0, tokens: 0 }, duplicate: { lines: 0, tokens: 0, files: [] } },
})

test('8: the same project is preferred, and the project is named', async ($, on) => {
  stub(on, { id: 'p1', cwd: '/w/proj-x', seeds: [seedWithBase('seed-a', 'other', now - DAY, 50_000), seedWithBase('seed-b', 'proj-x', now - 2 * DAY, 61_000)] })
  const r: any = await $.command.run({ command: 'longhaul', args: 'health' })
  expect(r.text).toContain('61,000 tokens')
  expect(r.text).toContain('Snapshot from project proj-x.')
})

test('8: with none in the project, the latest overall is shown with its project', async ($, on) => {
  stub(on, { id: 'p2', seeds: [seedWithBase('seed-a', 'other', now - DAY, 50_000), seedWithBase('seed-b', 'older', now - 2 * DAY, 61_000)] })
  const r: any = await $.command.run({ command: 'longhaul', args: 'health' })
  expect(r.text).toContain('50,000 tokens')
  expect(r.text).toContain('Snapshot from project other.')
})

test('9: a light session reads no records for the heads-up', async ($, on) => {
  const s = stub(on, { id: 'g1', breakdown: bd({ totalTokens: 30_000, mcpTools: [] }) })
  await done($)
  expect(s.calls.lists).toBe(0)
})

test('11: a Managed memory file gets no shorten advice; a plugin server is turned off with /plugin', async () => {
  const a = healthAdvice(
    snap({ mcp: { plugin_foo_bar: { tools: 3, tokens: 12_000, label: 'plugin:foo:bar' } }, memory: [{ path: '/m/MANAGED.md', tokens: 5000, lines: 300, type: 'Managed' }] }),
    {},
  )
  const text = a.map((x) => x.text).join('\n')
  expect(text).toContain('/plugin')
  expect(text).not.toContain('(/mcp)')
  expect(text).not.toContain('MANAGED.md')
})
