import { test, expect, mock } from 'claude-code/testing'
import { KEEP_LIST, withKeepList } from './compact'

test('withKeepList appends the keep-list to any instructions', async () => {
  expect(withKeepList(undefined)).toBe(KEEP_LIST)
  const s = withKeepList('focus on auth')
  expect(s.startsWith('focus on auth')).toBe(true)
  expect(s.endsWith(KEEP_LIST)).toBe(true)
})

// The plugin store, in memory: the session record lives under session:<id>.
function storeStub(on: any, store = new Map<string, unknown>()) {
  on('store.get', async (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: any, e: any) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', async (_$: any, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', async () => ({ value: [...store.keys()] }))
  return store
}
const recordOf = (store: Map<string, unknown>): any => store.get('session:sc1')


// Stubs the session nouns the plugin touches; the compaction bottom echoes what it was given.
function stub0(on: any) {
  on('session.id', async () => ({ value: 'sc1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  storeStub(on)
  on('turn.complete', async () => ({ text: '' }))
  stepStub(on)
  on('state.get', async () => ({ value: { value: undefined, version: 0 } as never }))
  on('state.set', async () => ({ value: { isSet: true, version: 1 } as never }))
  on('ui.log', async () => ({ value: undefined }))
}

function stub(on: Parameters<Parameters<typeof test>[1]>[1], files: Map<string, unknown>, res: object, state = new Map<string, unknown>()) {
  const seen: (string | undefined)[] = []
  const logs: string[] = []
  ;(seen as any).logs = logs
  on('session.id', async () => ({ value: 'sc1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  storeStub(on, files)
  on('turn.complete', async () => ({ text: '' }))
  stepStub(on)
  on('ui.log', async (_$, e) => (logs.push(JSON.stringify(e)), { value: undefined }))
  on('state.get', async (_$, e) => ({ value: { value: state.get(e.key), version: 0 } as never }))
  on('state.set', async (_$, e) => (state.set(e.key, e.value), { value: { isSet: true, version: 1 } as never }))
  on('session.compact', async (_$, e) => {
    seen.push(e.instructions)
    return { messages: [{ role: 'user', text: 's', toolUses: [] }], ...res } as never
  })
  return seen
}

test('every trigger gets the keep-list; only manual, auto and plugin are counted', async ($, on) => {
  const files = new Map<string, unknown>()
  const seen = stub(on, files, { tokensBefore: 312000, tokensAfter: 41000 })
  const run = (trigger: string, instructions?: string) =>
    ($.session.compact as (a: object) => Promise<unknown>)({ trigger, instructions, messages: [{ role: 'user', text: 's', toolUses: [] }] })
  await run('auto', 'mine')
  expect(seen[0]).toBe('mine\n' + KEEP_LIST)
  await run('manual')
  await run('precompute')
  await run('plugin')
  expect(seen.every((s) => s?.endsWith(KEEP_LIST))).toBe(true)
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
  const saved = recordOf(files)
  expect(saved.compactions).toEqual({ auto: 1, manual: 1, plugin: 1 })
})

test('a compaction result sets the compacted event', async ($, on) => {
  const state = new Map<string, unknown>()
  stub(on, {}, { tokensBefore: 312000, tokensAfter: 41000 }, state)
  await ($.session.compact as (a: object) => Promise<unknown>)({ trigger: 'auto', messages: [{ role: 'user', text: 's', toolUses: [] }] })
  expect(state.get('event')).toEqual({ kind: 'compacted', before: 312000, after: 41000 })
})

const u = (o: object) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o })
let stepCtx = 0
const stepStub = (on: any) =>
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', ...u({ cache_read_input_tokens: stepCtx }) } } as never
  })
async function step($: any, _on: any, ctx: number) {
  stepCtx = ctx
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) void _
}
const done = ($: any) => $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)

test('ask mode at the hard limit sets ask-compact and does not compact', { options: { guard_mode: 'ask', soft_limit: 100000, hard_limit: 200000 } }, async ($, on) => {
  const state = new Map<string, unknown>()
  const seen = stub(on, {}, {}, state)
  await step($, on, 250000)
  await done($)
  expect(state.get('event')).toEqual({ kind: 'ask-compact', hard: true })
  expect(seen.length).toBe(0)
})

