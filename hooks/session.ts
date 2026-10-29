import type { SessionRecord } from './ledger'

// Main-loop context of the latest step; the guard reads it. Read it through a live binding.
export let lastMainCtx = 0
export const setMainCtx = (n: number): void => void (lastMainCtx = n)

// Bumped when a session starts or is cleared; timers scheduled earlier see it changed and do nothing.
let epochN = 0
export const epoch = (): number => epochN
export const newEpoch = (): void =>
  void (epochN++, (lastMainCtx = 0), (compactPending = false), (floorCtx = 0), (aboveSoftLogged = false), (epochFiles = []))

// Files edited since the last compaction; passed into compaction instructions so multi-turn tasks keep their file list.
let epochFiles: string[] = []
export const getEpochFiles = (): string[] => epochFiles
export const addEpochFiles = (files: string[]): void => {
  for (const f of files) if (f && !epochFiles.includes(f)) epochFiles.push(f)
}
export const clearEpochFiles = (): void => void (epochFiles = [])

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
export const peekRecord = (): SessionRecord | null => rec
export const setRecord = (r: SessionRecord): void => void (rec = r)
