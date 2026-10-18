import type { Rule } from './rules'
import { resetRulesWarn } from './rules'
import type { Decision, SessionRecord } from './ledger'

export const HANDOFF =
  'longhaul: this looks like execution work. Delegate it to a Sonnet subagent with a short brief (goal, files, how to check it). Review its changes and test results before accepting, then call mcp__longhaul__review with accepted, fixed or redone.'
export const ASK_HANDOFF =
  'longhaul: this looks like execution work. Before starting, ask the user in one short question whether to hand it to a Sonnet subagent. If yes, delegate with a short brief, review the result, then call mcp__longhaul__review with accepted, fixed or redone.'

export const REVIEW_TOOL = 'mcp__longhaul__review'
export const OUTCOMES = ['accepted', 'fixed', 'redone'] as const
const MAX_SUB_FILES = 50
const GUESS_AFTER = 3 // prompts without a review call before the outcome is guessed

export const isExpensiveMain = (model: string): boolean => /opus|fable/i.test(model)

export const SUBAGENT_NOTE =
  'longhaul: when you start a built-in general-purpose or Explore subagent for execution work, set its model to "sonnet". Keep your own model for review, design, planning and architecture.'

// Nobody called review: a file the main loop edited after the subagent did means it was fixed.
export function guessOutcome(d: Decision, mainEditedFiles: string[]): Decision {
  if (d.outcome !== 'pending') return d
  const fixed = d.subFiles.some((f) => mainEditedFiles.includes(f))
  return { ...d, outcome: fixed ? 'fixed' : 'accepted', guessed: true }
}

// Memory only, like the guard's state.
let rules: Rule[] | null = null
export const getRules = (): Rule[] | null => rules
export const setRules = (r: Rule[]): void => void (rules = r)
export const clearMainEdited = (): void => void (mainEdited = [])
let mainEdited: string[] = []

export const resetHandoff = (): void => void ((rules = null), (mainEdited = []), resetRulesWarn())

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

function pendingOf(rec: SessionRecord): Decision | undefined {
  return [...rec.decisions].reverse().find((d) => d.outcome === 'pending')
}

// Called after a tool ran: remember which files the main loop and subagents edited.
export function noteEdit(rec: SessionRecord, e: { tool: string; input: unknown; agentId?: string }): void {
  if (!EDIT_TOOLS.has(e.tool)) return
  const f = (e.input as { file_path?: unknown } | null)?.file_path
  if (typeof f !== 'string') return
  if (!e.agentId) {
    if (!mainEdited.includes(f)) mainEdited.push(f)
    return
  }
  const d = pendingOf(rec)
  if (d && d.subFiles.length < MAX_SUB_FILES && !d.subFiles.includes(f)) d.subFiles.push(f)
}

// The review tool's answer: a result, or a deny (which the model reads as an error).
export function applyReview(rec: SessionRecord, input: unknown): { result: string } | { deny: string } {
  const o = (input as { outcome?: unknown } | null)?.outcome
  if (!OUTCOMES.includes(o as (typeof OUTCOMES)[number])) {
    return { deny: `longhaul: outcome must be one of ${OUTCOMES.join(', ')}.` }
  }
  const d = pendingOf(rec)
  if (!d) return { result: 'nothing pending' }
  d.outcome = o as Decision['outcome']
  return { result: 'recorded' }
}

// New main prompt: pending decisions age by one prompt, and one nobody reviewed is guessed after a few.
export function ageDecisions(rec: SessionRecord): void {
  rec.decisions = rec.decisions.map((d) => {
    if (d.outcome !== 'pending') return d
    const aged = { ...d, turnsSince: d.turnsSince + 1 }
    return aged.turnsSince >= GUESS_AFTER ? guessOutcome(aged, mainEdited) : aged
  })
}
