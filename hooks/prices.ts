import type { ModelUsage } from 'claude-code'

export type Tier = 'opus' | 'sonnet' | 'haiku' | 'fable'
export type Price = { input: number; write: number; read: number; output: number }

// $ per million tokens. Source: https://platform.claude.com/docs/en/about-claude/pricing
// `write` is the 5-minute cache-write rate; 1-hour writes cost more and are counted at the 5-minute rate.
// PRICES.haiku is the "prompts up to 100,000 tokens" row; HAIKU_LONG is the over-100k row (see stepCost).
export const PRICES_AS_OF = '2026-10-18'
export const PRICES: Record<Tier, Price> = {
  opus: { input: 4, write: 5, read: 0.2, output: 20 },
  sonnet: { input: 2, write: 2.5, read: 0.1, output: 10 },
  haiku: { input: 0.1, write: 0.125, read: 0.01, output: 0.5 },
  fable: { input: 10, write: 12.5, read: 0.25, output: 50 },
}

const HAIKU_LONG: Price = { input: 0.5, write: 0.625, read: 0.05, output: 2.5 }

export function tierOf(model: string): Tier | null {
  const m = model.toLowerCase()
  if (m.includes('fable') || m.includes('mythos')) return 'fable'
  for (const t of ['opus', 'sonnet', 'haiku'] as const) if (m.includes(t)) return t
  return null
}

export type StepCost = { input: number; write: number; read: number; output: number }

export function stepCost(model: string, u: ModelUsage): StepCost | null {
  const t = tierOf(model)
  if (!t) return null
  const p = t === 'haiku' && contextOf(u) > 100_000 ? HAIKU_LONG : PRICES[t]
  return {
    input: (u.input_tokens * p.input) / 1e6,
    write: (u.cache_creation_input_tokens * p.write) / 1e6,
    read: (u.cache_read_input_tokens * p.read) / 1e6,
    output: (u.output_tokens * p.output) / 1e6,
  }
}

export function contextOf(u: ModelUsage): number {
  return u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
}

export type Bucket = 'lt100k' | '100to200k' | '200to400k' | 'gt400k'

export function bucketOf(ctx: number): Bucket {
  return ctx < 100_000 ? 'lt100k' : ctx < 200_000 ? '100to200k' : ctx < 400_000 ? '200to400k' : 'gt400k'
}
