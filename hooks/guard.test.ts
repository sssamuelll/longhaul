import { test, expect } from 'claude-code/testing'
import { emptyFacts, observeTool, isTaskDone, isNewTask, guardDecision } from './guard'

const bash = (command: string, isError?: true) => ({ tool: 'Bash', input: { command }, ...(isError ? { isError } : {}) })

test('observeTool: commit and PR creation', async () => {
  expect(observeTool(emptyFacts(), bash('git commit -m x')).committed).toBe(true)
  expect(observeTool(emptyFacts(), bash('gh pr create --fill')).committed).toBe(true)
  expect(observeTool(emptyFacts(), bash('git commit -m x', true)).committed).toBe(false)
  expect(observeTool(emptyFacts(), bash('git status')).committed).toBe(false)
})

test('observeTool: test runs', async () => {
  for (const c of ['npm test', 'pytest -q', 'cargo test', 'claude plugin test .']) {
    expect(observeTool(emptyFacts(), bash(c)).testsPassed).toBe(true)
    expect(observeTool(emptyFacts(), bash(c, true)).testsPassed).toBe(false)
  }
})

test('observeTool: edits after tests', async () => {
  const f0 = emptyFacts()
  const f1 = observeTool(f0, bash('npm test'))
  const f2 = observeTool(f1, { tool: 'Edit', input: { file_path: 'a.ts' } })
  expect(f2.editedAfterTests).toBe(true)
  expect(f2.editedFiles).toEqual(['a.ts'])
  expect(observeTool(f2, { tool: 'Write', input: { file_path: 'a.ts' } }).editedFiles).toEqual(['a.ts'])
  expect(isTaskDone(f1)).toBe(true)
  expect(isTaskDone(f2)).toBe(false)
  expect(f1.testsPassed).toBe(true)
  expect(f0.testsPassed).toBe(false)
})

test('observeTool: todos and malformed input', async () => {
  const done = { tool: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }] } }
  const open = { tool: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] } }
  expect(observeTool(emptyFacts(), done).todosDone).toBe(true)
  expect(observeTool(emptyFacts(), open).todosDone).toBe(false)
  expect(observeTool(emptyFacts(), { tool: 'TodoWrite', input: { todos: [] } }).todosDone).toBe(false)
  expect(observeTool(emptyFacts(), { tool: 'Bash', input: { command: 5 } })).toEqual(emptyFacts())
  expect(observeTool(emptyFacts(), { tool: 'Edit', input: {} })).toEqual(emptyFacts())
  expect(observeTool(emptyFacts(), { tool: 'TodoWrite', input: { todos: 'x' } })).toEqual(emptyFacts())
})

test('isNewTask', async () => {
  expect(isNewTask("what's next?", [])).toBe(true)
  expect(isNewTask('whats next?', [])).toBe(true)
  expect(isNewTask("now let's do the README", [])).toBe(true)
  expect(isNewTask('otra cosa: los tests', [])).toBe(true)
  expect(isNewTask('nueva tarea', [])).toBe(true)
  expect(isNewTask('fix #42', ['look at #41'])).toBe(true)
  expect(isNewTask('fix #41', ['look at #41'])).toBe(false)
  expect(isNewTask('and also the footer', ['fix the header'])).toBe(false)
  expect(isNewTask('refactor database migration scripts today', ['polish landing page hero animation'])).toBe(true)
  expect(isNewTask('refactor database migration scripts today', [])).toBe(false)
})

test('isNewTask: in-task follow-ups are not new tasks', async () => {
  const r = ['fix the header layout please']
  for (const x of ['el siguiente paso es arreglar el header', 'arregla lo que sigue fallando', 'use #333 for the border', 'do #2 first', 'this is unrelated to the cache but fine'])
    expect(isNewTask(x, r)).toBe(false)
  expect(isNewTask('another thing: the footer', r)).toBe(true)
  expect(isNewTask('what’s next?', [])).toBe(true)
  expect(isNewTask('now let’s do the docs', [])).toBe(true)
  expect(isNewTask('fix #41', ['look at #42'])).toBe(true)
  expect(isNewTask('fix #41', ['look at the header'])).toBe(false)
  expect(isNewTask('qué sigue?', [])).toBe(true)
})

test('observeTool: a failing test run clears testsPassed', async () => {
  const f = observeTool(observeTool(emptyFacts(), bash('npm test')), bash('npm test', true))
  expect(f.testsPassed).toBe(false)
  expect(isTaskDone(f)).toBe(false)
})

const base = { mode: 'auto' as const, ctx: 200000, soft: 150000, hard: 300000, at: 'turn-end' as const, taskDone: false, newTask: false, declinedThisTask: false, declinedHard: false }
const d = (o: object) => guardDecision({ ...base, ...o })

test('guardDecision', async () => {
  expect(d({ ctx: 140000, taskDone: true, newTask: true })).toBe('none')
  expect(d({ at: 'prompt', newTask: true })).toBe('compact-before-prompt')
  expect(d({ taskDone: true })).toBe('compact-at-turn-end')
  expect(d({ mode: 'ask', taskDone: true })).toBe('ask')
  expect(d({ mode: 'ask', taskDone: true, declinedThisTask: true })).toBe('none')
  expect(d({ ctx: 310000 })).toBe('compact-at-turn-end')
  expect(d({ mode: 'ask', ctx: 310000, declinedThisTask: true })).toBe('ask')
  expect(d({ mode: 'ask', ctx: 310000, declinedThisTask: true, declinedHard: true })).toBe('none')
  expect(d({ mode: 'ask', at: 'prompt', newTask: true })).toBe('none')
  expect(d({ mode: 'off', ctx: 310000, taskDone: true, newTask: true })).toBe('none')
  expect(d({ ctx: 150000, taskDone: true })).toBe('compact-at-turn-end')
  expect(d({ soft: 1000000, hard: 1000000, ctx: 1000000 })).toBe('compact-at-turn-end')
  expect(d({ at: 'prompt', ctx: 310000 })).toBe('none')
})

test('guardDecision: no compaction for less than MIN_GAIN above the floor', async () => {
  const base = { mode: 'auto', soft: 150_000, hard: 300_000, at: 'turn-end', taskDone: true, newTask: false, declinedThisTask: false, declinedHard: false } as const
  expect(guardDecision({ ...base, ctx: 209_999, floor: 160_000 })).toBe('none')
  expect(guardDecision({ ...base, ctx: 210_000, floor: 160_000 })).toBe('compact-at-turn-end')
  expect(guardDecision({ ...base, ctx: 310_000, floor: 290_000 })).toBe('none')
  expect(guardDecision({ ...base, ctx: 200_000 })).toBe('compact-at-turn-end')
})
