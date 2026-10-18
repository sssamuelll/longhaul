import { test, expect, mock } from 'claude-code/testing'
import { HANDOFF, ASK_HANDOFF, isExpensiveMain, routeSubagent, guessOutcome, noteEdit } from './handoff'
import { readConfig } from './config'
import type { Decision } from './ledger'

const cfg = readConfig({})
const base = { subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', fork: false }

test('routeSubagent', async () => {
  expect(routeSubagent({ ...base, fork: true }, cfg)).toBe(undefined)
  expect(routeSubagent({ ...base, model: 'opus' }, cfg)).toBe(undefined)
  expect(routeSubagent(base, cfg)).toBe('sonnet')
  expect(routeSubagent({ ...base, parentModel: 'claude-sonnet-5-5' }, cfg)).toBe(undefined)
  expect(routeSubagent({ ...base, subagentType: 'claude' }, cfg)).toBe('sonnet')
  expect(routeSubagent({ ...base, subagentType: 'Explore' }, cfg)).toBe(cfg.exploreModel)
  expect(routeSubagent({ ...base, subagentType: 'code-review' }, cfg)).toBe(undefined)
  expect(routeSubagent({ ...base, subagentType: 'my-agent' }, cfg)).toBe(undefined)
  expect(isExpensiveMain('claude-fable-1')).toBe(true)
  expect(isExpensiveMain('claude-haiku-5')).toBe(false)
})

const d = (o: Partial<Decision>): Decision => ({ at: 1, verdict: 'sonnet', ruleIds: ['en.search'], mode: 'auto', outcome: 'pending', subFiles: [], turnsSince: 3, ...o })

test('guessOutcome', async () => {
  expect(guessOutcome(d({ subFiles: ['a.ts'] }), ['a.ts'])).toMatchObject({ outcome: 'fixed', guessed: true })
  expect(guessOutcome(d({ subFiles: ['a.ts'] }), [])).toMatchObject({ outcome: 'accepted', guessed: true })
  expect(guessOutcome(d({ outcome: 'fixed' }), ['a.ts']).outcome).toBe('fixed')
})

const reads: string[] = []
function stub(on: any, model: string, files: Record<string, string> = {}, clock = true) {
  const seen: any[] = []
  on('session.id', async () => ({ value: 'h1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  on('session.model', async () => ({ value: model }))
  on('env.get', async () => ({ value: undefined }))
  on('fs.read', async (_$: any, e: any) => (reads.push(e.path), e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.exists', async () => ({ value: false }))
  on('fs.write', async (_$: any, e: any) => ((files[e.path] = e.text), { value: undefined }))
  on('tool.register', async () => ({ value: { tool: 'mcp__longhaul__review' } as never }))
  on('state.get', async () => ({ value: { value: undefined, version: 0 } as never }))
  on('state.set', async () => ({ value: { isSet: true, version: 1 } as never }))
  on('ui.log', async () => ({ value: undefined }))
  if (clock) on('clock.now', async () => ({ value: 1_760_000_000_000 }))
  on('turn.complete', async () => ({ text: '' }))
  on('prompt.submit', async (_$: any, e: any) => (seen.push(e), { text: e.text, context: e.context }))
  on('session.start', async () => ({ cwd: '/w/p' }))
  return seen
}
const start = ($: any) => $.session.start({ cwd: '/w/p', surface: null, isInteractive: true })

for (const [mode, text, model, expected] of [
  ['auto', HANDOFF, 'claude-opus-5-5', true],
  ['ask', ASK_HANDOFF, 'claude-opus-5-5', true],
  ['auto', HANDOFF, 'claude-sonnet-5-5', false],
  ['off', HANDOFF, 'claude-opus-5-5', false],
] as const) {
  test(`classifier ${mode} on ${model}`, { options: { classifier_mode: mode } }, async ($, on) => {
    const files: Record<string, string> = {}
    const seen = stub(on, model, files)
    await start($)
    await $.prompt.submit({ text: 'find the login handler' })
    expect(seen[0].context?.at(-1)).toBe(expected ? text : undefined)
    await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
    const saved = Object.values(files).map((f) => JSON.parse(f)).find((r) => r.decisions)
    if (expected) {
      expect(saved.decisions.length).toBe(1)
      expect(saved.decisions[0]).toMatchObject({ outcome: 'pending', ruleIds: ['en.search'], mode })
      expect(JSON.stringify(saved)).not.toContain('login handler')
    } else expect(saved?.decisions ?? []).toEqual([])
  })
}

test('commands and meta prompts are untouched', async ($, on) => {
  const seen = stub(on, 'claude-opus-5-5')
  await start($)
  await $.prompt.submit({ text: '/compact', command: 'compact' } as never)
  await $.prompt.submit({ text: 'find the login handler', isMeta: true } as never)
  expect(seen.every((e) => !e.context)).toBe(true)
})

test('review tool records the outcome on the latest pending decision', async ($, on) => {
  const files: Record<string, string> = {}
  stub(on, 'claude-opus-5-5', files)
  await start($)
  await $.prompt.submit({ text: 'find the login handler' })
  const call = (outcome: string) => ($.tool.call as any)({ tool: 'mcp__longhaul__review', input: { outcome } })
  const r = await call('fixed')
  expect(r.result).toBe('recorded')
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
  const saved = Object.values(files).map((f) => JSON.parse(f)).find((x) => x.decisions)
  expect(saved.decisions[0].outcome).toBe('fixed')
  const bad = await call('great')
  expect(bad.deny).toContain('accepted, fixed, redone')
})

const crowded = { options: { guard_mode: 'auto', soft_limit: 100000, hard_limit: 200000 } }
const crowdedSetup = (on: any) =>
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 120000, cache_creation_input_tokens: 0 } } as never
  })
async function crowdedStep($: any) {
  for await (const _ of ($.turn.step as any)({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _
}

test('a sonnet-verdict new-task prompt past the soft limit is not dropped and carries the handoff once', crowded, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, 'claude-opus-5-5', {}, false)
  crowdedSetup(on)
  let compactions = 0
  on('session.compact', async () => (compactions++, { messages: [{ role: 'user', text: 's', toolUses: [] }], tokensBefore: 120000, tokensAfter: 9000 }) as never)
  await start($)
  await crowdedStep($)
  const r = await $.prompt.submit({ text: "what's next? rename foo to bar" })
  expect(r.drop).toBe(undefined)
  await clock.advance(10)
  await clock.settle()
  expect(compactions).toBe(0) // compaction waits for the turn end
  expect(seen.length).toBe(1)
  expect(seen[0].context.filter((c: string) => c === HANDOFF).length).toBe(1)
})

test('an opus-verdict new-task prompt is still dropped, compacted and sent again', crowded, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, 'claude-opus-5-5', {}, false)
  crowdedSetup(on)
  on('session.compact', async () => ({ messages: [{ role: 'user', text: 's', toolUses: [] }], tokensBefore: 120000, tokensAfter: 9000 }) as never)
  await start($)
  await crowdedStep($)
  const r = await $.prompt.submit({ text: "what's next? why does the login fail?" })
  expect(r.drop).toBeDefined()
  await clock.advance(10)
  await clock.settle()
  expect(seen.length).toBe(1) // the resend skips the mod's own hook
})

test("another plugin's prompt passes untouched", crowded, async ($, on) => {
  const seen = stub(on, 'claude-opus-5-5')
  crowdedSetup(on)
  await start($)
  await crowdedStep($)
  const r = await $.prompt.submit({ text: "what's next? rename foo to bar", origin: { kind: 'plugin', plugin: 'other' } } as never)
  expect(r.drop).toBe(undefined)
  expect(seen[0].context).toBe(undefined)
})

test('agent.spawn moves a general-purpose subagent to sonnet and leaves custom ones alone', async ($, on) => {
  stub(on, 'claude-opus-5-5')
  const spawned: any[] = []
  on('agent.spawn', async (_$: any, e: any) => (spawned.push(e), { model: e.model ?? 'inherit', agentId: 'a1' }) as never)
  await start($)
  await ($.agent.spawn as any)({ prompt: 'find x', subagentType: 'general-purpose', parentModel: 'claude-opus-5-5', fork: false })
  await ($.agent.spawn as any)({ prompt: 'find x', subagentType: 'my-agent', parentModel: 'claude-opus-5-5', fork: false })
  expect(spawned[0].model).toBe('sonnet')
  expect(spawned[1].model).toBe(undefined)
})

test('a decision remembers at most 50 subagent files', async () => {
  const rec = { decisions: [d({})] } as never
  for (let i = 0; i < 80; i++) noteEdit(rec, { tool: 'Edit', input: { file_path: `f${i}.ts` }, agentId: 'a' })
  expect((rec as { decisions: Decision[] }).decisions[0].subFiles.length).toBe(50)
})

test('/clear forgets the loaded rules, so the next prompt reads the rules file again', async ($, on) => {
  const files: Record<string, string> = {}
  stub(on, 'claude-opus-5-5', files)
  reads.length = 0
  on('session.end', async () => ({ sessionId: 'h1' }))
  await start($)
  await $.prompt.submit({ text: 'find the login handler' })
  const n = reads.filter((p) => p.includes('rules.json')).length
  expect(n).toBeGreaterThan(0)
  await $.prompt.submit({ text: 'find the login handler again' })
  expect(reads.filter((p) => p.includes('rules.json')).length).toBe(n)
  await ($.session as any).end({ reason: 'clear', sessionId: 'h1', resume: false })
  await $.prompt.submit({ text: 'find the login handler once more' })
  expect(reads.filter((p) => p.includes('rules.json')).length).toBe(n * 2)
})
