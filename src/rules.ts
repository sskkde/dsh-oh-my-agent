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
 *
 * Directory-scoped AGENTS.md (any depth below the root): applies only inside
 * its own directory subtree, discovered level-by-level along the target's real
 * ancestor chain (root → deep, independent of the walk depth cap). The
 * workspace is the trust boundary: `../` escapes, prefix collisions, absolute
 * external paths and symlinks pointing outside never contribute rules. See
 * docs/subsystems/rule-loading.md for the full contract.
 */

import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { walkFiles, omoDir, writeState, ensureDir, posix, readJson, OMO_DIR, isWithin } from './util.js'
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
  /** 目录作用域：非 null 时规则只适用该（workspace 相对）目录及其后代（子 AGENTS.md 专用）。 */
  scopeDir: string | null
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
  // Walk for *.mdc + rules dirs + sub AGENTS.md
  for (const f of walkFiles(ws, 10)) {
    if (f.endsWith('.mdc')) found.add(f)
    if (path.basename(f) === 'AGENTS.md') found.add(f)
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
  const wsAbs = path.resolve(ws)
  const absFile = path.resolve(file)
  const withinWs = isWithin(wsAbs, absFile)
  const rel = posix(path.relative(wsAbs, absFile))
  // Sub AGENTS.md (non-root) is directory-scoped: applies only inside its own
  // directory subtree. alwaysApply / empty globs must not lift that scope, and
  // it defaults to the file channel only — a local rule never becomes a
  // session-wide standing rule.
  const isSubDirAgent = withinWs && path.basename(file) === 'AGENTS.md' && rel !== 'AGENTS.md'
  const scopeDir = isSubDirAgent ? posix(path.dirname(rel)) : null
  const name = (meta.description as string) || ruleNameFromFile(rel, body)
  const globs = Array.isArray(meta.globs)
    ? (meta.globs as string[]).map(String)
    : typeof meta.globs === 'string'
      ? [meta.globs]
      : []
  const applyTo = Array.isArray(meta.applyTo)
    ? (meta.applyTo as string[]).map(String)
    : isSubDirAgent
      ? ['file']
      : ['file', 'session']
  // Layer priority: user rules (0) < root (1) < deeper dirs (2 + depth)
  const depth = path.dirname(rel).split('/').filter(Boolean).length
  let priority = 1
  const abs = path.resolve(file)
  const userRules = path.join(homedir(), '.omo', 'rules')
  if (abs.startsWith(userRules)) priority = 0
  else if (path.dirname(abs) === wsAbs) priority = 1
  else priority = 2 + depth
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
    scopeDir,
  }
}

/** True when `file`'s real path (symlinks resolved) stays inside the workspace —
 * an AGENTS.md that is a symlink pointing outside must never be read (trust
 * boundary = the workspace itself). */
function realWithinWs(ws: string, file: string): boolean {
  try {
    const wsReal = fs.realpathSync(path.resolve(ws))
    return isWithin(wsReal, fs.realpathSync(file))
  } catch {
    return false
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
    // Every workspace rule source (AGENTS, CLAUDE, mdc, rules/*.md) is inside
    // the trust boundary; user-level rules above intentionally remain external.
    if (!realWithinWs(ws, f)) continue
    const r = loadRule(ws, f)
    if (r) rules.push(r)
  }
  // Dedup by abs path
  const seen = new Set<string>()
  return rules.filter((r) => (seen.has(r.file) ? false : (seen.add(r.file), true)))
}

/** 注入通道：file=按路径（edit 工具后置注入）、session=会话开始时注入一次、tool/user_prompt=预留。 */
export type RuleChannel = 'file' | 'session' | 'tool' | 'user_prompt'

/** Posix-relative containment: is `rel` equal to or a descendant of `dirRel`? */
function relWithin(dirRel: string, rel: string): boolean {
  if (!dirRel || dirRel === '.') return true
  return rel === dirRel || rel.startsWith(dirRel + '/')
}

/**
 * Normalize a target path to the workspace trust boundary. Returns the
 * workspace-relative posix path (`''` = the root itself) plus the directory the
 * ancestor walk should start from (the target itself when it is an existing
 * directory, otherwise its parent). Returns null for anything outside the
 * boundary: `../` escapes, absolute external paths, prefix collisions
 * (`src2/...` is not `src/...`) and targets whose existing ancestor chain
 * resolves (symlink) outside the workspace.
 */
