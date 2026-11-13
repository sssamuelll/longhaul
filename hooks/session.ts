import type { SessionRecord } from './ledger'

// Main-loop context of the latest step; the guard reads it. Read it through a live binding.
export let lastMainCtx = 0
export const setMainCtx = (n: number): void => void (lastMainCtx = n)

// Bumped when a session starts or is cleared; timers scheduled earlier see it changed and do nothing.
let epochN = 0
export const epoch = (): number => epochN
export const newEpoch = (): void =>
  void (epochN++, (lastMainCtx = 0), (compactPending = false), (floorCtx = 0), (aboveSoftLogged = false), (epochFiles = []),
  (startCtx = 0), (startPending = true), (floorPending = false), (promptChars = 0))

// The start load and the floor after a compaction are measured on the next main step. That step also
// carries the prompt just sent, so the prompt's estimated size comes off.
let startCtx = 0
let startPending = true
let floorPending = false
let promptChars = 0
export const getStartCtx = (): number => startCtx
export const markFloorPending = (): void => void (floorPending = true)
export const notePrompt = (chars: number): void => void (promptChars = chars)
// ponytail: about 3 characters per token; dense text has fewer, so the measure stays a little high.
// Attachments are not counted; START_CAP bounds them, and a resumed conversation, for the start load.
const CHARS_PER_TOKEN = 3
export const START_CAP = 120_000
// Returns the floor when this step measured one.
export function measureStep(ctx: number): number | undefined {
  const own = Math.max(0, ctx - Math.ceil(promptChars / CHARS_PER_TOKEN))
  promptChars = 0
  if (startPending) void ((startPending = false), (startCtx = Math.min(own, START_CAP)))
  if (!floorPending) return undefined
  floorPending = false
  return (floorCtx = own)
}

// Files edited since the last compaction; passed into compaction instructions so multi-turn tasks keep their file list.
let epochFiles: string[] = []
export const getEpochFiles = (): string[] => epochFiles
export const addEpochFiles = (files: string[]): void => {
  for (const f of files) if (f && !epochFiles.includes(f)) epochFiles.push(f)
}
export const clearEpochFiles = (): void => void (epochFiles = [])

// Context of the first step after the last compaction: the least the conversation can shrink to.
// Until that step, an estimate: the start load plus the summary.
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
export const peekRecord = (): SessionRecord | null => rec
export const setRecord = (r: SessionRecord): void => void (rec = r)
