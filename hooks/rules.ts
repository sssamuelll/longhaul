export type Rule = { id: string; verdict: 'opus' | 'sonnet'; pattern: string; flags?: string }

// \b is ASCII-only, so Spanish rules use \p{L} lookarounds with the u flag.
const L = String.raw`(?<!\p{L})`
const R = String.raw`(?!\p{L})`
const es = (id: string, verdict: Rule['verdict'], body: string): Rule => ({ id: `es.${id}`, verdict, pattern: `${L}(?:${body})${R}`, flags: 'iu' })
const en = (id: string, verdict: Rule['verdict'], body: string): Rule => ({ id: `en.${id}`, verdict, pattern: String.raw`\b(?:${body})\b` })

const DATA = 'data|database|db|tables?|migrations?|records?|rows?|users?|backups?|prod|production|branch(?:es)?|history'
const STEP = String.raw`go with|start|do|run|execute|implement|continue with|proceed with`

export const DEFAULT_RULES: Rule[] = [
  // Opus: design and judgment
  en('design', 'opus', String.raw`design|architect(?:ure)?|trade-?offs?|brainstorm\w*`),
  en('decide', 'opus', String.raw`should (?:we|i)|which (?:is )?(?:better|best)|best way|most professional|pros and cons|most natural|best (?:approach|option|solution|practice)`),
  en('why', 'opus', String.raw`why|root cause|intermittent|flaky`),
  en('review', 'opus', String.raw`review|audit|critique`),
  en('write-plan', 'opus', String.raw`(?:write|draft|create|make|outline)\b.{0,30}\b(?:plan|spec|rfc|design doc)`),
  en('security', 'opus', String.raw`security|vulnerabilit\w+|exploit|xss|csrf|secrets?|credentials?`),
  en('money', 'opus', String.raw`payments?|billing|invoices?|stripe|refunds?|checkout`),
  en('auth', 'opus', String.raw`auth|authentication|authorization|oauth|passwords?|jwt`),
  en('delete-data', 'opus', String.raw`(?:delete|drop|wipe|purge|truncate)\b.{0,40}\b(?:${DATA})`),
  // Opus, Spanish
  es('design', 'opus', String.raw`dise[ñn]o|dise[ñn]ar|arquitectura|brainstorm\w*|lluvia de ideas|pros y contras`),
  es('decide', 'opus', String.raw`cu[aá]l (?:ser[ií]a|es (?:la|el) (?:mejor|forma|manera))|deber[ií]amos|(?:la )?mejor (?:forma|manera)|(?:lo )?m[aá]s profesional|qu[eé] opinas`),
  es('why', 'opus', String.raw`por qu[eé]|causa ra[ií]z|intermitente`),
  es('review', 'opus', String.raw`revisa|revisar|revisi[oó]n|audita|auditar|critica`),
  es('write-plan', 'opus', String.raw`(?:escribe|redacta|crea|haz|arma)\b.{0,30}\b(?:plan|spec|especificaci[oó]n)`),
  es('security', 'opus', String.raw`seguridad|vulnerabilidad\w*|credenciales|secretos?`),
  es('money', 'opus', String.raw`pagos?|facturaci[oó]n|facturas?|reembolsos?`),
  es('auth', 'opus', String.raw`autenticaci[oó]n|autorizaci[oó]n|contrase[ñn]as?`),
  es('delete-data', 'opus', String.raw`(?:borra|borrar|elimina|eliminar|bota)\b.{0,40}\b(?:datos|base de datos|tablas?|migraciones|registros|usuarios|respaldos?|backups?|producci[oó]n|historial)`),
  // Sonnet: execution Opus can review
  en('plan-step', 'sonnet', String.raw`(?:${STEP})\s+(?:the\s+)?(?:next\s+)?(?:task|step|milestone)(?:\s*#?\d+)?|(?:${STEP})\s+[a-z]\d+`),
  en('mechanical', 'sonnet', String.raw`rename\s+\S+\s+to\s+\S+|reformat|find and replace|search and replace|bulk (?:rename|replace|edit)`),
  { id: 'en.search', verdict: 'sonnet', pattern: String.raw`^\s*(?:where is|where's|find|locate|search for|grep)\b` },
  en('docs', 'sonnet', String.raw`add (?:jsdoc|docstrings?|comments?) to|document (?:this|the) (?:code|function|module)|generate (?:the )?(?:docs|readme)`),
  en('lint-fix', 'sonnet', String.raw`fix\b.{0,25}\b(?:lint|type|typescript|eslint|tsc)\b.{0,10}`),
  en('run-tests', 'sonnet', String.raw`run (?:the )?(?:tests?|test suite|linter|build)`),
  es('plan-step', 'sonnet', String.raw`(?:ejecuta|arranca|empieza|sigue|implementa|vamos|dale)\s+(?:con\s+)?(?:(?:el|la|la siguiente|el siguiente)\s+)?(?:hito|tarea|paso|etapa)(?:\s*#?\d+)?|(?:arranca|empieza|vamos|dale)\s+con\s+[a-z]\d+`),
  es('mechanical', 'sonnet', String.raw`renombra\s+\S+\s+(?:a|como)\s+\S+|reformatea|busca y reemplaza`),
  { id: 'es.search', verdict: 'sonnet', pattern: String.raw`^\s*(?:d[oó]nde (?:est[aá]n?|queda|se define)|busca|encuentra|localiza)(?!\p{L})`, flags: 'iu' },
  es('docs', 'sonnet', String.raw`documenta (?:esto|el c[oó]digo|la funci[oó]n)|genera (?:la )?(?:documentaci[oó]n|readme)`),
  es('lint-fix', 'sonnet', String.raw`arregla\b.{0,25}\b(?:lint|tipos|eslint|tsc)`),
  es('run-tests', 'sonnet', String.raw`corre (?:las )?pruebas|ejecuta (?:las )?(?:pruebas|tests)`),
]

let warned = false // one debug line per session
export const resetRulesWarn = (): void => void (warned = false)
export const takeRulesWarn = (): boolean => (warned ? false : (warned = true))

function valid(r: unknown): r is Rule {
  const x = r as Rule
  if (!x || typeof x.id !== 'string' || typeof x.pattern !== 'string') return false
  if (x.verdict !== 'opus' && x.verdict !== 'sonnet') return false
  if (x.flags !== undefined && typeof x.flags !== 'string') return false
  try {
    new RegExp(x.pattern, x.flags ?? 'i')
    return true
  } catch {
    return false
  }
}

// The rules in a rules file's text, or null when it is not a JSON array.
export function parseRules(text: string): Rule[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter(valid) : null
  } catch {
    return null
  }
}
