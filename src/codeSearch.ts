/**
 * Code search — structured search (ast-grep backend) with an honest,
 * dependency-free text fallback.
 *
 * Mirrors oh-my-openagent's ast-grep MCP surface:
 *   - `search`  : structural/AST patterns when ast-grep is available
 *   - `rewrite` : AST-aware rewrite when ast-grep is available
 *   - text search always works (fast, line-anchored, scoped)
 *
 * The `backend` field reports which engine actually served the call.
 */

import fs from 'node:fs'
import path from 'node:path'
import { walkFiles, isCodeFile, isWithin, posix } from './util.js'
import { runShell, whichSync } from './cmd.js'

export interface SearchHit {
  file: string
  line: number
  column: number
  matched: string
  snippet: string
}

export interface SearchResult {
  backend: 'ast-grep' | 'text' | 'none'
  query: string
  hits: SearchHit[]
  total: number
  note?: string
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx', '.mjs': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.java': 'java', '.kt': 'kotlin',
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp',
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.sh': 'bash', '.bash': 'bash',
  '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.md': 'markdown',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.vue': 'vue', '.svelte': 'svelte',
}

function langFor(file: string): string {
  return LANG_BY_EXT[path.extname(file).toLowerCase()] ?? 'generic'
}

import { fileURLToPath } from 'node:url'
function findAstGrep(): string | null {
  // Only the real ast-grep binary. `sg` on Linux is the set-group utility,
  // NOT ast-grep. The plugin ships ast-grep via @ast-grep/cli (node_modules/.bin).
  const local = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', 'ast-grep')
  if (process.platform !== 'win32' && fs.existsSync(local)) return local
  if (process.platform === 'win32' && fs.existsSync(local + '.exe')) return local + '.exe'
  return whichSync('ast-grep')
}

/** Plain text search (always available). */
export function textSearch(
  ws: string,
  pattern: string,
  opts: { path?: string; include?: string; caseSensitive?: boolean; word?: boolean; context?: number } = {},
): SearchResult {
  const root = opts.path ? path.resolve(ws, opts.path) : ws
  const hits: SearchHit[] = []
  const q = pattern
  const flags = opts.caseSensitive ? '' : 'i'
  const re = new RegExp(opts.word ? `\\b${escapeRe(q)}\\b` : escapeRe(q), flags)
  const ctx = Math.max(0, opts.context ?? 0)
  const includeRe = opts.include ? new RegExp(globEscapeToRe(opts.include)) : null

  for (const file of walkFiles(root, 10)) {
    if (!isWithin(ws, file)) continue
    if (!isCodeFile(file)) continue
    if (opts.path && !isWithin(root, file)) continue
    const rel = posix(path.relative(ws, file))
    if (includeRe && !includeRe.test(rel)) continue
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const lines = raw.split(/\r\n|\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i])
      if (!m) continue
      const start = Math.max(0, i - ctx)
      const end = Math.min(lines.length, i + ctx + 1)
      const snippet = lines.slice(start, end).join('\n')
      hits.push({
        file: rel,
        line: i + 1,
        column: (m.index || 0) + 1,
        matched: lines[i].slice(Math.max(0, (m.index || 0) - 40), (m.index || 0) + 60),
        snippet: snippet.length > 600 ? snippet.slice(0, 600) + '…' : snippet,
      })
      if (hits.length >= 200) break
    }
    if (hits.length >= 200) break
  }
  return { backend: 'text', query: q, hits, total: hits.length }
}

/** ast-grep backed search (falls back to text search with a note). */
export async function structuredSearch(
  ws: string,
  pattern: string,
  opts: { path?: string; lang?: string; caseSensitive?: boolean } = {},
): Promise<SearchResult> {
  const sg = findAstGrep()
  if (!sg) {
    const res = textSearch(ws, pattern, { path: opts.path, caseSensitive: opts.caseSensitive })
    res.note = 'ast-grep binary not on PATH — served by text fallback; install ast-grep/sg for AST matching.'
    return res
  }
  const root = opts.path ? path.resolve(ws, opts.path) : ws
  // ast-grep output format: --format json with fields path, line, "text"
  const cmd = [
    `cd ${shellQuote(root)}`,
    `${shellQuote(sg)} run --pattern ${shellQuote(pattern)} --json`,
    opts.lang ? ` --lang ${shellQuote(opts.lang)}` : '',
  ].filter(Boolean).join(' && ')
  const r = await runShell(cmd, { cwd: root, timeoutMs: 15000 })
  if (!r.ok || !r.stdout.trim()) {
    const fallback = textSearch(ws, pattern, { path: opts.path })
    fallback.note = `ast-grep returned no/erroneous output (${r.stderr.slice(0, 120).trim() || 'no matches'}) — using text fallback.`
    return fallback
  }
  type AgRow = { path?: string; line?: number | string; col?: number | string; text?: string }
  let rows: AgRow[] = []
  try {
    const parsed = JSON.parse(r.stdout) as unknown
    if (Array.isArray(parsed)) rows = parsed as AgRow[]
    else if (parsed && typeof parsed === 'object') {
      const obj = parsed as { matches?: unknown; items?: unknown }
      rows = (Array.isArray(obj.matches) ? obj.matches : Array.isArray(obj.items) ? obj.items : []) as AgRow[]
    }
  } catch {
    const fallback = textSearch(ws, pattern, { path: opts.path })
    fallback.note = 'ast-grep JSON parse failed — using text fallback.'
    return fallback
  }
  const hits: SearchHit[] = rows
    .slice(0, 200)
    .map((row) => rowToHit(ws, root, row as Record<string, unknown>))
  return { backend: 'ast-grep', query: pattern, hits, total: hits.length }
}

