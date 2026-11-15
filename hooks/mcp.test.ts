import { test, expect } from 'claude-code/testing'
import { parseCommand, knownServers, suggestionsOf, renderList, MODE_OFF, type Known, type Here, planVerb, resolveServer, connectLine, STAYS_ON, nameKey, normPath, checkPattern, matchesFolder, readRuleSet, findRule, isProtected, holds, holdMessage } from './mcp'
import { headingKey } from './health'
import { newRecord, projectOf } from './ledger'
import type { BaseSnapshot } from './health'

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

// ---- known servers, suggestions and the list ----

const rec = (id: string, root: string, calls: Record<string, number>, mcp?: BaseSnapshot['mcp']) => {
  const r = newRecord(id, projectOf(root), now - 5 * DAY, root)
  r.mcpCalls = calls
  if (mcp) r.base = { at: now - 5 * DAY, total: 0, mcp, memory: [], skills: { count: 0, tokens: 0 }, duplicate: { lines: 0, tokens: 0, files: [] } }
  return r
}
const old = { mature: true, since: now - 21 * DAY }

test('the four sources are joined under one name', () => {
  const [h] = knownServers({
    seen: [{ name: 'claude.ai Higgsfield', isHeld: true }],
    tools: [],
    records: [rec('a', 'D:/Desktop/media', { claude_ai_Higgsfield: 41 }, { claude_ai_Higgsfield: { tools: 170, tokens: 5800, loaded: 0 } })],
    rules: { claude_ai_Higgsfield: ['D:/Desktop/media'] },
  })
  expect(h).toEqual({ key: 'claude_ai_Higgsfield', name: 'claude.ai Higgsfield', isOn: false, isSeen: true, rule: ['D:/Desktop/media'], tools: 170, tokens: 5800, calls: [['D:/Desktop/media', 41]], idleIn: [] })
})

test('a server is known from any one source', () => {
  const none = { seen: [], tools: [], records: [], rules: {} }
  expect(knownServers({ ...none, tools: [{ name: 'mcp__blender__render', serverName: 'blender' }] })[0]).toMatchObject({ name: 'blender', isOn: true, isSeen: true })
  expect(knownServers({ ...none, seen: [{ name: 'kicad', isHeld: true }] })[0]).toMatchObject({ name: 'kicad', isOn: false, isSeen: true })
  expect(knownServers({ ...none, seen: [{ name: 'kicad', isHeld: false }] })[0].isOn).toBe(true)
  expect(knownServers({ ...none, rules: { ghost: ['D:/gone'] } })[0]).toMatchObject({ name: 'ghost', isSeen: false, rule: ['D:/gone'], calls: [] })
  expect(knownServers({ ...none, tools: [{ name: 'mcp__longhaul__review', serverName: 'longhaul' }], rules: { longhaul: [] } })).toEqual([])
})

test('cost comes from the newest snapshot, folders from every record', () => {
  const older = { ...rec('a', 'D:/p/sam17', { kicad: 3 }, { kicad: { tools: 60, tokens: 3000 } }), startedAt: now - 9 * DAY }
  older.base!.at = now - 9 * DAY
  const newer = rec('b', 'D:/p/vina', {}, { kicad: { tools: 61, tokens: 3100 } })
  const legacy = { ...rec('c', 'D:/p/x', { kicad: 1 }), root: undefined, project: 'legacy' }
  const [k] = knownServers({ seen: [], tools: [], records: [older, newer, legacy], rules: {} })
  expect([k.tools, k.tokens]).toEqual([61, 3100])
  expect(k.calls).toEqual([['D:/p/sam17', 3], ['legacy', 1]])
  expect(k.idleIn).toEqual(['D:/p/vina'])
})

