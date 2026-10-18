import { test, expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { MAX_RATE, addStep, newRecord, loadRecord, saveRecord, listRecords, totalCost, dataDir } from './ledger'

const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true)
const u = (o: object) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o })

// An in-memory $ with just the nouns the ledger touches.
function fake(files: Record<string, string> = {}) {
  const $ = {
    env: { get: async (n: string) => ({ CLAUDE_CONFIG_DIR: '/cfg' } as Record<string, string>)[n] },
    fs: {
      read: async (p: string) => {
        if (!(p in files)) throw new Error('ENOENT')
        return files[p]
      },
      write: async (p: string, t: string) => void (files[p] = t),
      list: async (p: string) =>
        Object.keys(files)
          .filter((k) => k.startsWith(p + '/'))
          .map((k) => ({ name: k.slice(p.length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
    },
  }
  return { $: $ as unknown as EngineInterface, files }
}

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
test('addStep after reload continues totals', async () => {
  const { $ } = fake()
  const rec = newRecord('s1', 'p', 1)
  for (let i = 0; i < 3; i++) addStep(rec, 'claude-opus-5-5', u({ output_tokens: 10 }), false)
  await saveRecord($, rec)
  const back = await loadRecord($, 's1', 'p', 2)
  addStep(back, 'claude-opus-5-5', u({ output_tokens: 10 }), false)
  expect(back.steps).toBe(4)
  expect(back.startedAt).toBe(1)
})
test('loadRecord recovers from bad JSON and from a missing file', async () => {
  const { $ } = fake({ '/cfg/longhaul/sessions/s1.json': '{oops' })
  expect((await loadRecord($, 's1', 'p', 5)).steps).toBe(0)
  expect((await loadRecord($, 'nope', 'p', 5)).startedAt).toBe(5)
})
test('listRecords keeps records started or rated since the cutoff', async () => {
  const { $ } = fake()
  const old = newRecord('old', 'p', 100)
  const started = newRecord('new', 'p', 900)
  const rated = newRecord('rated', 'p', 100)
  rated.rate.push([950, 10, 1])
  for (const r of [old, started, rated]) await saveRecord($, r)
  const ids = (await listRecords($, 500)).map((r) => r.id).sort()
  expect(ids.join()).toBe('new,rated')
})

test('the hooks record steps and save the ledger on turn.complete', async ($, on) => {
  const files: Record<string, string> = {}
  on('session.id', async () => ({ value: 'sess1' }))
  on('session.cwd', async () => ({ value: 'C:\\work\\myproj' }))
  on('env.get', async (_$, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))
  on('fs.read', async (_$, e) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', async (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', ...u({ cache_read_input_tokens: 300_000 }) } } as never
  })
  on('tool.call', async () => ({ result: {} }) as never)
  on('turn.complete', async () => ({ text: '' }))
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
  await $.tool.call({ tool: 'mcp__gh__issue', tool_use_id: 'x' } as never)
  await $.tool.call({ tool: 'mcp__gh__pr', tool_use_id: 'y' } as never)
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
  // the engine normalises the path per platform (D:\cfg\... on Windows)
  const paths = Object.keys(files)
  expect(paths.length).toBe(1)
  expect(/cfg.longhaul.sessions.sess1\.json$/.test(paths[0])).toBe(true)
  const saved = JSON.parse(files[paths[0]])
  expect(saved.steps).toBe(1)
  expect(saved.project).toBe('myproj')
  expect(saved.mcpCalls.gh).toBe(2)
})

test('saveRecord keeps only the newest rate points and decisions', async () => {
  const { $, files } = fake()
  const rec = newRecord('big', 'p', 1)
  for (let i = 0; i < 2500; i++) rec.rate.push([i, 1, 1])
  await saveRecord($, rec)
  const back = JSON.parse(Object.values(files)[0])
  expect(back.rate.length).toBe(MAX_RATE)
  expect(back.rate[0][0]).toBe(500)
  expect(back.rate[MAX_RATE - 1][0]).toBe(2499)
})

test('concurrent steps on a fresh module share one record', async ($, on) => {
  const files: Record<string, string> = {}
  const tick = () => new Promise((r) => setTimeout(r, 5))
  on('session.id', async () => ({ value: 'sess2' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  on('env.get', async (_$, e) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/cfg' : undefined }))
  on('fs.read', async (_$, e) => {
    await tick()
    return e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }
  })
  on('fs.write', async (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', ...u({ output_tokens: 10 }) } } as never
  })
  on('turn.complete', async () => ({ text: '' }))
  const run = async () => {
    for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
  }
  await Promise.all([run(), run()])
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
  expect(JSON.parse(Object.values(files)[0]).steps).toBe(2)
})

test('on Windows the data folder starts from USERPROFILE, elsewhere from HOME', async () => {
  const at = async (vars: Record<string, string>) => {
    return dataDir({ env: { get: async (n: string) => vars[n] } } as unknown as EngineInterface)
  }
  expect(await at({ OS: 'Windows_NT', USERPROFILE: 'C:/Users/a', HOME: 'D:/other' })).toBe('C:/Users/a/.claude/longhaul')
  expect(await at({ HOME: '/home/a', USERPROFILE: '/x' })).toBe('/home/a/.claude/longhaul')
  expect(await at({ OS: 'Windows_NT', HOME: 'C:/h' })).toBe('C:/h/.claude/longhaul')
})

test('250 compaction entries save as the newest 200; old records load with an empty log', async () => {
  const { $, files } = fake()
  const rec = newRecord('cl', 'p', 1)
  for (let i = 0; i < 250; i++) rec.compactionLog.push({ at: i, trigger: 'plugin', reason: 'task-done' })
  await saveRecord($, rec)
  const back = JSON.parse(Object.values(files)[0])
  expect(back.compactionLog.length).toBe(200)
  expect(back.compactionLog[0].at).toBe(50)
  const old = { ...back }
  delete old.compactionLog
  const f2: Record<string, string> = { '/cfg/longhaul/sessions/cl.json': JSON.stringify(old) }
  const loaded = await loadRecord(fake(f2).$, 'cl', 'p', 1)
  expect(loaded.compactionLog).toEqual([])
})
