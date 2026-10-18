import { test, expect } from 'claude-code/testing'
import { readConfig } from './config'

test('defaults', async () => {
  expect(readConfig({})).toEqual({
    guardMode: 'auto', classifierMode: 'auto', budgetMode: 'auto',
    healthMode: 'auto',
    softLimit: 150000, hardLimit: 300000, exploreModel: 'sonnet',
    keepOnOpus: ['review', 'design', 'plan', 'architect'],
  })
})
test('soft limit is clamped', async () => {
  expect(readConfig({ soft_limit: 50000 }).softLimit).toBe(100000)
  expect(readConfig({ soft_limit: 2000000 }).softLimit).toBe(1000000)
})
test('hard limit must exceed soft', async () => {
  expect(readConfig({ hard_limit: 120000, soft_limit: 150000 }).hardLimit).toBe(300000)
  expect(readConfig({ hard_limit: 120000, soft_limit: 400000 }).hardLimit).toBe(450000)
  expect(readConfig({ hard_limit: 900000, soft_limit: 1000000 }).hardLimit).toBe(1000000)
})
test('bad mode falls back, keep_on_opus is trimmed', async () => {
  expect(readConfig({ guard_mode: 'loud' }).guardMode).toBe('auto')
  expect(readConfig({ keep_on_opus: ' Review, plan ,,' }).keepOnOpus).toEqual(['review', 'plan'])
})