const session = ($: any, on: any, interactive: boolean) => {
  on('session.start', async () => ({ cwd: '/w/p' }))
  return $.session.start({ cwd: '/w/p', surface: null, isInteractive: interactive })
}
const opts = { options: { guard_mode: 'auto', soft_limit: 100000, hard_limit: 200000 } }

test('auto mode does not compact a prompt that is not a new task', opts, async ($, on) => {
  const seen = stub(on, {}, {})
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, true)
  await step($, on, 120000)
  const r = await $.prompt.submit({ text: 'fix the failing test please' })
  expect(seen.length).toBe(0)
  expect(r.drop).toBe(undefined)
})

test('a non-interactive session never drops a prompt', opts, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, {}, {})
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, false)
  await step($, on, 120000)
  const r = await $.prompt.submit({ text: "what's next?" })
  await clock.advance(1000)
  expect(r.text).toBe("what's next?")
  expect(seen.length).toBe(0)
})

test('interactive: a new-task prompt is dropped, compacted from a timer, and resubmitted even if compaction rejects', opts, async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  on('session.compact', async () => {
    throw new Error('busy')
  })
  on('prompt.submit', async (_$, e) => (sent.push(e.text), { text: e.text }))
  stub0(on)
  await session($, on, true)
  await step($, on, 120000)
  const r = await $.prompt.submit({ text: "what's next?" })
  expect(r.drop).toBe('longhaul: compacting before the new task')
  expect(sent.length).toBe(0)
  await clock.advance(10)
  await clock.settle()
  expect(sent).toEqual(["what's next?"])
})

test('interactive: the timer compacts with the keep-list, counts it, then resubmits', opts, async ($, on) => {
  const clock = mock.clock(on)
  const state = new Map<string, unknown>()
  const files = new Map<string, unknown>()
  const seen = stub(on, files, { tokensBefore: 120000, tokensAfter: 9000 }, state)
  const sent: string[] = []
  on('prompt.submit', async (_$, e) => (sent.push(e.text), { text: e.text }))
  await session($, on, true)
  await step($, on, 120000)
  await $.prompt.submit({ text: "what's next?" })
  await clock.advance(10)
  await clock.settle()
  expect(seen).toEqual([KEEP_LIST])
  expect(sent).toEqual(["what's next?"])
  expect(state.get('event')).toEqual({ kind: 'compacted', before: 120000, after: 9000 })
})

test('turn-end compaction runs once from the timer, is counted as plugin, and sets the event', opts, async ($, on) => {
  const clock = mock.clock(on)
  const state = new Map<string, unknown>()
  const files = new Map<string, unknown>()
  const seen = stub(on, files, { tokensBefore: 250000, tokensAfter: 20000 }, state)
  await step($, on, 250000) // at or over the hard limit: compacts whatever the task state
  await done($)
  expect(seen.length).toBe(0) // not inside the turn.complete hook
  await clock.advance(10)
  await clock.settle()
  expect(seen).toEqual([KEEP_LIST])
  expect(state.get('event')).toEqual({ kind: 'compacted', before: 250000, after: 20000 })
  await done($)
  expect(recordOf(files).compactions.plugin).toBe(1)
})

test('a rejected turn-end compaction is retried before the next prompt', opts, async ($, on) => {
  const clock = mock.clock(on)
  const sent: string[] = []
  stub0(on)
  on('session.compact', async () => {
    throw new Error('busy')
  })
  on('prompt.submit', async (_$, e) => (sent.push(e.text), { text: e.text }))
  await session($, on, true)
  await step($, on, 250000)
  await done($)
  await clock.advance(10)
  await clock.settle()
  const r = await $.prompt.submit({ text: 'continue with the same thing' })
  expect(r.drop).toBe('longhaul: compacting before the new task')
})

