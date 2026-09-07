/**
 * Rules engine — faithful port of oh-my-openagent's rules layer.
 *
 * Rule files:
 *   - `AGENTS.md` / `CLAUDE.md` at the workspace root (global instructions)
 *   - `*.mdc` anywhere under the workspace (Claude-Code-style rule files)
 *   - `rules/`, `.rules/`, `.agents/rules/`, `.opencode/rules/` subdirectories
 *     (any depth, `**.md` patterns, friendlier to `*.mdc`)
 *
 * Frontmatter (YAML-lite, files beginning with `---`):
 *   description:  what the rule is for
 *   globs:        [path, patterns]    — the rule applies when any matches
 *   alwaysApply:  true                — always injected, regardless of globs
 *   applyTo:      file | session | tool | user_prompt (mirrors OmO applyTo)
 *
 * Precedence when compiled (low → high): user-level (~/.omo/rules) → root
 * workspace rules → per-directory rules (deeper wins). `alwaysApply` rules and
 * root AGENTS.md/CLAUDE.md are always included first.
 */

import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { walkFiles, omoDir, writeState, ensureDir, posix, readJson, OMO_DIR } from './util.js'
import { matchAnyGlob } from './glob.js'

export interface RuleFile {
  file: string          // absolute path
  relPath: string       // workspace-relative (posix)
  name: string
  description: string
  globs: string[]
  alwaysApply: boolean
  applyTo: string[]     // file | session | tool | user_prompt
  content: string
  priority: number      // computed layer priority
}

export interface Frontmatter extends Record<string, unknown> {
  description?: string
  globs?: string[]
  alwaysApply?: boolean
  applyTo?: string[]
}

/** Parse `---`-delimited YAML-lite frontmatter. Returns {meta, body}. */
export function parseFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: raw }
  const head = raw.slice(3, end)
  const body = raw.slice(end + 4).replace(/^\n/, '')
  const meta: Frontmatter = {}
  for (const line of head.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1] as keyof Frontmatter
    const rawVal = m[2].trim()
    if (rawVal === '') continue
    if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
      const arr = rawVal
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      meta[key] = arr
    } else if (rawVal === 'true') {
      meta[key] = true
    } else if (rawVal === 'false') {
      meta[key] = false
    } else if (/^[-+]?\d+$/.test(rawVal)) {
      meta[key] = Number(rawVal)
    } else {
      meta[key] = rawVal.replace(/^['"]|['"]$/g, '')
    }
  }
  return { meta, body }
}

/** Candidate rule file paths under a workspace root. */
export function findRuleFiles(ws: string): string[] {
  const found = new Set<string>()
  const push = (p: string): void => {
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) found.add(path.resolve(p))
  }
  // Root global instruction files
  for (const f of ['AGENTS.md', 'CLAUDE.md']) push(path.join(ws, f))
  // Walk for *.mdc + rules dirs
  for (const f of walkFiles(ws, 10)) {
    if (f.endsWith('.mdc')) found.add(f)
    const rel = posix(path.relative(ws, f))
    if (/^(rules|\.rules|\.openagent|\.agents\/rules|\.opencode\/rules)\//.test(rel)) {
      if (f.endsWith('.md')) found.add(f)
    }
  }
  return [...found].sort()
}

function ruleNameFromFile(rel: string, body: string): string {
  const base = path.basename(rel, path.extname(rel))
  const firstH = /^#+\s+(.*)$/m.exec(body)
  return firstH ? firstH[1].trim() : base
}

/** Load + parse a rule file. */
export function loadRule(ws: string, file: string): RuleFile | null {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const { meta, body } = parseFrontmatter(raw)
  // Empty rule bodies (stale artifacts, empty placeholders) carry no
  // actionable content — never treat them as rules, or the rules-injector
  // would fire with an empty shell.
  if (!body.trim()) return null
  const rel = posix(path.relative(ws, file))
  const name = (meta.description as string) || ruleNameFromFile(rel, body)
  const globs = Array.isArray(meta.globs)
    ? (meta.globs as string[]).map(String)
    : typeof meta.globs === 'string'
      ? [meta.globs]
      : []
  const applyTo = Array.isArray(meta.applyTo)
    ? (meta.applyTo as string[]).map(String)
    : ['file', 'session']
  // Layer priority: user rules (0) < root (1) < deeper dirs (2 + depth)
  const depth = path.dirname(rel).split('/').filter(Boolean).length
  let priority = 1
  const abs = path.resolve(file)
  const userRules = path.join(homedir(), '.omo', 'rules')
  if (abs.startsWith(userRules)) priority = 0
  else if (path.dirname(abs) === ws) priority = 1
  else priority = Math.min(2 + depth, 8)
  const isGlobal = (rel.toLowerCase() === 'agents.md' || rel.toLowerCase() === 'claude.md')
  const alwaysApply = meta.alwaysApply === true || isGlobal
  return {
    file: abs,
    relPath: rel,
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    globs,
    alwaysApply,
    applyTo,
    content: body.trim(),
    priority,
  }
}

