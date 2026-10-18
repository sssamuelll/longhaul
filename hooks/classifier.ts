import type { Rule } from './rules'

export type Verdict = 'opus' | 'sonnet' | 'neutral'

const compiled = new WeakMap<Rule, RegExp | null>()

function compile(rule: Rule): RegExp | null {
  if (compiled.has(rule)) return compiled.get(rule)!
  let re: RegExp | null = null
  try {
    // g/y would make test() stateful
    re = new RegExp(rule.pattern, (rule.flags ?? 'i').replace(/[gy]/g, ''))
  } catch {}
  compiled.set(rule, re)
  return re
}

// OPUS wins when both fire; ruleIds lists every rule that fired.
export function classify(text: string, rules: Rule[]): { verdict: Verdict; ruleIds: string[] } {
  const ruleIds: string[] = []
  let opus = false
  let sonnet = false
  for (const rule of rules) {
    if (!compile(rule)?.test(text)) continue
    ruleIds.push(rule.id)
    if (rule.verdict === 'opus') opus = true
    else sonnet = true
  }
  return { verdict: opus ? 'opus' : sonnet ? 'sonnet' : 'neutral', ruleIds }
}
