import { test, expect } from 'claude-code/testing'
import { meterSegs } from './band'

const props = { hasSurvey: false, isWorking: false } as never

function stub(on: any, ev: unknown, seen: { compact: number; state: Map<string, unknown> }) {
  seen.state.set('event', ev)
  on('session.id', async () => ({ value: 'bn1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  on('env.get', async () => ({ value: undefined }))
  on('fs.read', async () => ({ deny: 'ENOENT' }))
  on('fs.write', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('state.get', async (_$: any, e: any) => ({ value: { value: seen.state.get(e.key), version: 0 } as never }))
  on('state.set', async (_$: any, e: any) => (seen.state.set(e.key, e.value), { value: { isSet: true, version: 1 } as never }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('session.compact', async () => (seen.compact++, { messages: [{ role: 'user', text: 's', toolUses: [] }] } as never))
}

for (const surface of ['terminal', 'desktop'] as const) {
  const mount = ($: any) => $.ui.mount({ plugin: 'longhaul', surface, component: 'AbovePrompt', props })

  test(`${surface}: compacted and over-pace show their text, null shows nothing`, async ($, on) => {
    const seen = { compact: 0, state: new Map<string, unknown>() }
    stub(on, { kind: 'compacted', before: 312000, after: 41000 }, seen)
    expect(await (await mount($)).find({ text: 'compacted 312k \u2192 41k \u00b7 plan, decisions and open items kept' })).toBeDefined()
    seen.state.set('event', { kind: 'over-pace', today: 18, allowance: 11, runsOutAt: new Date(2026, 9, 20, 12).getTime() })
    expect(await (await mount($)).find({ text: 'today 18% of 11% \u00b7 at this pace the week lasts to Tuesday \u00b7 /longhaul shows where it went' })).toBeDefined()
    seen.state.set('event', null)
    expect(await (await mount($)).find({ key: 'compact' })).toBeUndefined()
  })

  test(`${surface}: ask-compact buttons`, async ($, on) => {
    const seen = { compact: 0, state: new Map<string, unknown>() }
    stub(on, { kind: 'ask-compact', hard: false }, seen)
    const ui = await mount($)
    expect(await ui.find({ text: /a good moment to compact \u00b7 keeps the plan, decisions and open items/ })).toBeDefined()
    await ui.press({ key: 'later' })
    expect(seen.state.get('event')).toBe(null)
    seen.state.set('event', { kind: 'ask-compact', hard: true })
    expect(await (await mount($)).find({ text: 'Compact now' })).toBeDefined()
    await (await mount($)).press({ key: 'compact' })
    expect(seen.compact).toBe(1)
  })
}

test('the ask waits for an idle prompt; a finished-event line still shows while working', async ($, on) => {
  const seen = { compact: 0, state: new Map<string, unknown>() }
  stub(on, { kind: 'ask-compact', hard: false }, seen)
  const busy = { hasSurvey: false, isWorking: true } as never
  const mountBusy = ($: any) => $.ui.mount({ plugin: 'longhaul', surface: 'terminal', component: 'AbovePrompt', props: busy })
  expect(await (await mountBusy($)).find({ key: 'compact' })).toBeUndefined()
  seen.state.set('event', { kind: 'compacted', before: 312000, after: 41000 })
  expect(await (await mountBusy($)).find({ text: 'compacted 312k \u2192 41k \u00b7 plan, decisions and open items kept' })).toBeDefined()
})

// ---- the meter row ----

const noon = (d: number) => new Date(2026, 9, d, 12).getTime()
const pace0 = { weekly: 38, today: 9, allowance: 11, resetsAt: noon(23), runsOutAt: null, stale: false } // resets on a Friday
const meter0 = { ctx: 24518, hard: 300000, pace: pace0 }
const row = (m: any, cols: number) => meterSegs(m, cols).map((s) => s.text).join('')

test('the meter row: three gauges in three colours, the pace in calm words', async () => {
  const r = row(meter0, 120)
  expect(r).toMatch(/^\u258e context \u2501+\u2500+ 24k {3}week \u2501+\u2500+ 38% {3}today \u2501+\u2500+ 9% of 11% {3}on pace \u00b7 lasts to Fri$/)
  expect(r.length).toBeLessThanOrEqual(120)
  const colours = new Set(meterSegs(meter0, 120).filter((s) => s.text.includes('\u2501')).map((s) => s.color))
  expect(colours.size).toBe(3)
  const fast = row({ ...meter0, pace: { ...pace0, runsOutAt: noon(20) } }, 120)
  expect(fast).toMatch(/at this pace \u00b7 lasts to Tue$/)
  expect(fast + r).not.toMatch(/!|runs out|over/)
})

test('the meter row fits the band: bars shrink, then the pace words go, then the bars', async () => {
  for (const cols of [100, 80, 60]) expect(row(meter0, cols).length).toBeLessThanOrEqual(cols)
  expect(row(meter0, 80)).toContain('\u2501')
  expect(row(meter0, 80)).not.toContain('lasts to')
  expect(row(meter0, 40)).not.toContain('\u2501')
  expect(row(meter0, 40)).toContain('today 9% of 11%')
})

test('the meter row without a weekly limit, and in a week that has already reset', async () => {
  expect(row({ ctx: 41000, hard: 300000, pace: null }, 120)).toMatch(/^\u258e context \u2501*\u2500+ 41k$/)
  const stale = row({ ...meter0, pace: { ...pace0, stale: true } }, 120)
  expect(stale).toMatch(/ 38%$/)
  expect(stale).not.toContain('today')
})

test('the band draws the meter under the event, and the meter alone while an ask waits', async ($, on) => {
  const seen = { compact: 0, state: new Map<string, unknown>() }
  stub(on, { kind: 'compacted', before: 709000, after: 24000 }, seen)
  seen.state.set('meter', meter0)
  const draw = (isWorking: boolean) => $.ui.mount({ plugin: 'longhaul', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking } as never })
  const ui = await draw(false)
  expect(await ui.find({ text: /compacted 709k/ })).toBeDefined()
  expect(await ui.find({ text: /on pace/ })).toBeDefined()
  seen.state.set('event', { kind: 'ask-compact', hard: false })
  const busy = await draw(true)
  expect(await busy.find({ key: 'compact' })).toBeUndefined()
  expect(await busy.find({ text: /on pace/ })).toBeDefined()
})

// "Not now" is remembered by the guard: the same ask does not come back at the next turn end.
const ask = { options: { guard_mode: 'ask', soft_limit: 100000, hard_limit: 200000 } }
let ctxNow = 0
async function turnEnd($: any, on: any, first: boolean) {
  if (first) {
    on('turn.step', async function* () {
      return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: ctxNow, cache_creation_input_tokens: 0 } } as never
    })
    on('turn.complete', async () => ({ text: '' }))
    on('tool.call', async () => ({ result: {} }) as never)
  }
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
}

for (const [name, hard, ctx] of [['hard', true, 250000], ['soft', false, 120000]] as const) {
  test(`later on a ${name} ask is remembered by the guard`, ask, async ($, on) => {
    const seen = { compact: 0, state: new Map<string, unknown>() }
    stub(on, null, seen)
    ctxNow = ctx
    await turnEnd($, on, true)
    if (!hard) await ($.tool.call as any)({ tool: 'Bash', input: { command: 'git commit -m x' } })
    if (!hard) await turnEnd($, on, false)
    expect(seen.state.get('event')).toEqual({ kind: 'ask-compact', hard })
    await (await $.ui.mount({ plugin: 'longhaul', surface: 'terminal', component: 'AbovePrompt', props })).press({ key: 'later' })
    expect(seen.state.get('event')).toBe(null)
    await turnEnd($, on, false)
    expect(seen.state.get('event')).toBe(null)
  })
}