/** Scan a workspace for all rules. */
export function scanRules(ws: string): RuleFile[] {
  const rules: RuleFile[] = []
  // User-level rules dir
  const userRulesDir = path.join(homedir(), '.omo', 'rules')
  if (fs.existsSync(userRulesDir)) {
    for (const f of walkFiles(userRulesDir, 6)) {
      if (f.endsWith('.mdc') || f.endsWith('.md')) {
        // Skip the engine's own persisted artifacts (compiled.md from an
        // earlier user-level compile) — they are outputs, not rule sources.
        if (path.basename(f) === 'compiled.md') continue
        const r = loadRule(ws, f)
        if (r) rules.push(r)
      }
    }
  }
  for (const f of findRuleFiles(ws)) {
    const r = loadRule(ws, f)
    if (r) rules.push(r)
  }
  // Dedup by abs path
  const seen = new Set<string>()
  return rules.filter((r) => (seen.has(r.file) ? false : (seen.add(r.file), true)))
}

/** 注入通道：file=按路径（edit 工具后置注入）、session=会话开始时注入一次、tool/user_prompt=预留。 */
export type RuleChannel = 'file' | 'session' | 'tool' | 'user_prompt'

/**
 * Find rules that apply to a given (workspace-relative, posix) target path on a
 * given injection channel. Returns {always, matched} with alwaysApply rules and
 * glob-matched rules.
 *
 * Channel gate: a rule only fires on channels it declares in `applyTo`
 * (rules without applyTo default to ['file','session']). alwaysApply does NOT
 * bypass the channel gate — otherwise a `[session, tool]` standing rule would
 * still inject on every file edit.
 */
export function rulesForPath(ws: string, relTarget: string, channel: RuleChannel = 'file'): { rules: RuleFile[]; matched: RuleFile[]; always: RuleFile[] } {
  const all = scanRules(ws)
  const matched: RuleFile[] = []
  const always: RuleFile[] = []
  for (const r of all) {
    if (!r.applyTo.includes(channel)) continue
    if (r.alwaysApply) {
      always.push(r)
      continue
    }
    if (r.globs.length === 0) {
      matched.push(r)
      continue
    }
    if (matchAnyGlob(r.globs, relTarget)) matched.push(r)
  }
  const order = [...always, ...matched]
  order.sort((a, b) => a.priority - b.priority)
  return { rules: order, matched, always }
}

/**
 * Standing rules for the `session` channel: alwaysApply rules that declare
 * `applyTo` containing 'session' (e.g. a `[session, tool]` 铁律). Plain rules
 * (default ['file','session']) are intentionally excluded — a session-start
 * dump of every rule would duplicate the file-channel injections and spam the
 * context.
 */
export function sessionRules(ws: string): RuleFile[] {
  const out = scanRules(ws).filter((r) => r.alwaysApply && r.applyTo.includes('session'))
  out.sort((a, b) => a.priority - b.priority)
  return out
}

/** Compile a markdown block from matched rules (a "compiled rules" prompt section). */
export function compileRules(rules: RuleFile[]): string {
  if (rules.length === 0) return ''
  const parts: string[] = []
  parts.push('## Compiled Rules (oh-my-openagent rules engine)')
  for (const r of rules) {
    parts.push('')
    parts.push(`### ${r.name}`)
    if (r.description) parts.push(`> ${r.description}`)
    if (r.globs.length) parts.push(`> applies to: ${r.globs.join(', ')}`)
    if (r.alwaysApply) parts.push(`> alwaysApply: true`)
    if (r.applyTo.length) parts.push(`> channels: ${r.applyTo.join(', ')}`)
    parts.push('')
    parts.push(r.content)
  }
  return parts.join('\n')
}

/** Persist the compiled rule set for a workspace. */
export function writeCompiledRules(ws: string, markdown: string): string {
  const out = omoDir(ws, 'rules', 'compiled.md')
  ensureDir(path.dirname(out))
  writeState(out, markdown)
  return out
}

/** Index file so later sessions can load the compiled rules cheaply. */
export interface RulesIndex {
  generatedAt: string
  ws: string
  files: string[]
}

/** Rebuild the persistent rules index (compiled block + manifest). */
export function refreshRulesState(ws: string, targetRel?: string): {
  files: RuleFile[]
  matched: RuleFile[]
  always: RuleFile[]
  compiled: string
  compiledFile: string
} {
  const { rules, matched, always } = rulesForPath(ws, targetRel ?? '', 'file')
  const compiled = compileRules(rules)
  const compiledFile = writeCompiledRules(ws, compiled)
  ensureDir(path.join(ws, OMO_DIR))
  const idx: RulesIndex = {
    generatedAt: new Date().toISOString(),
    ws,
    files: rules.map((r) => r.relPath),
  }
  writeState(omoDir(ws, 'rules', 'index.json'), JSON.stringify(idx, null, 2))
  return { files: rules, matched, always, compiled, compiledFile }
}

export { omoDir }