export function resolveTargetWithinWs(ws: string, target: string): { rel: string; baseDir: string } | null {
  const wsAbs = path.resolve(ws)
  if (!target || !target.trim()) return { rel: '', baseDir: wsAbs }
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(wsAbs, target)
  if (!isWithin(wsAbs, abs)) return null
  // Symlink boundary: the deepest existing ancestor of the target must really
  // live inside the workspace (realpath), else the target is out of bounds.
  try {
    const wsReal = fs.realpathSync(wsAbs)
    let probe = abs
    for (;;) {
      if (fs.existsSync(probe)) break
      const parent = path.dirname(probe)
      if (parent === probe) return null
      probe = parent
    }
    if (!isWithin(wsReal, fs.realpathSync(probe))) return null
  } catch {
    return null
  }
  const rel = posix(path.relative(wsAbs, abs))
  let baseDir = path.dirname(abs)
  try {
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) baseDir = abs
  } catch { /* treat as file target */ }
  return { rel, baseDir }
}

/**
 * Level-by-level ancestor AGENTS.md discovery from the workspace root down to
 * `baseDir` (inclusive, never above the root). Deliberately independent of
 * walkFiles' depth cap so a 13-level-deep AGENTS.md still reaches its targets.
 * Every directory and file on the chain must realpath inside the workspace —
 * symlinked escapes contribute nothing.
 */
function ancestorAgentFiles(ws: string, baseDir: string): string[] {
  const out: string[] = []
  let wsReal = ''
  try {
    wsReal = fs.realpathSync(path.resolve(ws))
  } catch {
    return out
  }
  const stop = path.resolve(ws)
  const chain: string[] = []
  let cur = path.resolve(baseDir)
  for (;;) {
    if (!isWithin(stop, cur)) break
    chain.push(cur)
    if (cur === stop) break
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  for (const dir of chain.reverse()) {
    try {
      if (!isWithin(wsReal, fs.realpathSync(dir))) continue
    } catch {
      continue
    }
    const f = path.join(dir, 'AGENTS.md')
    try {
      if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue
      if (!isWithin(wsReal, fs.realpathSync(f))) continue
    } catch {
      continue
    }
    out.push(f)
  }
  return out
}

/**
 * Filter a pre-scanned rule set for one target path + channel, merging in
 * ancestor AGENTS.md files that the scan's depth cap may have missed. Scope
 * first (directory-subtree boundary), then the channel gate, then
 * alwaysApply/empty-globs/glob matching. Ordering: alwaysApply rules first,
 * then by layer priority (root → deep).
 */
export function applicableRulesFor(ws: string, all: RuleFile[], target: string, channel: RuleChannel): { rules: RuleFile[]; matched: RuleFile[]; always: RuleFile[] } {
  const resolved = resolveTargetWithinWs(ws, target)
  if (!resolved) return { rules: [], matched: [], always: [] }
  const rel = resolved.rel
  const byFile = new Map<string, RuleFile>()
  for (const r of all) byFile.set(r.file, r)
  for (const f of ancestorAgentFiles(ws, resolved.baseDir)) {
    if (byFile.has(f)) continue
    const r = loadRule(ws, f)
    if (r) byFile.set(f, r)
  }
  const matched: RuleFile[] = []
  const always: RuleFile[] = []
  for (const r of byFile.values()) {
    if (!r.applyTo.includes(channel)) continue
    if (r.scopeDir && !relWithin(r.scopeDir, rel)) continue
    if (r.alwaysApply) {
      always.push(r)
      continue
    }
    if (r.globs.length === 0) {
      matched.push(r)
      continue
    }
    if (matchAnyGlob(r.globs, rel)) matched.push(r)
  }
  const order = [...always, ...matched]
  order.sort((a, b) => a.priority - b.priority)
  return { rules: order, matched, always }
}

/**
 * Find rules that apply to a given target path on a given injection channel.
 * Returns {rules, matched, always} with alwaysApply rules and glob-matched
 * rules; directory-scoped sub AGENTS.md files on the target's ancestor chain
 * are included root → deep.
 *
 * Channel gate: a rule only fires on channels it declares in `applyTo`.
 * alwaysApply does NOT bypass the channel gate, and (for sub AGENTS.md) it does
 * NOT bypass the directory-scope boundary either.
 */
export function rulesForPath(ws: string, relTarget: string, channel: RuleChannel = 'file'): { rules: RuleFile[]; matched: RuleFile[]; always: RuleFile[] } {
  return applicableRulesFor(ws, scanRules(ws), relTarget, channel)
}

/**
 * Standing rules for the `session` channel: alwaysApply rules that declare
 * `applyTo` containing 'session' (e.g. a `[session, tool]` 铁律). Plain rules
 * (default ['file','session']) are intentionally excluded — a session-start
 * dump of every rule would duplicate the file-channel injections and spam the
 * context. Directory-scoped sub AGENTS.md files are also excluded: a local
 * rule must never be escalated to a workspace-wide standing rule.
 */
export function sessionRules(ws: string): RuleFile[] {
  const out = scanRules(ws).filter((r) => r.alwaysApply && r.applyTo.includes('session') && !r.scopeDir)
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
    parts.push(`> source: ${r.relPath}`)
    if (r.scopeDir) parts.push(`> scope: ${r.scopeDir}/ (directory subtree only)`)
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
