import { test, expect } from 'claude-code/testing'
import { parseCommand, nameKey, normPath, checkPattern, matchesFolder, readRuleSet, findRule, isProtected, holds, holdMessage } from './mcp'
import { headingKey } from './health'
import { newRecord } from './ledger'

test('one key for a server however it is spelled', () => {
  expect(nameKey('claude.ai Higgsfield')).toBe('claude_ai_Higgsfield')
  expect(nameKey('claude_ai_Higgsfield')).toBe('claude_ai_Higgsfield')
  expect(nameKey('plugin:context-mode:context-mode')).toBe(nameKey('plugin_context-mode_context-mode'))
  expect(headingKey('claude.ai Higgsfield')).toBe(headingKey('claude_ai_Higgsfield')) // pull request 1 still holds
})

test('a name pattern matches between separators, any case', () => {
  for (const f of ['D:\\Desktop\\projects\\vina', 'D:\\Desktop\\projects\\_wt\\vina-bake', 'D:\\x\\vina-test', 'd:\\desktop\\projects\\VINA'])
    expect(matchesFolder(['vina'], [f])).toBe(true)
  expect(matchesFolder(['vina'], ['D:\\x\\adivina'])).toBe(false)
  expect(matchesFolder(['media'], ['D:\\x\\wikimedia'])).toBe(false)
  expect(matchesFolder(['compare'], ['D:\\Desktop\\CLO Compare'])).toBe(false) // a space is not a boundary
  expect(matchesFolder(['CLO Compare'], ['D:\\Desktop\\CLO Compare'])).toBe(true)
  expect(matchesFolder(['a.b'], ['D:\\x\\aXb'])).toBe(false) // the pattern is escaped
  expect(matchesFolder([], ['D:\\x'])).toBe(false)
})

test('a full path matches that folder and what is under it', () => {
  expect(matchesFolder(['D:/Desktop/media'], ['D:\\Desktop\\media'])).toBe(true)
  expect(matchesFolder(['D:/Desktop/media'], ['D:\\Desktop\\media\\reels'])).toBe(true)
  expect(matchesFolder(['D:/Desktop/media'], ['D:\\Desktop\\media-player'])).toBe(false)
  expect(matchesFolder(['d:/desktop/MEDIA/'], ['D:\\Desktop\\media'])).toBe(true)
  expect(matchesFolder(['D:/Desktop/media'], ['C:\\Users\\simon\\Desktop\\media', 'D:\\Desktop\\media'])).toBe(true) // either spelling
  expect(matchesFolder(['D:/'], ['D:\\Desktop\\media'])).toBe(true)
  expect(matchesFolder(['D:/'], ['E:\\x'])).toBe(false)
  expect(matchesFolder(['D:/'], ['D:\\'])).toBe(true)
  expect(matchesFolder(['/'], ['/home/sam'])).toBe(true)
  expect(matchesFolder(['//nas/media'], ['\\\\nas\\media\\reels'])).toBe(true)
  expect(normPath('D:\\')).toBe('D:/')
  expect(normPath('/')).toBe('/')
})

test('patterns are checked before they are saved', () => {
  expect(checkPattern('vina')).toEqual({ pattern: 'vina', isPath: false })
  expect(checkPattern('D:\\Desktop\\media\\')).toEqual({ pattern: 'D:/Desktop/media', isPath: true })
  expect(checkPattern('/home/sam/x')).toEqual({ pattern: '/home/sam/x', isPath: true })
  expect(checkPattern('\\\\nas\\media')).toEqual({ pattern: '//nas/media', isPath: true })
  expect(checkPattern('D:\\')).toEqual({ pattern: 'D:/', isPath: true })
  expect(checkPattern('projects/vina')).toEqual({ error: '"projects/vina" is not a full path, so nothing was saved. Type a folder name with no slash, or a full path.' })
  for (const p of ['~', '~/media', '~\\media'])
    expect(checkPattern(p)).toEqual({ error: "~ is not read as your home folder, so nothing was saved. Type the folder's name or its full path, or use here from inside the folder." })
  expect(checkPattern('')).toEqual({ error: 'Type a folder name or a full path.' })
})

test('a stored value is a rule set or it is nothing', () => {
  expect(readRuleSet({ kicad: ['sam17'], blender: [] })).toEqual({ kicad: ['sam17'], blender: [] })
  for (const bad of [undefined, null, 'x', 3, [], { kicad: 'sam17' }, { kicad: [1] }]) expect(readRuleSet(bad)).toBe(null)
})

