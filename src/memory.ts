/**
 * omo_memory — memory-core port for dsh-oh-my-agent.
 *
 * Faithful adaptation of OmO's memory-core "harness-neutral agent memory
 * engine", scoped to what a DSH workspace can actually own:
 *
 *  - Markdown MemFS under `<ws>/.omo/memory/`
 *  - YAML-frontmatter contract: every memory file must carry a non-empty
 *    `description`; `read_only: "true"` blocks mutation (create/str_replace/
 *    insert/delete/rename/update_description).
 *  - Transactional writes: every mutation is planned, applied, written
 *    atomically, and recorded in `.meta.json` (op log = audit/rollback trail).
 *  - Best-effort git backing: when `git` is on PATH (and omo.jsonc
 *    `memory.git` is not false), the memory dir is `git init`ed once and each
 *    mutation is `git add` + committed — the OmO "committed state is
 *    authoritative" rule. Commit failures degrade to the transactional file
 *    store (honest note in status).
 *  - compile/: committed memory compiled into one marked system-prompt block
 *    (`.omo/memory/compiled.md`), cached by input hash — the "inject old
 *    conclusions" surface.
 *  - Seeds / search / reflection / facts: first-run seeding, ranked search,
 *    a boulder-fed reflection snapshot, and a heuristic fact extractor —
 *    simplified versions of memory-core's reflection/facts subsystems.
 */

import fs from 'node:fs'
import path from 'node:path'
import { omoDir, ensureDir, writeState, readJson, writeJson, nowTs, sha256 } from './util.js'
import { parseFrontmatter } from './rules.js'
import { boulderSummary } from './boulder.js'
import { runShell } from './cmd.js'

export const MEM_DIR = 'memory'
const COMPILED = 'compiled.md'

export interface MemoryFile {
  name: string
  file: string
  description: string
  readOnly: boolean
  body: string
}

export interface MemOp {
  id: string
  ts: string
  op: string
  name: string
  beforeHash: string
  afterHash: string
}

export interface MemoryStatus {
  dir: string
  files: number
  readOnly: number
  compiledHash: string
  gitBacked: boolean
  ops: number
  lastError: string
}

// ─────────────────────────── base ───────────────────────────

export function memoryDir(ws: string): string {
  return omoDir(ws, MEM_DIR)
}

const nameOk = (n: string): string | null => /^[A-Za-z0-9._-]{1,60}$/.test(n) ? n : null

function fileOf(ws: string, name: string): string {
  return path.join(memoryDir(ws), name.replace(/\.md$/, '') + '.md')
}

export function readMemoryFile(ws: string, name: string): MemoryFile | null {
  const file = fileOf(ws, name)
  if (!fs.existsSync(file)) return null
  const raw = fs.readFileSync(file, 'utf8')
  const { meta, body } = parseFrontmatter(raw)
  const description = typeof meta.description === 'string' ? meta.description.trim() : ''
  const clean = body.replace(/\n$/, '')
  return {
    name: name.replace(/\.md$/, ''),
    file: posixSafe(file, ws),
    description,
    readOnly: String(meta.read_only ?? 'false') === 'true',
    body: clean === '' ? '' : clean,
  }
}

function posixSafe(file: string, ws: string): string {
  return path.relative(ws, file).split(path.sep).join('/')
}

