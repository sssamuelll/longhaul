import { test, expect } from 'claude-code/testing'
import { nameKey, normPath, checkPattern, matchesFolder, readRuleSet, findRule, isProtected, holds, holdMessage } from './mcp'
import { headingKey } from './health'

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