test('a rule is found under either spelling of the server', () => {
  expect(findRule({ claude_ai_Higgsfield: ['media'] }, 'claude.ai Higgsfield')).toEqual(['claude_ai_Higgsfield', ['media']])
  expect(findRule({ 'claude.ai Higgsfield': ['media'] }, 'claude_ai_Higgsfield')).toEqual(['claude.ai Higgsfield', ['media']])
  expect(findRule({ kicad: [] }, 'freecad')).toBe(undefined)
})

test('a server is held only when a valid rule leaves the folder out', () => {
  const vina = ['D:\\Desktop\\projects\\vina']
  expect(holds({ kicad: ['sam17'] }, 'kicad', 'mcp:kicad', vina)).toBe(true)
  expect(holds({ kicad: ['sam17'] }, 'kicad', 'mcp:kicad', ['D:\\Desktop\\projects\\sam17'])).toBe(false)
  expect(holds({ kicad: [] }, 'kicad', 'mcp:kicad', vina)).toBe(true) // off everywhere
  expect(holds({ claude_ai_Higgsfield: ['media'] }, 'claude.ai Higgsfield', 'mcp:claude.ai Higgsfield', vina)).toBe(true)
  expect(holds({ kicad: ['D:/gone'] }, 'kicad', undefined, vina)).toBe(true) // a folder that no longer exists is compared as stored
  expect(holds({ kicad: [] }, 'freecad', 'mcp:freecad', vina)).toBe(false) // no rule
  expect(holds({}, 'kicad', 'mcp:kicad', vina)).toBe(false)
  expect(holds(null, 'kicad', 'mcp:kicad', vina)).toBe(false) // unreadable or malformed store
  expect(holds({ kicad: [] }, 'kicad', 'longhaul@claude-plugin-test', vina)).toBe(true) // the provider alone protects nothing
})

test("the mod's own server is never held", () => {
  const f = ['D:\\x']
  expect(holds({ longhaul: [] }, 'longhaul', 'longhaul@longhaul', f)).toBe(false)
  expect(holds({ longhaul: [] }, 'longhaul', 'mcp:longhaul', f)).toBe(false) // the name alone protects
  expect(holds({ 'plugin:longhaul:longhaul': [] }, 'plugin:longhaul:longhaul', 'longhaul@inline', f)).toBe(false)
  expect(isProtected('kicad', 'mcp:kicad')).toBe(false)
  expect(isProtected('Longhaul')).toBe(true) // any case
  expect(holdMessage('kicad')).toBe('longhaul holds kicad in this folder: /longhaul mcp kicad here turns it on.')
  expect(normPath('D:\\Desktop\\media\\')).toBe('D:/Desktop/media')
})

test('the command line is read into one of five things', () => {
  expect(parseCommand('')).toEqual({ kind: 'report' })
  expect(parseCommand('  HEALTH ')).toEqual({ kind: 'health' })
  expect(parseCommand('mcp')).toEqual({ kind: 'list' })
  expect(parseCommand('mcp claude.ai Higgsfield only media D:/Desktop/media')).toEqual({ kind: 'verb', server: 'claude.ai Higgsfield', verb: 'only', patterns: ['media', 'D:/Desktop/media'] })
  expect(parseCommand('MCP kicad Only "D:/Desktop/CLO Compare" sam17')).toEqual({ kind: 'verb', server: 'kicad', verb: 'only', patterns: ['D:/Desktop/CLO Compare', 'sam17'] })
  expect(parseCommand('mcp kicad HERE')).toEqual({ kind: 'verb', server: 'kicad', verb: 'here', patterns: [] })
  expect(parseCommand('mcp kicad everywhere')).toEqual({ kind: 'verb', server: 'kicad', verb: 'everywhere', patterns: [] })
  expect(parseCommand('mcp kicad off')).toEqual({ kind: 'verb', server: 'kicad', verb: 'off', patterns: [] })
})