test('a resubmitted prompt does not loop: one compaction, the text sent once, then it passes our hook again', opts, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, {}, { tokensBefore: 120000, tokensAfter: 9000 })
  const sent: string[] = []
  on('prompt.submit', async (_$, e) => (sent.push(e.text), { text: e.text }))
  await session($, on, true)
  await step($, on, 120000)
  await $.prompt.submit({ text: "what's next?" })
  await clock.advance(10)
  await clock.settle()
  const again = await $.prompt.submit({ text: "what's next?" }) // raised through the engine: our hook sees it
  await clock.advance(1000)
  await clock.settle()
  expect(again.drop).toBe(undefined)
  expect(seen.length).toBe(1)
  expect(sent).toEqual(["what's next?", "what's next?"])
})

test('after a successful turn-end compaction a new-task prompt is not dropped', opts, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, {}, { tokensBefore: 250000, tokensAfter: 20000 })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, true)
  await step($, on, 250000)
  await done($)
  await clock.advance(10)
  await clock.settle()
  const r = await $.prompt.submit({ text: "what's next?" })
  expect(r.drop).toBe(undefined)
  expect(seen.length).toBe(1)
})

test('a later successful compaction (manual) clears the pending retry', opts, async ($, on) => {
  const clock = mock.clock(on)
  stub0(on)
  let n = 0
  on('session.compact', async () => {
    if (n++ === 0) throw new Error('busy')
    return { messages: [{ role: 'user', text: 's', toolUses: [] }], tokensBefore: 5, tokensAfter: 4 } as never
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, true)
  await step($, on, 250000)
  await done($)
  await clock.advance(10)
  await clock.settle()
  await ($.session.compact as (a: object) => Promise<unknown>)({ trigger: 'manual', messages: [{ role: 'user', text: 's', toolUses: [] }] })
  const r = await $.prompt.submit({ text: 'just keep going on this thing' })
  expect(r.drop).toBe(undefined)
})

test('session.start and /clear reset the guard and silence pending timers', opts, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, {}, {})
  on('session.end', async () => ({ sessionId: 'sc1' }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, true)
  await step($, on, 250000)
  await done($) // schedules a compaction
  await ($.session as any).end({ reason: 'clear', sessionId: 'sc1', resume: false })
  await clock.advance(10)
  await clock.settle()
  expect(seen.length).toBe(0)
  const r = await $.prompt.submit({ text: "what's next?" }) // context forgotten: nothing to compact
  expect(r.drop).toBe(undefined)
})

// ---- final-review fixes ----

const bash = ($: any, command: string) => $.tool.call({ tool: 'Bash', input: { command } })
const soft = { options: { guard_mode: 'auto', soft_limit: 150000, hard_limit: 300000 } }
const logsOf = (seen: unknown): string[] => (seen as { logs: string[] }).logs

test('a compaction that lands near the soft limit does not compact again until 50k of room is gained', soft, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, {}, { tokensBefore: 250000, tokensAfter: 160000 })
  on('tool.call', async () => ({ result: {} }) as never)
  await step($, on, 250000)
  await bash($, 'git commit -m x')
  await done($)
  await clock.advance(10)
  await clock.settle()
  expect(seen.length).toBe(1)
  await step($, on, 160000)
  await done($)
  await clock.advance(10)
  await clock.settle()
  expect(seen.length).toBe(1) // task is done, context is over soft, but nothing to gain
  await step($, on, 209000)
  await done($)
  await clock.advance(10)
  await clock.settle()
  expect(seen.length).toBe(1)
  await step($, on, 210000)
  await done($)
  await clock.advance(10)
  await clock.settle()
  expect(seen.length).toBe(2)
  const note = logsOf(seen).filter((l) => l.includes('still above the soft limit'))
  expect(note.length).toBe(1) // once per session
  expect(note[0]).toContain('transcript')
})

test('the hard limit never compacts for less than the minimum gain either', opts, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, {}, { tokensBefore: 250000, tokensAfter: 190000 })
  await step($, on, 250000)
  await done($)
  await clock.advance(10)
  await clock.settle()
  expect(seen.length).toBe(1)
  await step($, on, 220000) // over hard (200k), but only 30k above the 190k floor
  await done($)
  await clock.advance(10)
  await clock.settle()
  expect(seen.length).toBe(1)
})

