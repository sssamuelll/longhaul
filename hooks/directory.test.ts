import { test, expect } from 'claude-code/testing'
import { HANDOFF } from './handoff'
import { newRecord } from './ledger'

// What the plugin directory's checks ask of 0.2: records in the plugin store, no file writes,
// no environment reads, no programs, subagents started as asked, Sonnet suggested in the system prompt.

const DAY = 86_400_000
const now = new Date(2026, 9, 18, 12, 0).getTime()
const u = (o: object) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o })

function stub(on: any, o: { store?: Map<string, unknown>; files?: Record<string, string>; model?: string; full?: () => boolean } = {}) {
  const store = o.store ?? new Map<string, unknown>()
  const files = o.files ?? {}
  const banned: string[] = []
  const reads: string[] = []
  const prompts: any[] = []
  on('session.id', async () => ({ value: 'd1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  on('session.model', async () => ({ value: o.model ?? 'claude-opus-5-5' }))
  on('session.usage', async () => ({ value: { rateLimits: [], context: {} } as never }))
  on('session.start', async () => ({ cwd: '/w/p' }))
  on('session.end', async () => ({}) as never)
  on('clock.now', async () => ({ value: now }))
  on('env.get', async (_$: any, e: any) => (banned.push(`env.get ${e.name}`), { value: undefined }))
  on('fs.write', async (_$: any, e: any) => (banned.push(`fs.write ${e.path}`), { value: undefined }))
  on('fs.list', async (_$: any, e: any) => (banned.push(`fs.list ${e.path}`), { value: [] }))
  on('process.run', async () => (banned.push('process.run'), { value: { exitCode: 0, stdout: '', stderr: '' } as never }))
  on('fs.read', async (_$: any, e: any) => (reads.push(e.path), e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.exists', async (_$: any, e: any) => ({ value: e.path in files }))
  on('store.get', async (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: any, e: any) => (o.full?.() ? { deny: 'store over 4 MiB' } : (store.set(e.key, e.value), { value: undefined })))
  on('store.delete', async (_$: any, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('state.get', async () => ({ value: { value: undefined, version: 0 } as never }))
  on('state.set', async () => ({ value: { isSet: true, version: 1 } as never }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [] }))
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$: any, e: any) => (prompts.push(e), { text: e.text }))
  on('turn.complete', async () => ({ text: '' }))
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', ...u({ cache_read_input_tokens: 50000 }) } } as never
  })
  return { store, banned, reads, prompts }
}

const start = ($: any) => $.session.start({ cwd: '/w/p', surface: null, isInteractive: true } as never)
async function turn($: any) {
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
}

test('a whole session keeps its record in the plugin store and writes no file, reads no environment, runs nothing', async ($, on) => {
  const s = stub(on)
  await start($)
  await $.prompt.submit({ text: 'rename the helper in utils' })
  await turn($)
  await $.command.run({ command: 'longhaul', args: '' })
  await $.command.run({ command: 'longhaul', args: 'health' })
  const page: any = await $.command.run({ command: 'longhaul', args: 'page' })
  expect(page.text).not.toContain('report.html')
  await $.session.end({ reason: 'exit' } as never)
  expect(s.banned).toEqual([])
  const rec = s.store.get('session:d1') as { id: string; steps: number }
  expect(rec.id).toBe('d1')
  expect(rec.steps).toBe(1)
})

test('records whose last activity is over 21 days old leave the store; recent ones and other keys stay', async ($, on) => {
  const store = new Map<string, unknown>()
  store.set('session:old', newRecord('old', 'p', now - 30 * DAY))
  store.set('session:new', newRecord('new', 'p', now - 2 * DAY))
  const rated = newRecord('rated', 'p', now - 40 * DAY)
  rated.rate = [[now - 3 * DAY, 10, 1]]
  store.set('session:rated', rated)
  store.set('day:2026-10-17', 15)
  stub(on, { store })
  await start($)
  await $.command.run({ command: 'longhaul', args: '' })
  expect(store.has('session:old')).toBe(false)
  expect(store.has('session:new')).toBe(true)
  expect(store.has('session:rated')).toBe(true)
  expect(store.get('day:2026-10-17')).toBe(15)
})

test('a full store drops the oldest session record and saves again', async ($, on) => {
  const store = new Map<string, unknown>()
  store.set('session:a', newRecord('a', 'p', now - 5 * DAY))
  store.set('session:b', newRecord('b', 'p', now - 1 * DAY))
  stub(on, { store, full: () => store.has('session:a') }) // over 4 MiB while the oldest record is still there
  await start($)
  await turn($)
  expect(store.has('session:a')).toBe(false)
  expect(store.has('session:b')).toBe(true)
  expect((store.get('session:d1') as { steps: number }).steps).toBe(1)
})

test('agent.spawn passes every subagent on unchanged', async ($, on) => {
  stub(on)
  const spawned: any[] = []
  on('agent.spawn', async (_$: any, e: any) => (spawned.push(e), { model: e.model ?? 'inherit', agentId: 'a1' }) as never)
  await ($.agent.spawn as any)({ prompt: 'find x', subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', fork: false })
  await ($.agent.spawn as any)({ prompt: 'find x', subagentType: 'Explore', parentModel: 'claude-opus-5-5', fork: false })
  expect(spawned.map((e) => e.model)).toEqual([undefined, undefined])
})

const compose = ($: any, model: string, tools: string[]) =>
  $.prompt.compose({ model, promptModel: model, surfaces: ['terminal'], tools, outputStyle: null, traits: [] } as never)
const base = { sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' }] }

test('on Opus or Fable with the Agent tool, the system prompt asks for Sonnet subagents, last and on the session side', async ($, on) => {
  stub(on)
  on('prompt.compose', async () => base as never)
  for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
    const r: any = await compose($, model, ['Agent', 'Read'])
    expect(r.sections.length).toBe(2)
    expect(r.sections[0].id).toBe('intro')
    const last = r.sections.at(-1)
    expect(last.id).toBe('longhaul:subagents')
    expect(last.scope).toBe('session')
    expect(last.text).toContain('sonnet')
  }
})

test('no subagent section on Sonnet, without the Agent tool, or with classifier_mode off', async ($, on) => {
  stub(on)
  on('prompt.compose', async () => base as never)
  expect(((await compose($, 'claude-sonnet-5-5', ['Agent'])) as any).sections).toEqual(base.sections)
  expect(((await compose($, 'claude-opus-5-5', ['Read'])) as any).sections).toEqual(base.sections)
})

test('classifier_mode off adds no subagent section', { options: { classifier_mode: 'off' } }, async ($, on) => {
  stub(on)
  on('prompt.compose', async () => base as never)
  expect(((await compose($, 'claude-opus-5-5', ['Agent'])) as any).sections).toEqual(base.sections)
})

test('rules_file replaces the built-in rules', { options: { rules_file: '/r/rules.json' } }, async ($, on) => {
  const s = stub(on, { files: { '/r/rules.json': JSON.stringify([{ id: 'custom', verdict: 'sonnet', pattern: 'zebra' }]) } })
  await start($)
  await $.prompt.submit({ text: 'paint the zebra' })
  expect(s.prompts.at(-1).context).toContain(HANDOFF)
  expect(s.reads).toContain('/r/rules.json')
})

test('without rules_file the built-in rules are used and no rules file is read', async ($, on) => {
  const s = stub(on)
  await start($)
  await $.prompt.submit({ text: 'paint the zebra' })
  expect(s.prompts.at(-1).context ?? []).not.toContain(HANDOFF)
  expect(s.reads.filter((p) => p.includes('rules'))).toEqual([])
})
