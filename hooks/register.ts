import type { EngineInterface, Register } from 'claude-code'
import { readConfig, type Config } from './config'
import { contextOf } from './prices'
import { withKeepList, compactNow, afterCompact, isSelfCompacting, setEvent, setSoftLimit, resetDeclines, clearHardDecline, declines } from './compact'
import { current, fail, lastMainCtx, setMainCtx, setCompactPending, isCompactPending, newEpoch, epoch, peekRecord, getFloor } from './session'
import { emptyFacts, observeTool, isTaskDone, isNewTask, guardDecision, type TurnFacts } from './guard'
import { addStep, saveRecord, type CompactReason } from './ledger'
import { budgetAfterTurn } from './budget'
import { registerBand, clearBandOnPrompt } from './band'
import { registerReport, runReport } from './report'
import { healthAfterFirstTurn, runHealth } from './health'
import { handoffContext, noteEdit, applyReview, registerReview, resetHandoff, routeSubagent, REVIEW_TOOL } from './handoff'

export { lastMainCtx } from './session'

// Guard state, memory only: nothing about prompts is ever written to disk.
let facts: TurnFacts = emptyFacts()
let recent: string[] = []
let isInteractive = false // from session.start; only an interactive session may have a prompt dropped

// New session or /clear: forget everything the guard knew; timers of the old one become no-ops.
function resetGuard(): void {
  newEpoch()
  facts = emptyFacts()
  recent = []
  resetDeclines()
  clearHardDecline()
  resetHandoff()
}

// Turn end, main loop: compact or ask once the task is done, or at the hard limit.
// Compacting runs from a timer so the turn is never held; a rejection there leaves a pending flag.
async function atTurnEnd($: EngineInterface, cfg: Config): Promise<string> {
  if (lastMainCtx < cfg.hardLimit) clearHardDecline()
  const act = guardDecision({
    mode: cfg.guardMode,
    ctx: lastMainCtx,
    floor: getFloor(),
    soft: cfg.softLimit,
    hard: cfg.hardLimit,
    at: 'turn-end',
    taskDone: isTaskDone(facts),
    newTask: false,
    ...declines(),
  })
  if (act === 'ask') await setEvent($, { kind: 'ask-compact', hard: lastMainCtx >= cfg.hardLimit })
  else if (act === 'compact-at-turn-end') {
    const ep = epoch()
    const reason: CompactReason = lastMainCtx >= cfg.hardLimit ? 'hard-limit' : 'task-done' // decided now, not when the timer fires
    $.clock.after(0, () => void compactTimer($, ep, reason))
  }
  return act
}

async function compactTimer($: EngineInterface, ep: number, reason: CompactReason): Promise<void> {
  if (ep !== epoch()) return
  try {
    await compactNow($, reason)
  } catch (err) {
    setCompactPending(true) // the next prompt compacts first
    fail($, 'compact at turn end', err)
  }
}

// Interactive new-task prompt: the hook has already returned { drop }; compact, then send the text again.
async function compactThenSubmit($: EngineInterface, text: string, ep: number, reason: CompactReason): Promise<void> {
  if (ep !== epoch()) return
  try {
    await compactNow($, reason)
  } catch (err) {
    fail($, 'compact before prompt', err)
  }
  setCompactPending(false) // whatever happened: a failing summariser must not drop every prompt
  if (ep !== epoch()) return
  try {
    await $.prompt.submit({ text, asUser: true }) // skips this plugin's own prompt.submit hook
  } catch (err) {
    fail($, 'resubmit after compact', err)
    try {
      await $.prompt.fill({ text })
      $.ui.log("couldn't resend your prompt; it's back in the box", { to: 'transcript' })
    } catch (err2) {
      fail($, 'refill prompt', err2)
    }
  }
}

// New main prompt: maybe compact first. Returns a drop reason when the prompt was held back.
// Never drops in a non-interactive session, or when `canDrop` is false; the turn-end path handles those.
async function atPrompt($: EngineInterface, cfg: Config, text: string, canDrop: boolean): Promise<string | undefined> {
  const pending = isCompactPending() && cfg.guardMode !== 'off'
  const act = pending
    ? 'compact-before-prompt'
    : guardDecision({
        mode: cfg.guardMode,
        ctx: lastMainCtx,
        floor: getFloor(),
        soft: cfg.softLimit,
        hard: cfg.hardLimit,
        at: 'prompt',
        taskDone: false,
        newTask: isNewTask(text, recent),
        ...declines(),
      })
  recent = [...recent, text].slice(-3)
  facts = emptyFacts()
  resetDeclines()
  if (act !== 'compact-before-prompt' || !isInteractive || !canDrop) return undefined
  const ep = epoch()
  const reason: CompactReason = pending ? 'retry' : lastMainCtx >= cfg.hardLimit ? 'hard-limit' : 'new-task'
  $.clock.after(0, () => void compactThenSubmit($, text, ep, reason))
  return 'longhaul: compacting before the new task'
}

