export type Mode = 'auto' | 'ask' | 'off'
export type Config = {
  guardMode: Mode
  classifierMode: Mode
  budgetMode: 'auto' | 'off'
  healthMode: 'auto' | 'off'
  softLimit: number
  hardLimit: number
  exploreModel: 'sonnet' | 'haiku'
  keepOnOpus: string[]
}

const MIN = 100000
const MAX = 1000000

const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  allowed.includes(v as T) ? (v as T) : dflt

const clamp = (v: unknown, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX, Math.max(MIN, v)) : dflt

export function readConfig(options: Record<string, unknown>): Config {
  const softLimit = clamp(options.soft_limit, 150000)
  let hardLimit = clamp(options.hard_limit, 300000)
  if (hardLimit <= softLimit) hardLimit = Math.min(MAX, Math.max(300000, softLimit + 50000))
  const raw = options.keep_on_opus
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null
  const keepOnOpus = list
    ? list.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : ['review', 'design', 'plan', 'architect']
  return {
    guardMode: pick(options.guard_mode, ['auto', 'ask', 'off'], 'auto'),
    classifierMode: pick(options.classifier_mode, ['auto', 'ask', 'off'], 'auto'),
    budgetMode: pick(options.budget_mode, ['auto', 'off'], 'auto'),
    healthMode: pick(options.health_mode, ['auto', 'off'], 'auto'),
    softLimit,
    hardLimit,
    exploreModel: pick(options.explore_model, ['sonnet', 'haiku'], 'sonnet'),
    keepOnOpus,
  }
}
