import { test, expect, mock } from 'claude-code/testing'
import { HANDOFF, ASK_HANDOFF, isExpensiveMain, guessOutcome, noteEdit } from './handoff'
import type { Decision } from './ledger'

test('isExpensiveMain', async () => {
  expect(isExpensiveMain('claude-opus-5-5')).toBe(true)
  expect(isExpensiveMain('claude-fable-1')).toBe(true)
  expect(isExpensiveMain('claude-haiku-5')).toBe(false)
  expect(isExpensiveMain('claude-sonnet-5-5')).toBe(false)
})

const d = (o: Partial<Decision>): Decision => ({ at: 1, verdict: 'sonnet', ruleIds: ['en.search'], mode: 'auto', outcome: 'pending', subFiles: [], turnsSince: 3, ...o })

test('guessOutcome', async () => {
  expect(guessOutcome(d({ subFiles: ['a.ts'] }), ['a.ts'])).toMatchObject({ outcome: 'fixed', guessed: true })
  expect(guessOutcome(d({ subFiles: ['a.ts'] }), [])).toMatchObject({ outcome: 'accepted', guessed: true })
  expect(guessOutcome(d({ outcome: 'fixed' }), ['a.ts']).outcome).toBe('fixed')
})

const reads: string[] = []
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '') // the engine normalises paths per platform
function stub(on: any, model: string, store = new Map<string, unknown>(), clock = true, ruleFiles: Record<string, string> = {}) {
  const seen: any[] = []
  on('session.id', async () => ({ value: 'h1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  on('session.model', async () => ({ value: model }))
  on('fs.read', async (_$: any, e: any) => (reads.push(norm(e.path)), norm(e.path) in ruleFiles ? { value: ruleFiles[norm(e.path)] } : { deny: 'ENOENT' }))
  on('store.get', async (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: any, e: any) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', async (_$: any, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', async () => ({ value: [...store.keys()] }))
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
    const store = new Map<string, unknown>()
    const seen = stub(on, model, store)
    await start($)
    await $.prompt.submit({ text: 'find the login handler' })
    expect(seen[0].context?.at(-1)).toBe(expected ? text : undefined)
    await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
    const saved = store.get('session:h1') as any
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
  const store = new Map<string, unknown>()
  stub(on, 'claude-opus-5-5', store)
  await start($)
  await $.prompt.submit({ text: 'find the login handler' })
  const call = (outcome: string) => ($.tool.call as any)({ tool: 'mcp__longhaul__review', input: { outcome } })
  const r = await call('fixed')
  expect(r.result).toBe('recorded')
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
  const saved = store.get('session:h1') as any
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
  const seen = stub(on, 'claude-opus-5-5', new Map(), false)
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
  const seen = stub(on, 'claude-opus-5-5', new Map(), false)
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

test('a decision remembers at most 50 subagent files', async () => {
  const rec = { decisions: [d({})] } as never
  for (let i = 0; i < 80; i++) noteEdit(rec, { tool: 'Edit', input: { file_path: `f${i}.ts` }, agentId: 'a' })
  expect((rec as { decisions: Decision[] }).decisions[0].subFiles.length).toBe(50)
})

const RULES = '/r/rules.json'

test('the rules file is read once per session, and again after /clear', { options: { rules_file: RULES } }, async ($, on) => {
  stub(on, 'claude-opus-5-5', new Map(), true, { [RULES]: JSON.stringify([{ id: 'u.zebra', verdict: 'sonnet', pattern: 'zebra' }]) })
  reads.length = 0
  on('session.end', async () => ({ sessionId: 'h1' }))
  await start($)
  await $.prompt.submit({ text: 'paint the zebra' })
  expect(reads.filter((p) => p === RULES).length).toBe(1)
  await $.prompt.submit({ text: 'paint the zebra again' })
  expect(reads.filter((p) => p === RULES).length).toBe(1)
  await ($.session as any).end({ reason: 'clear', sessionId: 'h1', resume: false })
  await $.prompt.submit({ text: 'paint the zebra once more' })
  expect(reads.filter((p) => p === RULES).length).toBe(2)
})