export const register: Register = (on, options) => {
  const cfg = readConfig(options)
  setSoftLimit(cfg.softLimit)

  registerBand(on, options)

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    try {
      if (r.usage) {
        const sub = Boolean(e.agentId)
        addStep(await current($), r.usage.model, r.usage, sub)
        if (!sub) setMainCtx(contextOf(r.usage))
      }
    } catch (err) {
      fail($, 'turn.step', err)
    }
    return r
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!e.agentId && !('deny' in r && r.deny)) facts = observeTool(facts, { tool: e.tool, input: e.input as Record<string, unknown>, ...('isError' in r && r.isError ? { isError: true as const } : {}) })
      if (!('deny' in r && r.deny)) noteEdit(await current($), { tool: e.tool, input: e.input, ...(e.agentId ? { agentId: e.agentId } : {}) })
      const m = /^mcp__(.+?)__/.exec(e.tool)
      if (m) {
        const calls = (await current($)).mcpCalls
        calls[m[1]] = (calls[m[1]] ?? 0) + 1
      }
    } catch (err) {
      fail($, 'tool.call', err)
    }
    return r
  })

  on('tool.call', { tool: REVIEW_TOOL }, async ($, e) => {
    try {
      return applyReview(await current($), e.input)
    } catch (err) {
      fail($, 'review', err)
      return { deny: 'longhaul: could not record the outcome.' }
    }
  })

  on('agent.spawn', async ($, e, next) => {
    let m: string | undefined
    try {
      m = routeSubagent(e, cfg)
    } catch (err) {
      fail($, 'agent.spawn', err)
    }
    return next(m ? { ...e, model: m } : e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      await budgetAfterTurn($, cfg) // before the save, so this turn's rate point is on disk
      try {
        await saveRecord($, await current($))
      } catch (err) {
        fail($, 'turn.complete', err)
      }
      if (e.isAborted) {
        await healthAfterFirstTurn($, cfg, { interactive: isInteractive, compacting: false }) // an interrupted turn is no safe moment for the guard
        return r
      }
      let act = ''
      try {
        act = await atTurnEnd($, cfg)
      } catch (err) {
        fail($, 'guard at turn end', err)
      }
      // last: its heads-up never replaces a more urgent event, nor lands as a compaction starts
      await healthAfterFirstTurn($, cfg, { interactive: isInteractive, compacting: act === 'compact-at-turn-end' })
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    // other plugins' prompts, commands and meta prompts pass untouched
    if (e.command || e.isMeta || e.turnId || e.origin?.kind === 'plugin') return next(e)
    // classify first: a handoff prompt is never held back, its compaction waits for the turn end
    const note = await handoffContext($, cfg, e.text)
    let drop: string | undefined
    try {
      drop = await atPrompt($, cfg, e.text, !note && !e.attachments?.length)
    } catch (err) {
      fail($, 'prompt.submit', err)
    }
    try {
      await clearBandOnPrompt($)
    } catch (err) {
      fail($, 'clear band', err)
    }
    if (drop) return { drop }
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  })

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    resetGuard()
    $.ui.status(undefined) // clears the plain status line an earlier build pinned; the meter is in the band now
    await registerReview($)
    await registerReport($)
    return next(e)
  })

  on('command.run', { command: 'longhaul' }, async ($, e) => {
    try {
      if ((e.args ?? '').trim().toLowerCase() === 'health') return await runHealth($)
      return await runReport($, cfg, e.args ?? '')
    } catch (err) {
      fail($, 'longhaul report', err)
      return { text: 'longhaul: could not build the report.' }
    }
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId || isSelfCompacting()) return next(e) // a subagent's, or the mod's own: no keep-list, not counted here
    const r = await next({ ...e, instructions: withKeepList(e.instructions) })
    try {
      await afterCompact($, e.trigger, r, e.trigger === 'manual' || e.trigger === 'auto' ? e.trigger : undefined)
    } catch (err) {
      fail($, 'session.compact', err)
    }
    return r
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    try {
      const rec = peekRecord()
      if (rec) await saveRecord($, rec)
    } catch (err) {
      fail($, 'session.end', err)
    }
    if (e.reason === 'clear') resetGuard()
    return r
  })
}