test('a suggestion is off, only, or nothing', () => {
  const base = { isOn: true, isSeen: true, idleIn: [] as string[], calls: [] as [string, number][] }
  const folders = ['D:/p/sam17', 'D:/p/vina', 'D:/a/vina', 'D:/b/vina-bake', 'D:/Desktop/CLO Compare']
  const s = (k: object, h = old) => suggestionsOf([{ key: 'kicad', name: 'kicad', tools: 60, ...base, ...k } as never], folders, h, now)
  expect(s({})).toEqual([{ key: 'kicad', name: 'kicad', tools: 60, why: 'was not called in the last 21 days', command: '/longhaul mcp kicad off' }])
  expect(s({}, { mature: true, since: now - 5 * DAY - 1000 })[0].why).toBe('was not called in the last 5 days')
  expect(s({}, { mature: false, since: now - DAY })).toEqual([])
  expect(s({ rule: [] })).toEqual([])
  expect(s({ calls: [['D:/p/sam17', 9]], idleIn: ['D:/p/vina'] })[0]).toMatchObject({ why: 'was called only in sam17 in the last 21 days', command: '/longhaul mcp kicad only sam17' })
  expect(s({ calls: [['D:/a/vina', 2]], idleIn: ['D:/p/sam17'] })[0].command).toBe('/longhaul mcp kicad only D:/a/vina') // the name vina would match other folders
  expect(s({ calls: [['D:/Desktop/CLO Compare', 2]], idleIn: ['D:/p/sam17'] })[0].command).toBe('/longhaul mcp kicad only "CLO Compare"')
  expect(s({ calls: [['D:/p/sam17', 9]] })).toEqual([]) // carried nowhere without a call
  expect(s({ calls: [['a', 1], ['b', 1], ['c', 1], ['d', 1]], idleIn: ['e'] })).toEqual([]) // more than 3 folders
})

test('the list, as the design shows it', () => {
  const known: Known[] = [
    { key: 'claude_ai_Higgsfield', name: 'claude.ai Higgsfield', isOn: false, isSeen: true, rule: ['D:/Desktop/media'], tools: 170, tokens: 5800, calls: [['D:/Desktop/media', 41]], idleIn: [] },
    { key: 'blender', name: 'blender', isOn: true, isSeen: true, tools: 10, tokens: 1400, calls: [], idleIn: ['D:/Desktop/projects/vina'] },
  ]
  const folders = ['D:/Desktop/media', 'D:/Desktop/projects/vina']
  const o = { suggestions: suggestionsOf(known, folders, old, now), folders, here: { root: 'D:\\Desktop\\projects\\vina' }, isOn: true, history: old, now }
  expect(renderList(known, o)).toBe(
    [
      'MCP servers',
      '',
      'claude.ai Higgsfield: 170 tools, about 5,800 tokens (est.) per session',
      '  rule: only D:/Desktop/media (held in this folder)',
      '  called in the last 21 days: media (41)',
      'blender: 10 tools, about 1,400 tokens (est.) per session',
      '  rule: none, loads everywhere',
      '  not called in the last 21 days',
      '  suggestion: /longhaul mcp blender off',
    ].join('\n'),
  )
  expect(renderList(known, { ...o, here: { root: 'C:\\j\\media', real: 'D:\\Desktop\\media' } })).toContain('rule: only D:/Desktop/media (loads in this folder)')
  expect(renderList(known, { ...o, isOn: false }).split('\n').slice(0, 3)).toEqual([MODE_OFF, '', 'MCP servers'])
  expect(renderList(known, { ...o, isOn: false })).toContain('  rule: only D:/Desktop/media\n')
})

test('the list says what it does not know', () => {
  const o = { suggestions: [], folders: [], here: { root: 'D:\\x' }, isOn: true, history: old, now }
  const ghost: Known = { key: 'ghost', name: 'ghost', isOn: false, isSeen: false, rule: [], calls: [], idleIn: [] }
  expect(renderList([ghost], o)).toBe(['MCP servers', '', 'ghost: cost not measured yet', '  rule: off in every folder', '  not seen in the last 21 days'].join('\n'))
  const busy: Known = { ...ghost, isSeen: true, rule: undefined, calls: [['a', 6], ['b', 5], ['c', 4], ['d', 3], ['e', 2], ['f', 1], ['g', 1]] }
  expect(renderList([busy], o)).toContain('  called in the last 21 days: a (6), b (5), c (4), d (3), e (2) and 2 more')
  const young = { mature: false, since: new Date(2026, 10, 13, 9).getTime() }
  expect(renderList([{ ...ghost, isSeen: true, rule: undefined }], { ...o, history: young })).toContain('  no calls recorded since 2026-11-13')
  expect(renderList([busy], { ...o, history: young })).toContain('  called since 2026-11-13: a (6), b (5)')
  expect(renderList([ghost], { ...o, history: young })).toContain('  not seen in the last 21 days')
  expect(renderList([], o)).toBe('MCP servers\n\nNo MCP servers known yet.')
})

