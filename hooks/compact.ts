import type { CompactReason } from './ledger'

export const KEEP_LIST =
  'Keep, in this order: the current plan and its next step; the decisions made and why; the files touched; open items and failing tests; anything the user corrected or asked for in this session.'

export const DROP_LIST =
  'Drop raw tool outputs, file contents that can be re-read from disk, resolved errors, dead-end explorations, and play-by-play narration of completed steps.'

export type CompactContext = {
  reason?: CompactReason
  editedFiles?: string[]
  committed?: boolean
  testsPassed?: boolean
  editedAfterTests?: boolean
}

export function buildCompactInstructions(ctx?: CompactContext): string {
  if (!ctx) return KEEP_LIST
  const files = [...new Set((ctx.editedFiles ?? []).filter(Boolean))]
  const hasFacts = files.length > 0 || Boolean(ctx.committed) || Boolean(ctx.testsPassed)
  if (!hasFacts) return KEEP_LIST
  const parts: string[] = []
  if (ctx.reason === 'task-done' || ctx.reason === 'new-task') {
    parts.push('The previous task is complete: collapse its finished work to a one-line outcome and drop intermediate steps.')
  } else if (ctx.reason === 'hard-limit') {
    parts.push('Mid-task compaction at the context limit: preserve the active hypothesis, the latest error or failing check, and the immediate next edit.')
  }
  const state: string[] = []
  if (files.length) state.push(`files edited (${files.join(', ')})`)
  if (ctx.committed) state.push('changes committed')
  if (ctx.testsPassed && !ctx.editedAfterTests) state.push('tests passing')
  else if (ctx.testsPassed && ctx.editedAfterTests) state.push('files edited since last passing test run')
  if (state.length) parts.push(`Session state: ${state.join('; ')}.`)
  parts.push(DROP_LIST)
  parts.push(KEEP_LIST)
  return parts.join('\n')
}

export const withKeepList = (instructions: string | undefined, ctx?: CompactContext): string => {
  const suffix = buildCompactInstructions(ctx)
  if (!instructions) return suffix
  if (instructions.endsWith(KEEP_LIST)) return instructions
  return `${instructions}\n${suffix}`
}

// Decline flags: the band sets them, register.tsx reads them.
let declinedThisTask = false
let declinedHard = false
export const declineAsk = (hard: boolean): void => void (hard ? (declinedHard = true) : (declinedThisTask = true))
export const resetDeclines = (): void => void (declinedThisTask = false)
// Back under the hard limit: a later crossing asks again.
export const clearHardDecline = (): void => void (declinedHard = false)
export const declines = () => ({ declinedThisTask, declinedHard })

// The soft limit, set once by register.tsx; only used to word the one "still above" note.
let softLimit = Infinity
export const setSoftLimit = (n: number): void => void (softLimit = n)
export const getSoftLimit = (): number => softLimit

export const REASON_LABEL: Record<CompactReason, string> = {
  'task-done': 'task finished',
  'new-task': 'new task',
  'hard-limit': 'hard limit',
  retry: 'retry',
  button: 'you asked',
  manual: '/compact',
  auto: 'Claude Code auto-compact',
}

export type Compacted = { tokensBefore?: number; tokensAfter?: number; skip?: string }

// Claude Code 2.1.302 also runs the mod's own compaction through the mod's session.compact hook, as
// 'manual'. While one is in flight that hook passes it through, and it is counted here, once, for
// every caller (timers, the band button).
let selfCompacting = false
export const isSelfCompacting = (): boolean => selfCompacting
export const setSelfCompacting = (v: boolean): void => void (selfCompacting = v)
