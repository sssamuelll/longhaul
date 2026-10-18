import { test, expect } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'
import { classify } from './classifier'
import { DEFAULT_RULES, loadRules, resetRulesWarn } from './rules'

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

function fake(files: Record<string, string> = {}) {
  const logs: string[] = []
  const $ = {
    env: { get: async (n: string) => ({ CLAUDE_CONFIG_DIR: '/cfg' } as Record<string, string>)[n] },
    fs: {
      read: async (p: string) => {
        if (!(p in files)) throw new Error('ENOENT')
        return files[p]
      },
      exists: async (p: string) => p in files,
      write: async (p: string, t: string) => void (files[p] = t),
    },
    ui: { log: (t: string) => void logs.push(t) },
  }
  return { $: $ as unknown as EngineInterface, files, logs }
}
const FILE = '/cfg/longhaul/rules.json'

test('loadRules creates a missing file from the defaults', async () => {
  const { $, files } = fake()
  expect(await loadRules($)).toEqual(DEFAULT_RULES)
  expect(JSON.parse(files[FILE])).toEqual(DEFAULT_RULES)
})
test('loadRules falls back on invalid JSON without overwriting', async () => {
  resetRulesWarn()
  const { $, files, logs } = fake({ [FILE]: '[{' })
  expect(await loadRules($)).toEqual(DEFAULT_RULES)
  expect(files[FILE]).toBe('[{')
  expect(logs.length).toBe(1)
})
test('loadRules falls back when the JSON is not an array', async () => {
  const { $, files } = fake({ [FILE]: '{"a":1}' })
  expect(await loadRules($)).toEqual(DEFAULT_RULES)
  expect(files[FILE]).toBe('{"a":1}')
})
test('loadRules keeps valid entries and drops malformed ones', async () => {
  const good = { id: 'u.x', verdict: 'opus', pattern: 'foo' }
  const { $ } = fake({
    [FILE]: JSON.stringify([good, { id: 'a', verdict: 'neutral', pattern: 'x' }, { verdict: 'opus', pattern: 'x' }, { id: 'b', verdict: 'opus', pattern: '(' }, 7]),
  })
  expect(await loadRules($)).toEqual([good])
})
test('a read error on an existing file never triggers a write', async () => {
  const { $, files } = fake({ [FILE]: '[]' })
  let wrote = false
  const fs = ($ as unknown as { fs: { read: unknown; write: unknown } }).fs
  fs.read = async () => { throw new Error('EBUSY') }
  fs.write = async () => void (wrote = true)
  expect(await loadRules($)).toEqual(DEFAULT_RULES)
  expect(wrote).toBe(false)
  expect(files[FILE]).toBe('[]')
})