const kn = (o: Partial<Known> = {}): Known => ({ key: 'kicad', name: 'kicad', isOn: false, isSeen: true, calls: [], idleIn: [], ...o })
const vina: Here = { root: 'C:\\Users\\simon\\Desktop\\projects\\vina', real: 'D:\\Desktop\\projects\\vina' }

test('only replaces the rule and connects when this folder matches', () => {
  expect(planVerb(kn(), 'only', [{ pattern: 'sam17', isPath: false }], {}, vina, true)).toEqual({ rules: { kicad: ['sam17'] }, connect: false, lines: ['kicad loads only in sam17.'] })
  expect(planVerb(kn({ isOn: true }), 'only', [{ pattern: 'sam17', isPath: false }], {}, vina, true).lines).toEqual(['kicad loads only in sam17.', STAYS_ON])
  expect(planVerb(kn(), 'only', [{ pattern: 'vina', isPath: false }, { pattern: 'D:/gone', isPath: true, isMissing: true }], { kicad: ['x'] }, vina, true)).toEqual({
    rules: { kicad: ['vina', 'D:/gone'] },
    connect: true,
    lines: ['kicad loads only in vina, D:/gone.', 'D:/gone was not found, so it was saved as typed.'],
  })
})

test('here adds this folder, by its real path, unless a pattern already matches', () => {
  expect(planVerb(kn(), 'here', [], {}, vina, true)).toEqual({ connect: false, lines: ['kicad has no rule and loads everywhere.'] })
  expect(planVerb(kn({ rule: ['sam17'] }), 'here', [], { kicad: ['sam17'] }, vina, true)).toEqual({ rules: { kicad: ['sam17', 'D:/Desktop/projects/vina'] }, connect: true, lines: ['kicad loads only in sam17, D:/Desktop/projects/vina.'] })
  expect(planVerb(kn({ rule: ['sam17'] }), 'here', [], { kicad: ['sam17'] }, { root: 'D:\\w\\x\\' }, true).rules).toEqual({ kicad: ['sam17', 'D:/w/x'] })
  expect(planVerb(kn({ rule: ['vina'] }), 'here', [], { kicad: ['vina'] }, vina, true)).toEqual({ connect: true, lines: ['kicad loads only in vina.'] })
  expect(planVerb(kn({ rule: [] }), 'here', [], { kicad: [] }, vina, true).rules).toEqual({ kicad: ['D:/Desktop/projects/vina'] }) // off everywhere, then here
})

test('everywhere removes the rule, off empties it', () => {
  expect(planVerb(kn({ rule: [] }), 'everywhere', [], { kicad: [], blender: ['x'] }, vina, true)).toEqual({ rules: { blender: ['x'] }, connect: true, lines: ['kicad has no rule and loads everywhere.'] })
  expect(planVerb(kn({ isOn: true }), 'off', [], { blender: ['x'] }, vina, true)).toEqual({ rules: { blender: ['x'], kicad: [] }, connect: false, lines: ['kicad is off in every folder.', STAYS_ON] })
  expect(planVerb(kn(), 'off', [], {}, vina, true).lines).toEqual(['kicad is off in every folder.'])
  expect(planVerb(kn(), 'everywhere', [], { blender: ['x'] }, vina, true)).toEqual({ connect: true, lines: ['kicad has no rule and loads everywhere.'] })
})

test('with mcp_mode off a rule is saved and nothing is connected', () => {
  expect(planVerb(kn({ isOn: true }), 'off', [], {}, vina, false)).toEqual({ rules: { kicad: [] }, connect: false, lines: ['kicad is off in every folder.', MODE_OFF] })
  expect(planVerb(kn({ rule: ['sam17'] }), 'here', [], { kicad: ['sam17'] }, vina, false)).toMatchObject({ connect: false })
  expect(planVerb(kn({ rule: [] }), 'everywhere', [], { kicad: [] }, vina, false)).toMatchObject({ connect: false, lines: ['kicad has no rule and loads everywhere.', MODE_OFF] })
})

