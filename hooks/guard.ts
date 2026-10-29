import type { Mode } from './config'

export type TurnFacts = {
  committed: boolean
  testsPassed: boolean
  editedAfterTests: boolean
  todosDone: boolean
  editedFiles: string[]
}

export const emptyFacts = (): TurnFacts => ({
  committed: false,
  testsPassed: false,
  editedAfterTests: false,
  todosDone: false,
  editedFiles: [],
})

const COMMIT = /\bgit\s+(?:-C\s+\S+\s+)?commit\b|\bgh\s+pr\s+(?:create|merge)\b/
const TEST_RUN =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test(?::\S+)?\b|\b(?:npx\s+|uv\s+run\s+|python3?\s+-m\s+)?(?:pytest|vitest|jest)\b|\bcargo\s+test\b|\bgo\s+test\b|\bclaude\s+plugin\s+test\b/
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit']

export function observeTool(
  f: TurnFacts,
  use: { tool: string; input: Record<string, unknown>; isError?: true },
): TurnFacts {
  const input = use?.input && typeof use.input === 'object' ? use.input : {}
  const next = { ...f, editedFiles: [...f.editedFiles] }
  if (use?.tool === 'Bash' && typeof input.command === 'string') {
    if (use.isError) {
      if (TEST_RUN.test(input.command)) next.testsPassed = false
    } else {
      if (COMMIT.test(input.command)) next.committed = true
      if (TEST_RUN.test(input.command)) {
        next.testsPassed = true
        next.editedAfterTests = false
      }
    }
  } else if (EDIT_TOOLS.includes(use?.tool) && typeof input.file_path === 'string' && input.file_path) {
    if (next.testsPassed) next.editedAfterTests = true
    if (!next.editedFiles.includes(input.file_path)) next.editedFiles.push(input.file_path)
  } else if (use?.tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const todos = input.todos as { status?: unknown }[]
    next.todosDone = todos.length > 0 && todos.every((t) => t?.status === 'completed')
  }
  return next
}

export const isTaskDone = (f: TurnFacts): boolean =>
  f.committed || (f.testsPassed && !f.editedAfterTests) || f.todosDone

// Phrases are matched on lowercased text with accents stripped and curly apostrophes
// straightened. Anchored so they do not fire mid-sentence in an ongoing task.
const NEW_TASK_PHRASES = [
  /\bwhat('?s| is) next\b/,
  /\bnow let's\b/,
  /\banother thing\b/,
  /\bnew task\b/,
  /^(the )?next task\b/,
  /^(y ahora )?que sigue\b/,
  /\botra cosa\b/,
  /\bnueva tarea\b/,
  /^(la )?siguiente tarea\b/,
]
// Issue/PR references: "#12" (2+ digits), "PR 12", "issue 12", ".../pull/12", ".../issues/12".
const REF = /#(\d{2,})\b|\b(?:pr|issue)\s*#?\s*(\d+)|\/(?:pull|issues)\/(\d+)/gi
const CSS_CONTEXT = /\b(colou?r|background|border|fill|stroke|shadow|hex|css|font|padding|margin)\b/i

const norm = (s: string) => s.replace(/[‘’]/g, "'").toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
const refs = (s: string) =>
  new Set(
    [...s.matchAll(REF)]
      .filter((m) => !(m[1] && /^(\d{3}|\d{6})$/.test(m[1]) && CSS_CONTEXT.test(s)))
      .map((m) => m[1] ?? m[2] ?? m[3]),
  )
const words = (s: string) => new Set(norm(s).match(/[a-zñ]{3,}/g) ?? [])

export function isNewTask(text: string, recent: string[]): boolean {
  const t = norm(text)
  if (NEW_TASK_PHRASES.some((r) => r.test(t))) return true
  if (!recent.length) return false
  const seen = new Set(recent.flatMap((p) => [...refs(p)]))
  if (seen.size && [...refs(text)].some((r) => !seen.has(r))) return true
  const w = words(text)
  if (w.size < 5) return false
  const comparable = recent.map(words).filter((r) => r.size >= 5)
  if (!comparable.length) return false
  // ponytail: Jaccard on the whole word set; good enough for a heuristic signal.
  return comparable.every((r) => [...w].filter((x) => r.has(x)).length / new Set([...w, ...r]).size < 0.1)
}

// A compaction must be able to free at least this much, or it is not worth its cost.
export const MIN_GAIN = 50_000

export type GuardAction = 'none' | 'compact-before-prompt' | 'compact-at-turn-end' | 'ask'

export function guardDecision(i: {
  mode: Mode
  ctx: number
  soft: number
  hard: number
  at: 'turn-end' | 'prompt'
  taskDone: boolean
  newTask: boolean
  declinedThisTask: boolean
  declinedHard: boolean
  floor?: number // context right after the last compaction
}): GuardAction {
  if (i.mode === 'off' || i.ctx < i.soft || i.ctx - (i.floor ?? 0) < MIN_GAIN) return 'none'
  if (i.at === 'prompt') return i.mode === 'auto' && i.newTask ? 'compact-before-prompt' : 'none'
  if (i.ctx >= i.hard) return i.mode === 'auto' ? 'compact-at-turn-end' : i.declinedHard ? 'none' : 'ask'
  if (!i.taskDone) return 'none'
  return i.mode === 'auto' ? 'compact-at-turn-end' : i.declinedThisTask ? 'none' : 'ask'
}
