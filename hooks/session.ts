import type { EngineInterface } from 'claude-code'
import { loadRecord, projectOf, saveRecord, type SessionRecord } from './ledger'

// Main-loop context of the latest step; the guard reads it. Read it through a live binding.
export let lastMainCtx = 0
export const setMainCtx = (n: number): void => void (lastMainCtx = n)

// Bumped when a session starts or is cleared; timers scheduled earlier see it changed and do nothing.
let epochN = 0
export const epoch = (): number => epochN
export const newEpoch = (): void => void (epochN++, (lastMainCtx = 0), (compactPending = false), (floorCtx = 0), (aboveSoftLogged = false))

// Context size right after the last compaction: the least the conversation can shrink to. The guard
// does not compact again until the context has grown MIN_GAIN past it.
let floorCtx = 0
export const getFloor = (): number => floorCtx
export const setFloor = (n: number): void => void (floorCtx = n)
let aboveSoftLogged = false
export const takeAboveSoftLog = (): boolean => (aboveSoftLogged ? false : (aboveSoftLogged = true))

// A turn-end compaction was refused; retry before the next prompt. Any successful compaction clears it.
let compactPending = false
export const isCompactPending = (): boolean => compactPending
export const setCompactPending = (v: boolean): void => void (compactPending = v)

let rec: SessionRecord | null = null
let pending: Promise<SessionRecord> | null = null
let pendingId = ''
export const peekRecord = (): SessionRecord | null => rec
// $ may only be passed to top-level function declarations, so these live outside register.
async function switchTo($: EngineInterface, old: SessionRecord | null, id: string): Promise<SessionRecord> {
  if (old) await saveRecord($, old) // nothing in memory is discarded
  const next = await loadRecord($, id, projectOf(await $.session.cwd()), Date.now())
  rec = next
  return next
}

// Concurrent callers (parallel subagents) share one in-flight load, so they share one record.
export async function current($: EngineInterface): Promise<SessionRecord> {
  const id = await $.session.id()
  if (rec && rec.id === id) return rec
  if (!pending || pendingId !== id) {
    pendingId = id
    pending = switchTo($, rec, id)
  }
  const p = pending
  try {
    return await p
  } finally {
    if (pending === p) pending = null
  }
}

export function fail($: EngineInterface, what: string, err: unknown): void {
  try {
    $.ui.log(`longhaul: ${what} failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  } catch {
    // logging must not break the session either
  }
}