test('a rule moves to the name the hook gave', () => {
  const h = kn({ key: 'claude_ai_Higgsfield', name: 'claude.ai Higgsfield', rule: ['media'] })
  expect(planVerb(h, 'off', [], { claude_ai_Higgsfield: ['media'] }, vina, true).rules).toEqual({ 'claude.ai Higgsfield': [] })
})

test('a server is found whatever its case or spelling, or refused with the known ones', () => {
  const known = [kn(), kn({ key: 'claude_ai_Higgsfield', name: 'claude.ai Higgsfield' }), kn({ key: 'blender', name: 'blender' })]
  expect(resolveServer(known, 'KICAD')).toBe(known[0])
  expect(resolveServer(known, 'claude_ai_higgsfield')).toBe(known[1])
  expect(resolveServer(known, 'kicadd')).toEqual({ error: 'No MCP server is called "kicadd". Known: blender, claude.ai Higgsfield, kicad.' })
  expect(resolveServer([], 'kicad')).toEqual({ error: 'No MCP server is called "kicad". None is known yet.' })
  expect(resolveServer(known, 'Longhaul')).toEqual({ error: "longhaul's own server is never held." })
})

test('the connection is reported as the engine answered', () => {
  expect(connectLine({ isConnected: true })).toBe('It is on in this session.')
  expect(connectLine({ isConnected: false, message: 'needs sign-in.' })).toBe('It did not connect: needs sign-in.')
  expect(connectLine(undefined)).toBe('It did not connect.')
})

type Opt = { id: string; breakdown?: unknown; reject?: boolean; files?: Record<string, string>; store?: Map<string, unknown>; cwd?: string; history?: boolean; seeds?: object[]; ctx?: number; root?: string | (() => string); real?: Record<string, string> }
function stub(on: any, o: Opt) {
  const files: Record<string, string> = { ...(o.files ?? {}) } // memory files
  const store = o.store ?? new Map<string, unknown>()
  if (o.history !== false) store.set('session:old-1', newRecord('old-1', 'proj', now - 4 * DAY)) // four days of history, so unused-server verdicts are due
  for (const r of o.seeds ?? []) store.set(`session:${(r as { id: string }).id}`, r)
  const state = new Map<string, unknown>()
  const calls = { breakdown: [] as unknown[], lists: 0 }
  const stats: string[] = []
  const real = o.real ?? {}
  const find = (p: string): string | undefined => Object.keys(files).find((k) => norm(k) === norm(p))
  on('session.id', async () => ({ value: o.id }))
  on('session.cwd', async () => ({ value: o.cwd ?? '/w/p' }))
  on('session.root', async () => ({ value: typeof o.root === 'function' ? o.root() : (o.root ?? '/w/p') }))
  on('fs.stat', async (_$: any, e: any) => (stats.push(norm(e.path)), norm(e.path) in real ? { value: { realPath: real[norm(e.path)] } } : { deny: 'ENOENT' }))
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
  return { store, state, calls, stats }
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

test("a session record keeps the folder's real path", async ($, on) => {
  const s = stub(on, { id: 'r1', root: '/w/r1', real: { '/w/r1': 'D:\\real\\r1' } })
  await start($)
  await turn($)
  const rec = s.store.get('session:r1') as { root: string; project: string }
  expect(rec.root).toBe('D:/real/r1')
  expect(rec.project).toBe('r1')
  await $.command.run({ command: 'longhaul', args: 'health' })
  expect(s.stats.filter((p) => p === '/w/r1').length).toBe(1) // looked up once
})

test('when the lookup fails the reported folder is kept', async ($, on) => {
  const s = stub(on, { id: 'r2', root: 'D:\\w\\r2\\' })
  await start($)
  await turn($)
  expect((s.store.get('session:r2') as { root: string }).root).toBe('D:/w/r2')
})