/** Scan the project for several patterns at once (faithful to ast_grep_scan). */
export async function astGrepScan(
  ws: string,
  patterns: string[],
  opts: { path?: string; lang?: string } = {},
): Promise<SearchResult & { perPattern: Array<{ pattern: string; count: number }>; note: string }> {
  const sg = findAstGrep()
  if (!sg) {
    return {
      backend: 'none', query: patterns.join(' | '), hits: [], total: 0, note:
        'ast-grep not on PATH — scan unavailable; use search (text fallback).',
      perPattern: [], 
    }
  }
  const root = opts.path ? path.resolve(ws, opts.path) : ws
  const all: SearchHit[] = []
  const perPattern: Array<{ pattern: string; count: number }> = []
  for (const pat of patterns.slice(0, 12)) {
    const cmd = [
      `cd ${shellQuote(root)}`,
      `${shellQuote(sg)} run --pattern ${shellQuote(pat)} --json`,
      opts.lang ? ` --lang ${shellQuote(opts.lang)}` : '',
    ].filter(Boolean).join(' && ')
    const r = await runShell(cmd, { cwd: root, timeoutMs: 20000 })
    let count = 0
    if (r.ok && r.stdout.trim()) {
      try {
        const parsed = JSON.parse(r.stdout) as unknown
        const rows = Array.isArray(parsed) ? parsed : []
        count = rows.length
        for (const row of rows.slice(0, 40) as Array<Record<string, unknown>>) {
          all.push(rowToHit(ws, root, row))
        }
      } catch { /* ignore per-pattern parse */ }
    }
    perPattern.push({ pattern: pat, count })
  }
  return { backend: 'ast-grep', query: patterns.join(' | '), hits: all.slice(0, 200), total: all.length, note: '', perPattern }
}

/** AST-aware rewrite via ast-grep (needs binary; else honest 'unavailable'). */
export async function astRewrite(
  ws: string,
  pattern: string,
  replacement: string,
  opts: { path?: string; lang?: string } = {},
): Promise<{ ok: boolean; backend: string; files: string[]; note?: string }> {
  const sg = findAstGrep()
  if (!sg) {
    return { ok: false, backend: 'none', files: [], note: 'ast-grep binary not on PATH — rewrite requires ast-grep/sg installed.' }
  }
  const root = opts.path ? path.resolve(ws, opts.path) : ws
  // ast-grep 0.45: `--update-all` applies rewrites (plain --rewrite is a dry-run diff;
  // combining with --json suppresses application). Snapshot file mtimes to detect
  // which files actually changed.
  type Snapshot = Map<string, { mtimeMs: number; size: number }>
  const snapshotFiles = (): Snapshot => {
    const snap: Snapshot = new Map()
    try {
      for (const f of walkFiles(root, 10)) {
        if (!isWithin(ws, f)) continue
        const st = fs.statSync(f)
        snap.set(f, { mtimeMs: st.mtimeMs, size: st.size })
      }
    } catch { /* ignore */ }
    return snap
  }
  const before = snapshotFiles()
  const cmd = [
    `cd ${shellQuote(root)}`,
    `${shellQuote(sg)} run --pattern ${shellQuote(pattern)} --rewrite ${shellQuote(replacement)} --update-all`,
    opts.lang ? ` --lang ${shellQuote(opts.lang)}` : '',
  ].filter(Boolean).join(' && ')
  const r = await runShell(cmd, { cwd: root, timeoutMs: 30000 })
  if (!r.ok) return { ok: false, backend: 'ast-grep', files: [], note: r.stderr.trim() || 'rewrite failed' }
  const changed = new Set<string>()
  for (const [f, st] of before) {
    try {
      const cur = fs.statSync(f)
      if (cur.mtimeMs !== st.mtimeMs || cur.size !== st.size) changed.add(f)
    } catch { /* deleted? treat as changed */ changed.add(f) }
  }
  const files = [...changed].map((f) => posix(path.relative(ws, f))).filter(Boolean)
  return { ok: true, backend: 'ast-grep', files }
}


/** Normalize an ast-grep JSON match row (legacy {path,line,col} or 0.45 {file,range}) to a SearchHit. */
function rowToHit(ws: string, root: string, row: Record<string, unknown>): SearchHit {
  const file = String(row.file ?? row.path ?? '')
  const range = (row.range ?? {}) as { start?: { line?: number; column?: number } }
  const line = Number(row.line ?? range.start?.line ?? 0) + 1
  const col = Number(row.col ?? range.start?.column ?? 0) + 1
  const text = String(row.text ?? '')
  return {
    file: file ? posix(path.relative(ws, path.resolve(root, file))) : '',
    line,
    column: col,
    matched: text,
    snippet: String(row.lines ?? text).slice(0, 600),
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globEscapeToRe(pattern: string): string {
  let re = ''
  for (const ch of pattern) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += escapeRe(ch)
  }
  return re
}

function shellQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`
}
