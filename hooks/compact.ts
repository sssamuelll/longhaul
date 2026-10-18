import type { CompactReason } from './ledger'

export const KEEP_LIST =
  'Keep, in this order: the current plan and its next step; the decisions made and why; the files touched; open items and failing tests; anything the user corrected or asked for in this session.'

export const withKeepList = (instructions: string | undefined): string =>
  instructions ? `${instructions}\n${KEEP_LIST}` : KEEP_LIST

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
