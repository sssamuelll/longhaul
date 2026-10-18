import { test, expect } from 'claude-code/testing'
import { pace, parseReset } from './budget'
import { buildReport, renderText } from './report'

const resetsAt = new Date(2026, 9, 23, 4, 0).getTime() // a Friday, 04:00
const now = new Date(2026, 9, 17, 16, 0).getTime() // the Saturday before: 1.5 days into the week
const p = pace({ percent: 36, resetsAt, now, midnightPercent: 27 })
const weekStart = resetsAt - 7 * 86_400_000

test('pace', async () => {
  expect(p.today).toBe(9)
  expect(Math.round(p.allowance * 100)).toBe(1164)
  expect(new Date(p.runsOutAt!).getDay()).toBe(2) // Tuesday
  expect(pace({ percent: 10, resetsAt, now, midnightPercent: 9 }).runsOutAt).toBe(null)
})

test('parseReset takes ISO and epoch seconds', async () => {
  expect(parseReset('2026-10-23T04:00:00Z')).toBe(Date.parse('2026-10-23T04:00:00Z'))
  expect(parseReset('1792000000')).toBe(1792000000000)
  expect(parseReset(undefined)).toBe(null)
})

function stub(on: any, o: { percent: number; now: number; mode?: string }) {
  const store = new Map<string, unknown>()
  const status: unknown[] = []
  const state = new Map<string, unknown>()
  on('session.id', async () => ({ value: 'b1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async (_$: any, e: any) => (status.push(e.text), { value: undefined }))
  on('clock.now', async () => ({ value: o.now }))
  on('store.get', async (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', async (_$: any, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('state.get', async (_$: any, e: any) => ({ value: { value: state.get(e.key), version: 0 } as never }))
  on('state.set', async (_$: any, e: any) => (state.set(e.key, e.value), { value: { isSet: true, version: 1 } as never }))
  on('session.usage', async () => ({
    value: { rateLimits: [{ kind: 'seven_day', percentUsed: o.percent, resetsAt: new Date(resetsAt).toISOString() }] } as never,
  }))
  on('turn.complete', async () => ({ text: '' }))
  return { store, status, state }
}

test('a main turn end sets the meter, the midnight snapshot and one over-pace event a day', async ($, on) => {
  {
    const s = stub(on, { percent: 36, now })
    s.store.set('day:2026-10-17', 15) // 21 today against 11 allowed
    await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
    expect(s.state.get('meter')).toMatchObject({ ctx: 0, hard: 300000, pace: { weekly: 36, today: 21, stale: false } })
    expect(s.status).toEqual([]) // the gauges are drawn in the band; the plain status line stays empty
    expect(JSON.stringify([...s.state.values()])).toContain('over-pace')
    expect(s.store.get('warned:2026-10-17')).toBe(true)
    s.state.clear()
    await $.turn.complete({ turnId: 't2', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
    expect(JSON.stringify([...s.state.values()])).not.toContain('over-pace')
  }
})

test('allowance is capped at what is left, and a past reset shows no pace', async () => {
  const near = pace({ percent: 91, resetsAt, now: resetsAt - 3_600_000, midnightPercent: 82 })
  expect(near.allowance).toBe(9)
  const stale = pace({ percent: 91, resetsAt, now: resetsAt + 1000, midnightPercent: 82 })
  expect(stale.runsOutAt).toBe(null)
})

test('the turn end saves the new rate point, and a reset after the snapshot zeroes it', async ($, on) => {
  const s = stub(on, { percent: 3, now })
  s.store.set('day:2026-10-17', 90) // snapshot from before the weekly reset
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
  expect(s.store.get('day:2026-10-17')).toBe(0)
  expect((s.state.get('meter') as any).pace.today).toBe(3)
  const saved = s.store.get('session:b1') as any
  expect(saved.rate.at(-1)[1]).toBe(3)
  expect(saved.weekResetsAt).toBe(new Date(resetsAt).toISOString())
})

test('no projection in the first six hours of the week', async () => {
  const early = pace({ percent: 20, resetsAt, now: weekStart + 5 * 3_600_000, midnightPercent: 0 })
  expect(early.runsOutAt).toBe(null)
  const later = pace({ percent: 20, resetsAt, now: weekStart + 7 * 3_600_000, midnightPercent: 0 })
  expect(later.runsOutAt).not.toBe(null)
})

test('budget_mode off hides the gauges and the warning but still records the weekly meter', { options: { budget_mode: 'off' } }, async ($, on) => {
  const s = stub(on, { percent: 36, now })
  s.store.set('day:2026-10-17', 15)
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
  expect(s.state.get('meter') ?? null).toBe(null)
  expect(JSON.stringify([...s.state.values()])).not.toContain('over-pace')
  const saved = s.store.get('session:b1') as any
  expect(saved.rate.at(-1)[1]).toBe(36)
  expect(saved.weekResetsAt).toBe(new Date(resetsAt).toISOString())
  const out = renderText(buildReport([saved], now, []))
  expect(out).toContain('Used 36% of the weekly limit')
})

// Stubbed before the test first calls $, as the harness requires.
const compactStub = (on: any, after: number) =>
  on('session.compact', async () => ({ messages: [{ role: 'user', text: 's', toolUses: [] }], tokensBefore: 709000, tokensAfter: after }) as never)
const compact = ($: any) => ($.session.compact as (a: object) => Promise<unknown>)({ trigger: 'manual', messages: [{ role: 'user', text: 's', toolUses: [] }] })

test('a compaction redraws the context gauge at once with the new size', async ($, on) => {
  const s = stub(on, { percent: 36, now })
  compactStub(on, 24518)
  s.store.set('day:2026-10-17', 15)
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
  await compact($)
  expect(s.state.get('meter')).toMatchObject({ ctx: 24518, pace: { weekly: 36, today: 21 } })
})

test('with budget_mode off a compaction draws no meter', { options: { budget_mode: 'off' } }, async ($, on) => {
  const s = stub(on, { percent: 36, now })
  compactStub(on, 24518)
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
  await compact($)
  expect(s.state.get('meter') ?? null).toBe(null)
})