test('a prompt with attachments is never dropped', opts, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, {}, {})
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, true)
  await step($, on, 120000)
  const r = await $.prompt.submit({ text: "what's next?", attachments: [{ id: 'a1', kind: 'image' }] } as never)
  await clock.advance(10)
  await clock.settle()
  expect(r.drop).toBe(undefined)
  expect(seen.length).toBe(0)
})

test('a failed resubmit puts the text back in the box and says so', opts, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, {}, { tokensBefore: 120000, tokensAfter: 9000 })
  const filled: string[] = []
  on('prompt.submit', async () => {
    throw new Error('busy')
  })
  on('prompt.fill', async (_$: any, e: any) => (filled.push(e.text), { isFilled: true }) as never)
  await session($, on, true)
  await step($, on, 120000)
  await $.prompt.submit({ text: "what's next?" })
  await clock.advance(10)
  await clock.settle()
  expect(filled).toEqual(["what's next?"])
  expect(logsOf(seen).some((l) => l.includes("couldn't resend your prompt; it's back in the box") && l.includes('transcript'))).toBe(true)
})

// Claude Code puts a dropped prompt back in the box; `typed` is what the person typed there after.
async function resendWithBox($: any, on: any, typed?: string) {
  const clock = mock.clock(on)
  stub(on, {}, { tokensBefore: 120000, tokensAfter: 9000 })
  let box = ''
  on('prompt.submit', async (_$: any, e: any) => ({ text: e.text }))
  on('prompt.read', async () => ({ value: { text: box, cursor: box.length } }) as never)
  on('prompt.fill', async (_$: any, e: any) => ((box = e.text), { isFilled: true }) as never)
  await session($, on, true)
  await step($, on, 120000)
  const r = await $.prompt.submit({ text: "what's next?" })
  if (r.drop) box = typed ?? "what's next?"
  await clock.advance(10)
  await clock.settle()
  return box
}

test('the resent prompt is cleared from the box', opts, async ($, on) => {
  expect(await resendWithBox($, on)).toBe('')
})

test('a draft typed during the compaction stays in the box', opts, async ($, on) => {
  expect(await resendWithBox($, on, 'and also the docs')).toBe('and also the docs')
})

test('after a rejected prompt-path compaction the next prompt is not dropped', opts, async ($, on) => {
  const clock = mock.clock(on)
  stub0(on)
  on('session.compact', async () => {
    throw new Error('busy')
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, true)
  await step($, on, 250000)
  await done($)
  await clock.advance(10)
  await clock.settle() // turn-end compaction rejected: pending
  expect((await $.prompt.submit({ text: 'continue with the same thing' })).drop).toBeDefined()
  await clock.advance(10)
  await clock.settle() // prompt-path compaction rejected too
  expect((await $.prompt.submit({ text: 'and carry on with it' })).drop).toBe(undefined)
})

test('a subagent compaction gets no keep-list and is not counted', opts, async ($, on) => {
  const files = new Map<string, unknown>()
  const state = new Map<string, unknown>()
  const seen = stub(on, files, { tokensBefore: 90000, tokensAfter: 5000 }, state)
  await ($.session.compact as (a: object) => Promise<unknown>)({ trigger: 'auto', agentId: 'a1', instructions: 'mine', messages: [{ role: 'user', text: 's', toolUses: [] }] })
  expect(seen[0]).toBe('mine')
  expect(state.get('event')).toBe(undefined)
  await done($)
  expect(recordOf(files).compactions).toEqual({ auto: 0, manual: 0, plugin: 0 })
})

test('an aborted turn never triggers a turn-end compaction', opts, async ($, on) => {
  const clock = mock.clock(on)
  const seen = stub(on, {}, {})
  await step($, on, 250000)
  await $.turn.complete({ turnId: 't', reason: 'done', answer: '', durationMs: 1, isAborted: true } as never)
  await clock.advance(10)
  await clock.settle()
  expect(seen.length).toBe(0)
})

test('a new main prompt clears a compacted event', opts, async ($, on) => {
  const state = new Map<string, unknown>()
  stub(on, {}, {}, state)
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, true)
  state.set('event', { kind: 'compacted', before: 9, after: 1 })
  await $.prompt.submit({ text: 'carry on please' })
  expect(state.get('event')).toBe(null)
})