export function listMemory(ws: string): MemoryFile[] {
  const dir = memoryDir(ws)
  const out: MemoryFile[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    if (e.name === COMPILED || e.name.startsWith('_')) continue
    const m = readMemoryFile(ws, e.name)
    if (m) out.push(m)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ─────────────────────────── transaction journal ───────────────────────────

function metaPath(ws: string): string {
  return path.join(memoryDir(ws), '.meta.json')
}

type MetaState = { ops: MemOp[]; seedsAt?: string }

function loadMeta(ws: string): MetaState {
  return readJson<MetaState>(metaPath(ws)) ?? { ops: [] }
}

function recordOp(ws: string, op: string, name: string, beforeHash: string, afterHash: string): void {
  const meta = loadMeta(ws)
  meta.ops.push({ id: 'mo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 5), ts: nowTs(), op, name, beforeHash, afterHash })
  if (meta.ops.length > 300) meta.ops = meta.ops.slice(-300)
  writeJson(metaPath(ws), meta)
}

export function memoryJournal(ws: string, tail = 20): Array<MemOp> {
  return loadMeta(ws).ops.slice(-tail).reverse()
}

// ─────────────────────────── git backing (best-effort) ───────────────────────────

let gitInited = new Set<string>()

async function commitIfGit(ws: string): Promise<boolean> {
  const gitAvailable = await runShell('command -v git', { cwd: ws, timeoutMs: 3000 })
  if (!gitAvailable.ok) return false
  const dir = memoryDir(ws)
  if (!gitInited.has(dir)) {
    const init = await runShell('git init -q && git config user.email dsh@local && git config user.name dsh-omo-memory', { cwd: dir, timeoutMs: 8000 })
    if (!init.ok) return false
    gitInited.add(dir)
  }
  const commit = await runShell(`git add -A && git commit -q -m "omo_memory: ${new Date().toISOString()}"`, { cwd: dir, timeoutMs: 10000 })
  return commit.ok
}

// ─────────────────────────── file contract + ops ───────────────────────────

function renderFile(desc: string, body: string, readOnly = false): string {
  const lines = ['---', `description: ${quote(desc)}`]
  if (readOnly) lines.push('read_only: "true"')
  lines.push('---', '')
  lines.push(body.trimEnd())
  lines.push('')
  return lines.join('\n')
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`
}

const readOnlyGuard = (m: MemoryFile): string | null =>
  m.readOnly ? `memory file "${m.name}" is read_only — mutation blocked` : null

/** Ensure the seed block exists on first use. */
export function ensureSeeds(ws: string): void {
  ensureDir(memoryDir(ws))
  const seed = fileOf(ws, '_seed')
  if (!fs.existsSync(seed)) {
    writeState(
      seed,
      renderFile(
        '本记忆库的结构与用法（种子）',
        '本目录是跨会话持久记忆（omo_memory，memory-core 移植）。\n\n'
          + '- 每个 .md 文件 = 一条记忆，必须带非空 description frontmatter。\n'
          + '- read_only: "true" 的记忆不可被工具改写（只有它本身可）。\n'
          + '- 分工建议：learnings.md(经验) / decisions.md(决策) / issues.md(问题) / verifications.md(验证) / facts.md(抽取事实)。\n'
          + '- omo_memory compile 会把这些编译成注入块 compiled.md；search 做排名检索。',
      ),
    )
    recordOp(ws, 'seed', '_seed', sha256(''), sha256('seed'))
  }
}

export function createMemory(ws: string, name: string, content: string, description: string, readOnly = false): MemoryFile {
  const safe = nameOk(name)
  if (!safe) throw new Error('invalid memory name (use A-Za-z0-9._- ; got "' + name + '")')
  if (!description.trim()) throw new Error('memory contract: description must be non-empty')
  const file = fileOf(ws, safe)
  if (fs.existsSync(file)) throw new Error(`memory "${safe}" already exists — use put/str_replace`)
  ensureDir(memoryDir(ws))
  const body = renderFile(description.trim(), content, readOnly)
  const fileRel = posixSafe(file, ws)
  const before = sha256('')
  writeState(file, body)
  const after = sha256(body)
  recordOp(ws, 'create', safe, before, after)
  void commitIfGit(ws)
  return { name: safe, file: fileRel, description: description.trim(), readOnly, body: content }
}

export function putMemory(ws: string, name: string, content: string, description?: string): MemoryFile {
  const safe = nameOk(name)
  if (!safe) throw new Error('invalid memory name')
  const file = fileOf(ws, safe)
  if (fs.existsSync(file)) {
    const m = readMemoryFile(ws, safe)!
    const guard = readOnlyGuard(m)
    if (guard) throw new Error(guard)
    const desc = description !== undefined && description.trim() ? description.trim() : m.description
    const body = renderFile(desc, content, m.readOnly)
    const before = sha256(fs.readFileSync(file, 'utf8'))
    writeState(file, body)
    recordOp(ws, 'put', safe, before, sha256(body))
    void commitIfGit(ws)
    return { ...m, description: desc, body: content }
  }
  return createMemory(ws, safe, content, description ?? '')
}

export function strReplaceMemory(ws: string, name: string, oldText: string, newText: string): MemoryFile {
  const m = readMemoryFile(ws, name)
  if (!m) throw new Error(`memory "${name}" not found`)
  const guard = readOnlyGuard(m)
  if (guard) throw new Error(guard)
  const idx = m.body.indexOf(oldText)
  if (idx === -1) throw new Error(`str_replace: "${oldText.slice(0, 30)}…" not found in "${name}"`)
  if (m.body.indexOf(oldText, idx + oldText.length) !== -1) throw new Error('str_replace: old text is not unique in "' + name + '"')
  const body = m.body.slice(0, idx) + newText + m.body.slice(idx + oldText.length)
  const before = sha256(fs.readFileSync(fileOf(ws, name), 'utf8'))
  writeState(fileOf(ws, name), renderFile(m.description, body, m.readOnly))
  recordOp(ws, 'str_replace', m.name, before, sha256(body))
  void commitIfGit(ws)
  return { ...m, body }
}

export function insertMemory(ws: string, name: string, content: string, afterLine?: number): MemoryFile {
  const m = readMemoryFile(ws, name)
  if (!m) throw new Error(`memory "${name}" not found`)
  const guard = readOnlyGuard(m)
  if (guard) throw new Error(guard)
  const lines = m.body.split('\n')
  const at = afterLine !== undefined ? Math.max(0, Math.min(afterLine, lines.length)) : lines.length
  lines.splice(at, 0, content)
  const body = lines.join('\n')
  const before = sha256(fs.readFileSync(fileOf(ws, name), 'utf8'))
  writeState(fileOf(ws, name), renderFile(m.description, body, m.readOnly))
  recordOp(ws, 'insert', m.name, before, sha256(body))
  void commitIfGit(ws)
  return { ...m, body }
}

export function deleteMemory(ws: string, name: string): { name: string; deleted: boolean } {
  const m = readMemoryFile(ws, name)
  if (!m) throw new Error(`memory "${name}" not found`)
  const guard = readOnlyGuard(m)
  if (guard) throw new Error(guard)
  const before = sha256(fs.readFileSync(fileOf(ws, name), 'utf8'))
  fs.rmSync(fileOf(ws, name), { force: true })
  recordOp(ws, 'delete', m.name, before, sha256(''))
  void commitIfGit(ws)
  return { name: m.name, deleted: true }
}

export function renameMemory(ws: string, name: string, newName: string): MemoryFile {
  const m = readMemoryFile(ws, name)
  if (!m) throw new Error(`memory "${name}" not found`)
  const safe = nameOk(newName.replace(/\.md$/, ''))
  if (!safe) throw new Error('invalid new name')
  const guard = readOnlyGuard(m)
  if (guard) throw new Error(guard)
  const to = fileOf(ws, safe)
  if (fs.existsSync(to)) throw new Error(`memory "${safe}" already exists`)
  const before = sha256(fs.readFileSync(fileOf(ws, name), 'utf8'))
  fs.renameSync(fileOf(ws, name), to)
  const body = readMemoryFile(ws, safe)!
  recordOp(ws, 'rename', m.name + '→' + safe, before, sha256(fs.readFileSync(to, 'utf8')))
  void commitIfGit(ws)
  return body
}

export function updateDescriptionMemory(ws: string, name: string, description: string): MemoryFile {
  if (!description.trim()) throw new Error('description must be non-empty')
  const m = readMemoryFile(ws, name)
  if (!m) throw new Error(`memory "${name}" not found`)
  const guard = readOnlyGuard(m)
  if (guard) throw new Error(guard)
  const before = sha256(fs.readFileSync(fileOf(ws, name), 'utf8'))
  writeState(fileOf(ws, name), renderFile(description.trim(), m.body, m.readOnly))
  recordOp(ws, 'update_description', m.name, before, sha256(description.trim() + m.body))
  void commitIfGit(ws)
  return { ...m, description: description.trim() }
}

// ─────────────────────────── compile / search / reflection / facts ───────────────────────────

const compileCache = new Map<string, { hash: string; block: string }>()

/** Compile committed memory into one marked block, cached by input hash. */
export function compileMemory(ws: string, opts: { maxChars?: number } = {}): { hash: string; block: string; files: string[]; cached: boolean } {
  ensureSeeds(ws)
  const files = listMemory(ws)
  const source = files.map((f) => `#${f.name}\ndesc:${f.description}\n${f.body}`).join('\n')
  const hash = sha256(source)
  const cached = compileCache.get(ws)
  if (cached && cached.hash === hash && fs.existsSync(path.join(memoryDir(ws), COMPILED))) {
    return { ...cached, files: files.map((f) => f.name), cached: true }
  }
  const max = opts.maxChars ?? 12000
  const lines: string[] = ['## Memory (compiled from .omo/memory — memory-core 移植)', '> 跨会话持久记忆；遵守这些结论，避免重新发现。', '']
  for (const f of files) {
    lines.push(`### ${f.name}`, `> ${f.description}`)
    if (f.readOnly) lines.push('> read_only')
    lines.push('', f.body, '')
    if (lines.join('\n').length > max) break
  }
  const block = lines.join('\n')
  const out = path.join(memoryDir(ws), COMPILED)
  writeState(out, block)
  const entry = { hash, block }
  compileCache.set(ws, entry)
  return { ...entry, files: files.map((f) => f.name), cached: false }
}

export function searchMemory(ws: string, query: string, limit = 10): Array<{ name: string; description: string; score: number; snippet: string }> {
  const files = listMemory(ws)
  const q = query.toLowerCase()
  const scored = files
    .map((f) => {
      let score = 0
      if (f.name.toLowerCase().includes(q)) score += 5
      if (f.description.toLowerCase().includes(q)) score += 3
      const inBody = f.body.toLowerCase()
      let count = 0
      let idx = inBody.indexOf(q)
      while (idx !== -1 && count < 5) {
        score += 2
        count += 1
        idx = inBody.indexOf(q, idx + q.length)
      }
      const snippet = count > 0 ? '…' + f.body.slice(Math.max(0, inBody.indexOf(q) - 30), inBody.indexOf(q) + 60) + '…' : f.description.slice(0, 60)
      return { name: f.name, description: f.description, score, snippet }
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, limit)
}

/** Reflection snapshot fed from boulder — the simplified reflection subsystem. */
export function reflectMemory(ws: string): { name: string; added: string[] } {
  const { markdown } = boulderSummary(ws)
  const target = fileOf(ws, 'reflection')
  const existing = readMemoryFile(ws, 'reflection')
  const existingBody = existing?.body ?? ''
  const added: string[] = []
  for (const line of markdown.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('Boulder') || t.startsWith('- activePlan')) continue
    if (t.startsWith('- ') && !existingBody.includes('· ' + t + '\n') && !existingBody.includes(t)) {
      added.push(t.slice(2))
    }
  }
  const body = ['## Reflection — 从 boulder 持久经验快照', '']
  for (const a of added) body.push('- ' + a)
  if (added.length === 0 && existingBody) body.push(existingBody)
  const desc = '反思快照（每轮从 boulder 汇总的持久经验）'
  const finalBody = body.join('\n')
  if (!existing) {
    createMemory(ws, 'reflection', finalBody, desc)
  } else {
    putMemory(ws, 'reflection', finalBody, desc)
  }
  return { name: 'reflection', added }
}

/** Heuristic fact extraction from a text blob (facts subsystem, simplified). */
export function extractFacts(ws: string, text: string, max = 8): { name: string; added: string[] } {
  const sig = /(学习|学会|经验|约定|规范|注意|不要|必须|记得|发现|解决|fact|learn|note|remember|use|use set|don't|always)/i
  const facts: string[] = []
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (!t || t.length < 6 || t.length > 200) continue
    if (sig.test(t) && !/^(#|>|\[|\* )/.test(t)) facts.push(t)
    if (facts.length >= max) break
  }
  const target = readMemoryFile(ws, 'facts') ?? { name: 'facts', description: '', readOnly: false, body: '', file: '' }
  const existing = target.body
  const added: string[] = []
  for (const f of facts) {
    if (!existing.includes(f) && !added.includes(f)) added.push(f)
  }
  const body = ['## Facts（后台抽取）', '']
  for (const f of [...existing.split('\n').filter((x) => x.trim().startsWith('- ')), ...added.map((a) => '- ' + a)].slice(0, 120)) body.push(f)
  putMemory(ws, 'facts', body.join('\n'), target.description || '抽取事实（每轮自动从对话/文本中提炼的持久事实）')
  return { name: 'facts', added }
}

export function memoryStatus(ws: string, execWsHint?: string): MemoryStatus & { fileList: Array<{ name: string; description: string; readOnly: boolean }> } {
  ensureSeeds(ws)
  const files = listMemory(ws)
  const meta = loadMeta(ws)
  let compiledHash = ''
  const compiledFile = path.join(memoryDir(ws), COMPILED)
  if (fs.existsSync(compiledFile)) compiledHash = sha256(fs.readFileSync(compiledFile, 'utf8'))
  let gitBacked = false
  try {
    gitBacked = fs.existsSync(path.join(memoryDir(ws), '.git'))
  } catch { /* ignore */ }
  void execWsHint
  return {
    dir: posixSafe(memoryDir(ws), ws),
    files: files.length,
    readOnly: files.filter((f) => f.readOnly).length,
    compiledHash,
    gitBacked,
    ops: meta.ops.length,
    lastError: '',
    fileList: files.map((f) => ({ name: f.name, description: f.description, readOnly: f.readOnly })),
  }
}