test('what is not understood gets one line that says so', () => {
  expect(parseCommand('page')).toEqual({ kind: 'help', why: 'There is no "page" command.' })
  expect(parseCommand('report')).toEqual({ kind: 'help', why: 'There is no "report" command.' })
  expect(parseCommand('health now')).toEqual({ kind: 'help', why: 'There is no "health now" command.' })
  expect(parseCommand('mcp kicad')).toEqual({ kind: 'help', why: 'After "kicad", type only, here, everywhere or off.' })
  expect(parseCommand('mcp kicad sometimes sam17')).toEqual({ kind: 'help', why: 'After "kicad sometimes sam17", type only, here, everywhere or off.' })
  expect(parseCommand('mcp only sam17')).toEqual({ kind: 'help', why: 'Name the server before only.' })
  expect(parseCommand('mcp kicad only')).toEqual({ kind: 'help', why: 'After only, type at least one folder name or full path.' })
  expect(parseCommand('mcp kicad here sam17')).toEqual({ kind: 'help', why: 'Type here with nothing after it.' })
})

// ---- wiring (helpers copied from health.test.ts) ----

const DAY = 86_400_000
const now = new Date(2026, 9, 18, 12, 0).getTime()
const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

type Opt = { id: string; breakdown?: unknown; reject?: boolean; files?: Record<string, string>; store?: Map<string, unknown>; cwd?: string; history?: boolean; seeds?: object[]; ctx?: number }
function stub(on: any, o: Opt) {
  const files: Record<string, string> = { ...(o.files ?? {}) } // memory files
  const store = o.store ?? new Map<string, unknown>()
  if (o.history !== false) store.set('session:old-1', newRecord('old-1', 'proj', now - 4 * DAY)) // four days of history, so unused-server verdicts are due
  for (const r of o.seeds ?? []) store.set(`session:${(r as { id: string }).id}`, r)
  const state = new Map<string, unknown>()
  const calls = { breakdown: [] as unknown[], lists: 0 }
  const find = (p: string): string | undefined => Object.keys(files).find((k) => norm(k) === norm(p))
  on('session.id', async () => ({ value: o.id }))
  on('session.cwd', async () => ({ value: o.cwd ?? '/w/p' }))
  on('fs.read', async (_$: any, e: any) => {
    const k = find(e.path)
    return k ? { value: files[k] } : { deny: 'ENOENT' }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('clock.now', async () => ({ value: now }))
  on('store.get', async (_$: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', async (_$: any, e: any) => (store.set(e.key, JSON.parse(JSON.stringify(e.value))), { value: undefined }))
  on('store.delete', async (_$: any, e: any) => (store.delete(e.key), { value: undefined }))
  on('store.keys', async () => (calls.lists++, { value: [...store.keys()] }))
  on('state.get', async (_$: any, e: any) => ({ value: { value: state.get(e.key), version: 0 } as never }))
  on('state.set', async (_$: any, e: any) => (state.set(e.key, e.value), { value: { isSet: true, version: 1 } as never }))
  on('tool.list', async () => ({ value: [] }))
  on('ui.render', async () => ({ type: 'Box', props: {}, children: [] }) as never)
  on('session.usage', async (_$: any, e: any) => {
    if (e?.breakdown) calls.breakdown.push(e.breakdown)
    if (o.reject && e?.breakdown) return { deny: 'no breakdown' }
    return { value: { rateLimits: [], context: e?.breakdown && o.breakdown ? { breakdown: o.breakdown } : {} } as never }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('prompt.attachment', async (_$: any, e: any) => ({ text: e.text }))
  on('session.start', async () => ({ cwd: '/w/p' }))
  if (o.ctx) {
    on('turn.step', async function* () {
      return { turnId: 't', index: 0, answer: '', toolUses: [], usage: { model: 'claude-opus-5-5', input_tokens: 0, output_tokens: 0, cache_read_input_tokens: o.ctx, cache_creation_input_tokens: 0 } } as never
    })
  }
  return { store, state, calls }
}

const started = new WeakSet<object>()
const start = ($: any, interactive = true) => (started.add($), $.session.start({ cwd: '/w/p', surface: null, isInteractive: interactive }))
const turn = async ($: any, id = 't') => {
  if (!started.has($)) await start($)
  await $.turn.complete({ turnId: id, reason: 'done', answer: '', durationMs: 1, isAborted: false } as never)
}

test('an unknown subcommand prints the help and not the report', async ($, on) => {
  stub(on, { id: 'c1' })
  await start($)
  const r: any = await $.command.run({ command: 'longhaul', args: 'page' })
  expect(r.text.startsWith('There is no "page" command.\n\n/longhaul ')).toBe(true)
  expect(r.text).toContain('/longhaul mcp <server> here               also load in this folder')
  expect(r.text).not.toContain('longhaul report')
})