for (const [name, ctx, hard] of [['soft', 120000, false], ['hard', 250000, true]] as const) {
  test(`a prompt typed over a ${name} ask counts as "Not now"`, { options: { guard_mode: 'ask', soft_limit: 100000, hard_limit: 200000 } }, async ($, on) => {
    const state = new Map<string, unknown>()
    stub(on, {}, {}, state)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    on('tool.call', async () => ({ result: {} }) as never)
    await session($, on, true)
    await step($, on, ctx)
    if (!hard) await bash($, 'git commit -m x')
    await done($)
    expect(state.get('event')).toEqual({ kind: 'ask-compact', hard })
    await $.prompt.submit({ text: 'keep going with this' })
    expect(state.get('event')).toBe(null)
    await step($, on, ctx)
    await done($)
    expect(state.get('event')).toBe(null) // not asked again
  })
}

// ---- compaction log ----

const ARROW = '→'
const DOT = '·'
const lines = (seen: unknown): string[] => logsOf(seen).map((l) => JSON.parse(l)).map((e) => e.text ?? e.message ?? e.line ?? JSON.stringify(e)).filter((t: string) => t.startsWith('compacted'))
const logOf = (files: Map<string, unknown>) => recordOf(files).compactionLog

async function runTurnEnd($: any, on: any, ctx: number, commit: boolean) {
  const clock = mock.clock(on)
  on('tool.call', async () => ({ result: {} }) as never)
  await step($, on, ctx)
  if (commit) await bash($, 'git commit -m x')
  await done($)
  await clock.advance(10)
  await clock.settle()
  await done($) // save
}

test('a turn-end compaction after a commit logs task-done with sizes and one transcript line', soft, async ($, on) => {
  const files = new Map<string, unknown>()
  const seen = stub(on, files, { tokensBefore: 312000, tokensAfter: 41999 })
  await runTurnEnd($, on, 200000, true)
  expect(logOf(files)).toEqual([expect.objectContaining({ trigger: 'plugin', reason: 'task-done', before: 312000, after: 41999 })])
  expect(lines(seen)).toEqual([`compacted 312k ${ARROW} 41k ${DOT} task finished`])
})

test('crossing the hard limit logs hard-limit', soft, async ($, on) => {
  const files = new Map<string, unknown>()
  stub(on, files, { tokensBefore: 320000, tokensAfter: 20000 })
  await runTurnEnd($, on, 320000, false)
  expect(logOf(files)[0]).toMatchObject({ trigger: 'plugin', reason: 'hard-limit' })
})

test('the new-task path logs new-task; a missing size reads without the arrow', opts, async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map<string, unknown>()
  const seen = stub(on, files, {})
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, true)
  await step($, on, 120000)
  await $.prompt.submit({ text: "what's next?" })
  await clock.advance(10)
  await clock.settle()
  await done($)
  expect(logOf(files)[0]).toMatchObject({ trigger: 'plugin', reason: 'new-task' })
  expect(logOf(files)[0].before).toBeUndefined()
  expect(lines(seen)).toEqual([`compacted ${DOT} new task`])
})

