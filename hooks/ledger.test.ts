import { test, expect } from 'claude-code/testing'
import { MAX_RATE, addStep, newRecord, totalCost, type SessionRecord } from './ledger'

const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true)
const u = (o: object) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o })

test('addStep prices a main step into its context bucket', async () => {
  const rec = newRecord('s', 'p', 1)
  addStep(rec, 'claude-opus-5-5', u({ cache_read_input_tokens: 300_000, output_tokens: 1_000 }), false)
  expect(rec.steps).toBe(1)
  expect(rec.peakCtx).toBe(300_000)
  near(rec.byBucket['200to400k'], totalCost(rec.cost))
  near(rec.cost.read, 0.06)
})
test('a subagent step counts apart and leaves peakCtx alone', async () => {
  const rec = newRecord('s', 'p', 1)
  addStep(rec, 'claude-opus-5-5', u({ cache_read_input_tokens: 300_000 }), true)
  expect(rec.subSteps).toBe(1)
  expect(rec.steps).toBe(0)
  expect(rec.peakCtx).toBe(0)
})
test('an unknown model counts the step but adds no cost', async () => {
  const rec = newRecord('s', 'p', 1)
  addStep(rec, 'gpt-x', u({ cache_read_input_tokens: 50_000 }), false)
  expect(rec.steps).toBe(1)
  expect(rec.peakCtx).toBe(50_000)
  expect(totalCost(rec.cost)).toBe(0)
})
test('a partial usage object never produces NaN', async () => {
  const rec = newRecord('s', 'p', 1)
  addStep(rec, 'claude-opus-5-5', { output_tokens: 1_000 } as never, false)
  addStep(rec, 'claude-opus-5-5', { input_tokens: 'x', cache_read_input_tokens: NaN } as never, false)
  expect(Number.isFinite(totalCost(rec.cost))).toBe(true)
  expect(rec.steps).toBe(2)
})
// The plugin store in memory; a stored value is read back as JSON, as the real one does.
function stub(on: any, id: string, store: Map<string, unknown>, o: { delay?: number; cwd?: string } = {}) {
  const tick = () => new Promise((r) => setTimeout(r, o.delay ?? 0))
  on('session.id', async () => ({ value: id }))
  on('session.cwd', async () => ({ value: o.cwd ?? '/w/p' }))
  on('store.get', async (_$: any, e: any) => (await tick(), { value: store.get(e.key) }))
  on('store.set', async (_$: any, e: any) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', async (_$: any, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('clock.now', async () => ({ value: Date.now() }))
  on('ui.log', async () => ({ value: undefined }))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', ...u({ output_tokens: 10 }) } } as never
  })
  on('tool.call', async () => ({ result: {} }) as never)
  on('turn.complete', async () => ({ text: '' }))
}
const step = async ($: any) => {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
}
const complete = ($: any) => $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
const recordOf = (store: Map<string, unknown>, id: string): SessionRecord => store.get(`session:${id}`) as SessionRecord

test('a stored record is loaded and its totals continue', async ($, on) => {
  const store = new Map<string, unknown>()
  const rec = newRecord('s1', 'p', 1)
  for (let i = 0; i < 3; i++) addStep(rec, 'claude-opus-5-5', u({ output_tokens: 10 }), false)
  store.set('session:s1', rec)
  stub(on, 's1', store)
  await step($)
  await complete($)
  expect(recordOf(store, 's1').steps).toBe(4)
  expect(recordOf(store, 's1').startedAt).toBe(1)
})
test('a record that is not valid, or missing, starts a fresh one', async ($, on) => {
  const store = new Map<string, unknown>([['session:bad', '{oops'], ['session:odd', { v: 2, id: 'odd' }]])
  stub(on, 'bad', store)
  const before = Date.now()
  await step($)
  await complete($)
  expect(recordOf(store, 'bad').steps).toBe(1)
  expect(recordOf(store, 'bad').startedAt).toBeGreaterThanOrEqual(before)
})
test('the report counts records started or rated inside the week and deletes those idle for 21 days', async ($, on) => {
  const DAY = 86_400_000
  const now = Date.now()
  const ancient = newRecord('ancient', 'p', now - 25 * DAY)
  const started = newRecord('new', 'p', now - DAY)
  const rated = { ...newRecord('rated', 'p', now - 25 * DAY), weekResetsAt: new Date(now + 3 * DAY).toISOString(), rate: [[now - DAY, 10, 1]] }
  const store = new Map<string, unknown>([['session:ancient', ancient], ['session:new', started], ['session:rated', rated]])
  stub(on, 'cur', store)
  on('tool.list', async () => ({ value: [] }))
  const r: any = await $.command.run({ command: 'longhaul', args: '' })
  expect(r.text).toContain('across 2 sessions')
  expect([...store.keys()].sort()).toEqual(['session:new', 'session:rated'])
})

test('the hooks record steps and save the ledger on turn.complete', async ($, on) => {
  const store = new Map<string, unknown>()
  stub(on, 'sess1', store, { cwd: 'C:\\work\\myproj' })
  await step($)
  await $.tool.call({ tool: 'mcp__gh__issue', tool_use_id: 'x' } as never)
  await $.tool.call({ tool: 'mcp__gh__pr', tool_use_id: 'y' } as never)
  await complete($)
  expect([...store.keys()]).toEqual(['session:sess1'])
  const saved = recordOf(store, 'sess1')
  expect(saved.steps).toBe(1)
  expect(saved.project).toBe('myproj')
  expect(saved.mcpCalls.gh).toBe(2)
})

test('a save keeps only the newest rate points', async ($, on) => {
  const store = new Map<string, unknown>()
  const rec = newRecord('big', 'p', 1)
  for (let i = 0; i < 2500; i++) rec.rate.push([i, 1, 1])
  store.set('session:big', rec)
  stub(on, 'big', store)
  await step($)
  await complete($)
  const back = recordOf(store, 'big')
  expect(back.rate.length).toBe(MAX_RATE)
  expect(back.rate[0][0]).toBe(500)
  expect(back.rate[MAX_RATE - 1][0]).toBe(2499)
})

test('concurrent steps on a fresh module share one record', async ($, on) => {
  const store = new Map<string, unknown>()
  stub(on, 'sess2', store, { delay: 5 })
  await Promise.all([step($), step($)])
  await complete($)
  expect(recordOf(store, 'sess2').steps).toBe(2)
})

test('250 compaction entries save as the newest 200', async ($, on) => {
  const store = new Map<string, unknown>()
  const rec = newRecord('cl', 'p', 1)
  for (let i = 0; i < 250; i++) rec.compactionLog.push({ at: i, trigger: 'plugin', reason: 'task-done' })
  store.set('session:cl', rec)
  stub(on, 'cl', store)
  await step($)
  await complete($)
  const back = recordOf(store, 'cl')
  expect(back.compactionLog.length).toBe(200)
  expect(back.compactionLog[0].at).toBe(50)
})

test('an old record without a compaction log loads with an empty one', async ($, on) => {
  const old: any = newRecord('cl', 'p', 1)
  delete old.compactionLog
  const store = new Map<string, unknown>([['session:cl', old]])
  stub(on, 'cl', store)
  await step($)
  await complete($)
  expect(recordOf(store, 'cl').compactionLog).toEqual([])
})
