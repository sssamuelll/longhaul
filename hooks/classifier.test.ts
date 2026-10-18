import { test, expect } from 'claude-code/testing'
import { classify } from './classifier'
import { DEFAULT_RULES } from './rules'
import { HANDOFF } from './handoff'

const table: [string, string][] = [
  ['run the tests and fix the lint errors', 'sonnet'],
  ['rename getUser to fetchUser everywhere', 'sonnet'],
  ['where is the config loader defined?', 'sonnet'],
  ['go with task 3 of the plan', 'sonnet'],
  ['ejecuta el hito 4', 'sonnet'],
  ['arranca con B4', 'sonnet'],
  ['vamos con b5', 'sonnet'],
  ['should we use Postgres or SQLite here?', 'opus'],
  ['why does login fail only on Safari?', 'opus'],
  ['review this PR', 'opus'],
  ['go with task 3, then delete the old migrations', 'opus'],
  ['cual es la forma de arreglar esto lo mas profesional posible?', 'opus'],
  ['cual seria el siguiente paso mas natural de este proyecto?', 'opus'],
  ['cuál sería el siguiente paso más natural de este proyecto?', 'opus'],
  ['dónde está el cargador de configuración?', 'sonnet'],
  ['dónde están los tests del cargador?', 'sonnet'],
  ['what is the most natural next step for this project?', 'opus'],
  ['find the best approach for caching', 'opus'],
  ['continue with the next task', 'sonnet'],
  ['do the next step of the plan', 'sonnet'],
  ['hola', 'neutral'],
  ['', 'neutral'],
]
for (const [prompt, want] of table) {
  test(`classify "${prompt}" -> ${want}`, async () => {
    expect(classify(prompt, DEFAULT_RULES).verdict).toBe(want)
  })
}

test("bare next-step questions are not sent to sonnet", async () => {
  for (const p of ["what's the next step?", 'qué sigue?', 'git checkout main and run the tests'])
    expect(classify(p, DEFAULT_RULES).verdict === 'sonnet' && !p.includes('run the tests')).toBe(false)
})
test('ruleIds lists every rule that fired', async () => {
  const r = classify('go with task 3, then delete the old migrations', DEFAULT_RULES)
  expect(r.ruleIds.length >= 2).toBe(true)
})
test('an invalid user rule is skipped, not thrown', async () => {
  const r = classify('hello there', [
    { id: 'bad', verdict: 'opus', pattern: '(' },
    { id: 'ok', verdict: 'sonnet', pattern: 'hello' },
  ])
  expect(r.verdict).toBe('sonnet')
  expect(r.ruleIds).toEqual(['ok'])
})

// The rules file is read through the engine, which normalises the path per platform.
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const FILE = '/r/rules.json'
const opts = { options: { rules_file: FILE } }

function stub(on: any, files: Record<string, string | Error>) {
  const logs: string[] = []
  const sent: any[] = []
  const reads: string[] = []
  on('session.id', async () => ({ value: 'c1' }))
  on('session.cwd', async () => ({ value: '/w/p' }))
  on('session.model', async () => ({ value: 'claude-opus-5-5' }))
  on('session.start', async () => ({ cwd: '/w/p' }))
  on('clock.now', async () => ({ value: 1_760_000_000_000 }))
  on('fs.read', async (_$: any, e: any) => {
    const f = files[norm(e.path)]
    reads.push(norm(e.path))
    return typeof f === 'string' ? { value: f } : { deny: 'ENOENT' }
  })
  on('store.get', async () => ({ value: undefined }))
  on('store.set', async () => ({ value: undefined }))
  on('state.get', async () => ({ value: { value: undefined, version: 0 } as never }))
  on('state.set', async () => ({ value: { isSet: true, version: 1 } as never }))
  on('ui.log', async (_$: any, e: any) => (logs.push(JSON.stringify(e)), { value: undefined }))
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }))
  on('prompt.submit', async (_$: any, e: any) => (sent.push(e), { text: e.text, context: e.context }))
  return { logs, sent, reads }
}
const start = ($: any) => $.session.start({ cwd: '/w/p', surface: null, isInteractive: true })
const warnings = (logs: string[]) => logs.filter((l) => l.includes('rules file'))

test('rules_file keeps valid entries and drops malformed ones', opts, async ($, on) => {
  const good = { id: 'u.x', verdict: 'sonnet', pattern: 'zebra' }
  const s = stub(on, {
    [FILE]: JSON.stringify([good, { id: 'a', verdict: 'neutral', pattern: 'x' }, { verdict: 'sonnet', pattern: 'x' }, { id: 'b', verdict: 'sonnet', pattern: '(' }, 7]),
  })
  await start($)
  await $.prompt.submit({ text: 'paint the zebra' })
  await $.prompt.submit({ text: 'find the login handler' }) // a built-in rule, replaced by the file
  expect(s.sent[0].context).toContain(HANDOFF)
  expect(s.sent[1].context).toBe(undefined)
  expect(warnings(s.logs)).toEqual([])
})
test('a rules file with invalid JSON falls back to the built-in rules with one warning', opts, async ($, on) => {
  const s = stub(on, { [FILE]: '[{' })
  await start($)
  await $.prompt.submit({ text: 'find the login handler' })
  await $.prompt.submit({ text: 'find the login handler again' })
  expect(s.sent[0].context).toContain(HANDOFF)
  expect(warnings(s.logs).length).toBe(1)
})
test('a rules file that is not an array falls back to the built-in rules', opts, async ($, on) => {
  const s = stub(on, { [FILE]: '{"a":1}' })
  await start($)
  await $.prompt.submit({ text: 'find the login handler' })
  expect(s.sent[0].context).toContain(HANDOFF)
  expect(warnings(s.logs).length).toBe(1)
})
test('a missing rules file falls back to the built-in rules with one warning', opts, async ($, on) => {
  const s = stub(on, {})
  await start($)
  await $.prompt.submit({ text: 'find the login handler' })
  expect(s.sent[0].context).toContain(HANDOFF)
  expect(warnings(s.logs).length).toBe(1)
})
test('no rules_file: the built-in rules, and no file is read', async ($, on) => {
  const s = stub(on, {})
  await start($)
  await $.prompt.submit({ text: 'find the login handler' })
  expect(s.sent[0].context).toContain(HANDOFF)
  expect(s.reads).toEqual([])
})
