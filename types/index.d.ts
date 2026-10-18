export type BandEvent =
  | { kind: 'compacted'; before: number; after: number }
  | { kind: 'ask-compact'; hard: boolean }
  | { kind: 'health'; total: number; unusedMcp: number; duplicate: number }
  | { kind: 'over-pace'; today: number; allowance: number; runsOutAt: number }

// What the meter row draws: the context size against the hard limit, and the week's pace.
export type Meter = {
  ctx: number
  hard: number
  pace: { weekly: number; today: number; allowance: number; resetsAt: number; runsOutAt: number | null; stale: boolean } | null
}

declare module 'claude-code' {
  interface PluginState {
    longhaul: { event: BandEvent | null; meter: Meter | null }
  }
}
