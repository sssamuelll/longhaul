import type { ModelUsage } from 'claude-code'
import type { BaseSnapshot } from './health'
import { stepCost, contextOf, bucketOf, type StepCost, type Bucket } from './prices'

export type Decision = {
  at: number
  verdict: 'sonnet'
  ruleIds: string[]
  mode: 'auto' | 'ask'
  outcome: 'pending' | 'accepted' | 'fixed' | 'redone' | 'unreported'
  guessed?: true
  subFiles: string[]
  turnsSince: number
}

export type CompactReason = 'task-done' | 'new-task' | 'hard-limit' | 'retry' | 'button' | 'manual' | 'auto'
export type CompactionEntry = { at: number; trigger: 'plugin' | 'manual' | 'auto'; reason: CompactReason; before?: number; after?: number }

export type SessionRecord = {
  v: 1
  id: string
  project: string
  startedAt: number
  steps: number
  subSteps: number
  peakCtx: number
  cost: StepCost
  byBucket: Record<Bucket, number>
  compactions: { auto: number; manual: number; plugin: number }
  rate: [at: number, weeklyPercent: number, cumulativeCost: number][]
  weekResetsAt?: string
  mcpCalls: Record<string, number>
  decisions: Decision[]
  compactionLog: CompactionEntry[]
  base?: BaseSnapshot
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export const totalCost = (c: StepCost): number => c.input + c.write + c.read + c.output

export function newRecord(id: string, project: string, now: number): SessionRecord {
  return {
    v: 1,
    id,
    project,
    startedAt: now,
    steps: 0,
    subSteps: 0,
    peakCtx: 0,
    cost: { input: 0, write: 0, read: 0, output: 0 },
    byBucket: { lt100k: 0, '100to200k': 0, '200to400k': 0, gt400k: 0 },
    compactions: { auto: 0, manual: 0, plugin: 0 },
    rate: [],
    mcpCalls: {},
    decisions: [],
    compactionLog: [],
  }
}

// A main step's cost lands in the bucket of its context size; a subagent step has its own
// context, so it adds to cost and subSteps only.
export function addStep(rec: SessionRecord, model: string, u: ModelUsage, isSub: boolean): void {
  const n = {
    input_tokens: num(u?.input_tokens),
    output_tokens: num(u?.output_tokens),
    cache_read_input_tokens: num(u?.cache_read_input_tokens),
    cache_creation_input_tokens: num(u?.cache_creation_input_tokens),
  }
  const c = stepCost(model, n)
  if (c) {
    rec.cost.input += c.input
    rec.cost.write += c.write
    rec.cost.read += c.read
    rec.cost.output += c.output
  }
  if (isSub) {
    rec.subSteps++
    return
  }
  rec.steps++
  const ctx = contextOf(n)
  rec.peakCtx = Math.max(rec.peakCtx, ctx)
  if (c) rec.byBucket[bucketOf(ctx)] += totalCost(c)
}

export const projectOf = (cwd: string): string => cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''

export function parse(stored: unknown, fresh: SessionRecord): SessionRecord | null {
  try {
    const p = typeof stored === 'string' ? JSON.parse(stored) : stored
    if (!p || p.v !== 1 || typeof p.id !== 'string') return null
    return {
      ...fresh,
      ...p,
      cost: { ...fresh.cost, ...p.cost },
      byBucket: { ...fresh.byBucket, ...p.byBucket },
      compactions: { ...fresh.compactions, ...p.compactions },
      mcpCalls: { ...p.mcpCalls },
      rate: Array.isArray(p.rate) ? p.rate : [],
      decisions: Array.isArray(p.decisions) ? p.decisions : [],
      compactionLog: Array.isArray(p.compactionLog) ? p.compactionLog : [],
    }
  } catch {
    return null
  }
}

export const MAX_RATE = 2000
export const MAX_DECISIONS = 500
export const MAX_COMPACTION_LOG = 200

export const SESSION_PREFIX = 'session:'

// The store is capped at 4 MiB: keep the newest points of the unbounded lists.
export function capRecord(rec: SessionRecord): void {
  rec.rate = rec.rate.slice(-MAX_RATE)
  rec.decisions = rec.decisions.slice(-MAX_DECISIONS)
  rec.compactionLog = rec.compactionLog.slice(-MAX_COMPACTION_LOG)
}

export const lastActivity = (rec: SessionRecord): number => Math.max(rec.startedAt, rec.rate.at(-1)?.[0] ?? 0)
