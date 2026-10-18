import { test, expect } from 'claude-code/testing'
import { tierOf, stepCost, contextOf, bucketOf } from './prices'

const M = 1_000_000
// this expect has no toBeCloseTo
const near = (a: number, b: number) => expect(Math.abs(a - b) < 1e-9).toBe(true)
const u = (o: object) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o })

test('tierOf matches by substring', async () => {
  expect(tierOf('claude-opus-5-5')).toBe('opus')
  expect(tierOf('claude-sonnet-5-5')).toBe('sonnet')
  expect(tierOf('claude-haiku-5-5')).toBe('haiku')
  expect(tierOf('claude-fable-5-1')).toBe('fable')
  expect(tierOf('claude-mythos-5-1')).toBe('fable')
  expect(tierOf('gpt-x')).toBeNull()
})
test('stepCost prices each token class', async () => {
  near(stepCost('claude-opus-5-5', u({ cache_read_input_tokens: M }))!.read, 0.2)
  near(stepCost('claude-sonnet-5-5', u({ cache_read_input_tokens: M }))!.read, 0.1)
  near(stepCost('claude-opus-5-5', u({ output_tokens: M }))!.output, 20)
  near(stepCost('claude-opus-5-5', u({ input_tokens: M }))!.input, 4)
  near(stepCost('claude-opus-5-5', u({ cache_creation_input_tokens: M }))!.write, 5)
  expect(stepCost('gpt-x', u({ input_tokens: M }))).toBeNull()
})
test('haiku over 100k tokens uses the long-prompt rates', async () => {
  near(stepCost('claude-haiku-5-5', u({ cache_read_input_tokens: 200_000 }))!.read, (200_000 * 0.05) / 1e6)
  near(stepCost('claude-haiku-5-5', u({ cache_read_input_tokens: 100_000 }))!.read, (100_000 * 0.01) / 1e6)
})
test('contextOf sums input and cache tokens', async () => {
  expect(contextOf(u({ input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 99 }))).toBe(60)
})
test('bucketOf boundaries', async () => {
  expect(bucketOf(99_999)).toBe('lt100k')
  expect(bucketOf(100_000)).toBe('100to200k')
  expect(bucketOf(200_000)).toBe('200to400k')
  expect(bucketOf(399_999)).toBe('200to400k')
  expect(bucketOf(400_000)).toBe('gt400k')
})