test('a retry after a rejected compaction logs retry', opts, async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map<string, unknown>()
  on('session.id', async () => ({ value: 'sc1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  storeStub(on, files)
  on('turn.complete', async () => ({ text: '' }))
  stepStub(on)
  on('ui.log', async () => ({ value: undefined }))
  on('state.get', async () => ({ value: { value: undefined, version: 0 } as never }))
  on('state.set', async () => ({ value: { isSet: true, version: 1 } as never }))
  let fails = true
  on('session.compact', async () => {
    if (fails) throw new Error('busy')
    return { messages: [{ role: 'user', text: 's', toolUses: [] }], tokensBefore: 250000, tokensAfter: 9000 } as never
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  await session($, on, true)
  await step($, on, 250000)
  await done($)
  await clock.advance(10)
  await clock.settle()
  fails = false
  await $.prompt.submit({ text: 'continue with the same thing' })
  await clock.advance(10)
  await clock.settle()
  await done($)
  expect(logOf(files).map((e: any) => e.reason)).toEqual(['retry'])
})

test('the band button logs button; /compact and auto log manual and auto', async ($, on) => {
  const files = new Map<string, unknown>()
  const state = new Map<string, unknown>([['event', { kind: 'ask-compact', hard: true }]])
  const seen = stub(on, files, { tokensBefore: 100000, tokensAfter: 5000 }, state)
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  const ui = await $.ui.mount({ plugin: 'longhaul', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false } as never })
  await ui.press({ key: 'compact' })
  const run = (trigger: string) => ($.session.compact as (a: object) => Promise<unknown>)({ trigger, messages: [{ role: 'user', text: 's', toolUses: [] }] })
  await run('manual')
  await run('auto')
  await done($)
  expect(logOf(files).map((e: any) => [e.trigger, e.reason])).toEqual([['plugin', 'button'], ['manual', 'manual'], ['auto', 'auto']])
  expect(lines(seen)).toEqual([
    `compacted 100k ${ARROW} 5k ${DOT} you asked`,
    `compacted 100k ${ARROW} 5k ${DOT} /compact`,
    `compacted 100k ${ARROW} 5k ${DOT} Claude Code auto-compact`,
  ])
})

test('the logged reason is the one decided at turn end, even if the context changes before the timer', soft, async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map<string, unknown>()
  stub(on, files, { tokensBefore: 200000, tokensAfter: 20000 })
  on('tool.call', async () => ({ result: {} }) as never)
  await step($, on, 200000)
  await bash($, 'git commit -m x')
  await done($) // decides task-done
  await step($, on, 320000) // over the hard limit before the timer fires
  await clock.advance(10)
  await clock.settle()
  await done($)
  expect(logOf(files)[0]).toMatchObject({ reason: 'task-done' })
})

test("the engine running the mod's own compaction through its hook counts it once", soft, async ($, on) => {
  const clock = mock.clock(on)
  const files = new Map<string, unknown>()
  const logs: string[] = []
  on('session.id', async () => ({ value: 'sc1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  storeStub(on, files)
  on('turn.complete', async () => ({ text: '' }))
  stepStub(on)
  on('ui.log', async (_$, e) => (logs.push(JSON.stringify(e)), { value: undefined }))
  on('state.get', async () => ({ value: { value: undefined, version: 0 } as never }))
  on('state.set', async () => ({ value: { isSet: true, version: 1 } as never }))
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const seen: (string | undefined)[] = []
  on('session.compact', async (_$, e) => {
    if (!seen.length) {
      seen.push('held')
      await gate // the mod's own compaction, still running
    } else seen.push(e.instructions)
    return { messages: [{ role: 'user', text: 's', toolUses: [] }], tokensBefore: 320000, tokensAfter: 20000 } as never
  })
  await step($, on, 320000)
  await done($)
  await clock.advance(10)
  // Claude Code 2.1.302 sends that same compaction through the mod's own hook, as 'manual'
  await ($.session.compact as (a: object) => Promise<unknown>)({ trigger: 'manual', instructions: KEEP_LIST, messages: [{ role: 'user', text: 's', toolUses: [] }] })
  release()
  await clock.settle()
  await done($)
  const saved = recordOf(files)
  expect(saved.compactions).toEqual({ auto: 0, manual: 0, plugin: 1 })
  expect(saved.compactionLog.map((e: any) => e.reason)).toEqual(['hard-limit'])
  expect(seen[1]).toBe(KEEP_LIST) // the keep-list is not added twice
  expect(lines({ logs })).toEqual([`compacted 320k ${ARROW} 20k ${DOT} hard limit`])
})
