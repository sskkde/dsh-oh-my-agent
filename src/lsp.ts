/**
 * omo_lsp — embedded language-server toolset for dsh-oh-my-agent.
 *
 * Uses `vscode-jsonrpc` (stream connection) + `vscode-languageserver-protocol`
 * (MIT) to talk to real LSP servers over stdio — no MCP, no host binding.
 *
 * Server resolution is per file language; known binaries are probed on PATH
 * (plus the plugin's own node_modules for typescript-language-server, the
 * standard TS LSP front-end that proxies tsserver). If no server is available
 * for a language, the tool answers honestly with `available: false`.
 *
 * Tool surface (mirrors OmO's lsp-core): status / diagnostics / definition /
 * references / rename / symbols. Sessions spawn lazily per <ws>::<lang> and
 * are reaped on idle (default 10 min); plugin stop disposes everything.
 */

import path from 'node:path'
import fs from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/lib/node/main.js'
import * as ls from 'vscode-languageserver-protocol'
import { isWithin, posix, writeState, nowTs } from './util.js'
import { whichSync } from './cmd.js'

// ─────────────────────────── server resolution ───────────────────────────

interface ServerSpec {
  exts: string[]
  bin: string
  args: string[]
  probe?: string
}

/** Known LSP servers by language (first candidate whose binary resolves wins). */
const SERVER_SPECS: ServerSpec[] = [
  { exts: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'], bin: 'typescript-language-server', args: ['--stdio'] },
  { exts: ['py'], bin: 'pyright-langserver', args: ['--stdio'] },
  { exts: ['py'], bin: 'pylsp', args: [''] },
  { exts: ['go'], bin: 'gopls', args: ['serve'] },
  { exts: ['rs'], bin: 'rust-analyzer', args: [] },
  { exts: ['c', 'h'], bin: 'clangd', args: ['--background-index'] },
  { exts: ['cpp', 'hpp', 'cc', 'cxx'], bin: 'clangd', args: ['--background-index'] },
]

const EXT_TO_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', mts: 'mts', cts: 'cts', js: 'javascript', jsx: 'jsx',
  mjs: 'javascript', cjs: 'javascript', py: 'python', go: 'go', rs: 'rust',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
}

export function langForFile(file: string): string | null {
  const ext = path.extname(file).toLowerCase().replace(/^\./, '')
  return EXT_TO_LANG[ext] ?? null
}

/** Resolve an actual server binary: plugin-local .bin first, then PATH. */
function resolveServerBinary(bin: string): string | null {
  // plugin's own node_modules/.bin (typescript-language-server ships here)
  const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', bin)
  if (process.platform === 'win32') {
    if (fs.existsSync(here + '.cmd')) return here + '.cmd'
    if (fs.existsSync(here + '.exe')) return here + '.exe'
  }
  if (fs.existsSync(here)) return here
  return whichSync(bin)
}

export interface ServerInfo {
  lang: string
  binary: string | null
  candidate: string
  available: boolean
  note: string
}

/** All languages we can attempt, with availability. */
export function serverAvailability(): ServerInfo[] {
  const seen = new Map<string, ServerInfo>()
  for (const spec of SERVER_SPECS) {
    for (const lang of spec.exts) {
      if (seen.has(lang)) continue
      const bin = resolveServerBinary(spec.bin)
      seen.set(lang, {
        lang,
        binary: bin,
        candidate: spec.bin + ' ' + spec.args.join(' ').trim(),
        available: bin !== null,
        note: bin ? '' : spec.bin + ' not found on PATH / plugin deps',
      })
    }
  }
  return [...seen.values()]
}

export function resolveServer(lang: string): { spec: ServerSpec; bin: string } | null {
  for (const spec of SERVER_SPECS) {
    if (!spec.exts.includes(lang)) continue
    const bin = resolveServerBinary(spec.bin)
    if (bin) return { spec, bin }
  }
  return null
}

// ─────────────────────────── LSP client ───────────────────────────

export interface LspMarker {
  file: string
  line: number
  column: number
  endLine: number
  endColumn: number
  severity: string
  code: unknown
  source: string
  message: string
}

export interface LspLoc {
  file: string
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

const SEVERITY = ['Error', 'Warning', 'Info', 'Hint'] as const

function isLoc(v: unknown): v is { uri?: string; range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } } } {
  return typeof v === 'object' && v !== null && 'range' in v
}

function toLoc(ws: string, loc: unknown): LspLoc | null {
  if (!isLoc(loc)) return null
  const range = loc.range ?? {}
  const s = range.start ?? {}
  const e = range.end ?? {}
  return {
    file: posix(path.relative(ws, uriToPath(ws, loc.uri ?? ''))),
    startLine: ((s.line ?? 0) as number) + 1,
    startColumn: ((s.character ?? 0) as number) + 1,
    endLine: ((e.line ?? 0) as number) + 1,
    endColumn: ((e.character ?? 0) as number) + 1,
  }
}

function uriToPath(_ws: string, uri: string): string {
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ''))
  } catch {
    return uri
  }
}

function pathToUri(p: string): string {
  return 'file://' + encodeURI(p)
}

class LspClient {
  readonly lang: string
  readonly key: string
  private child: ChildProcessWithoutNullStreams | null = null
  private conn: ReturnType<typeof createMessageConnection> | null = null
  private published = new Map<string, LspMarker[]>()
  private stderrBuf: string[] = []
  startedAt = ''
  error: string | null = null
  docsOpened = 0
  lastUsed = 0

  get alive(): boolean {
    return this.child !== null && this.conn !== null && this.error === null
  }

  constructor(readonly ws: string, lang: string, readonly bin: string, args: string[]) {
    this.lang = lang
    this.key = ws + '::' + lang
    try {
      this.child = spawn(bin, args, { cwd: ws, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
      this.startedAt = nowTs()
      const reader = this.child ? new StreamMessageReader(this.child.stdout) : null
      const writer = this.child ? new StreamMessageWriter(this.child.stdin) : null
      if (!reader || !writer) throw new Error('failed to open LSP stream')
      this.conn = createMessageConnection(reader, writer, console)
      this.conn.onNotification((ls.PublishDiagnosticsNotification.type as any), (params: unknown) => {
        const uri = String((params as { uri?: string }).uri ?? '')
        const diags = ((params as { diagnostics?: unknown[] }).diagnostics ?? []) as Array<{
          range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }
          severity?: number
          code?: unknown
          source?: string
          message?: string
        }>
        this.published.set(uri, diags.map((d) => ({
          file: posix(path.relative(this.ws, uriToPath(this.ws, uri))),
          line: ((d.range?.start?.line ?? 0) as number) + 1,
          column: ((d.range?.start?.character ?? 0) as number) + 1,
          endLine: ((d.range?.end?.line ?? 0) as number) + 1,
          endColumn: ((d.range?.end?.character ?? 0) as number) + 1,
          severity: d.severity !== undefined ? SEVERITY[d.severity] ?? 'Info' : 'Info',
          code: d.code,
          source: String(d.source ?? ''),
          message: String(d.message ?? ''),
        })))
      })
      this.conn.listen()
      void this.init()
    } catch (e) {
      this.error = String(e)
    }
    if (this.child) {
      this.child.stderr.on('data', (d) => { this.stderrBuf.push(d.toString()); if (this.stderrBuf.length > 40) this.stderrBuf.shift() })
      this.child.on('error', (e) => { this.error = String(e) })
      this.child.on('exit', () => { this.conn?.dispose(); this.conn = null })
    }
  }

  private async init(): Promise<void> {
    try {
      await this.conn?.sendRequest((ls.InitializeRequest.type as any), {
        processId: process.pid,
        rootUri: pathToUri(this.ws),
        rootPath: this.ws,
        workspaceFolders: [{ uri: pathToUri(this.ws), name: path.basename(this.ws) }],
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true },
          },
          workspace: { workspaceEdit: { documentChanges: false } },
        },
      })
      await this.conn?.sendNotification((ls.InitializedNotification.type as any), {})
    } catch (e) {
      this.error = 'initialize failed: ' + String(e)
    }
  }

  private async open(uri: string, text: string): Promise<void> {
    if (!this.conn) return
    try {
      await this.conn.sendNotification((ls.DidOpenTextDocumentNotification.type as any), {
        textDocument: { uri, languageId: this.lang === 'tsx' || this.lang === 'ts' ? 'typescript' : this.lang, version: 1, text },
      })
      this.docsOpened += 1
    } catch { /* ignore */ }
  }

  private async close(uri: string): Promise<void> {
    if (!this.conn) return
    try {
      await this.conn.sendNotification((ls.DidCloseTextDocumentNotification.type as any), { textDocument: { uri } })
    } catch { /* ignore */ }
  }

  private pos(line: number, character: number): { line: number; character: number } {
    return { line: Math.max(0, line - 1), character: Math.max(0, character - 1) }
  }

  async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('LSP request timed out after ' + ms + 'ms')), ms)
      p.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
    })
  }

  /**
   * Open a file and poll for pushed diagnostics (servers publish asynchronously
   * after the first full program). Returns whatever arrived within `waitMs`.
   */
  async diagnostics(file: string, text: string): Promise<LspMarker[]> {
    const uri = pathToUri(path.resolve(this.ws, file))
    await this.open(uri, text)
    const deadline = Date.now() + 5000
    let markers = this.published.get(uri) ?? []
    while (markers.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200))
      markers = this.published.get(uri) ?? []
    }
    await this.close(uri)
    return markers.slice(0, 100)
  }

  async definition(file: string, text: string, line: number, character: number): Promise<LspLoc[]> {
    const uri = pathToUri(path.resolve(this.ws, file))
    await this.open(uri, text)
    try {
      const res = await this.withTimeout(
        this.conn?.sendRequest(ls.DefinitionRequest.type as any, {
          textDocument: { uri },
          position: this.pos(line, character),
        }) ?? Promise.resolve(null),
        12000,
      )
      return (Array.isArray(res) ? res : res ? [res] : []).map((l) => toLoc(this.ws, l)).filter((x): x is LspLoc => x !== null)
    } catch (e) {
      return []
    } finally {
      await this.close(uri)
    }
  }

  async references(file: string, text: string, line: number, character: number, includeDeclaration: boolean): Promise<LspLoc[]> {
    const uri = pathToUri(path.resolve(this.ws, file))
    await this.open(uri, text)
    try {
      const res = (await this.withTimeout(
        this.conn?.sendRequest(ls.ReferencesRequest.type as any, {
          textDocument: { uri },
          position: this.pos(line, character),
          context: { includeDeclaration },
        }) ?? Promise.resolve([]),
        12000,
      )) as unknown[]
      return (res ?? []).map((l) => toLoc(this.ws, l)).filter((x): x is LspLoc => x !== null)
    } catch (e) {
      return []
    } finally {
      await this.close(uri)
    }
  }

  async symbols(file: string, text: string): Promise<Array<{ name: string; kind: string; startLine: number; endLine: number }>> {
    const uri = pathToUri(path.resolve(this.ws, file))
    await this.open(uri, text)
    try {
      const res = (await this.withTimeout(
        this.conn?.sendRequest(ls.DocumentSymbolRequest.type as any, { textDocument: { uri } }) ?? Promise.resolve([]),
        12000,
      )) as unknown
      const flat: Array<{ name: string; kind: string; startLine: number; endLine: number }> = []
      const walk = (nodes: unknown[], depth: number): void => {
        for (const n of nodes.slice(0, 200)) {
          const o = n as { name?: string; kind?: number; location?: unknown; range?: unknown; children?: unknown[] }
          const range = o.range ?? (o.location as { range?: unknown } | undefined)?.range
          const r = range as { start?: { line?: number }; end?: { line?: number } } | undefined
          flat.push({
            name: String(o.name ?? '?'),
            kind: String(o.kind ?? ''),
            startLine: ((r?.start?.line ?? 0) as number) + 1,
            endLine: ((r?.end?.line ?? 0) as number) + 1,
          })
          if (Array.isArray(o.children)) walk(o.children, depth + 1)
        }
      }
      walk(Array.isArray(res) ? res : [], 0)
      return flat
    } catch (e) {
      return []
    } finally {
      await this.close(uri)
    }
  }

  /** Compute (and optionally apply) a rename via LSP WorkspaceEdit. */
  async rename(file: string, text: string, line: number, character: number, newName: string, apply: boolean): Promise<{
    edits: Array<{ file: string; startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }>
    applied: boolean
  }> {
    const uri = pathToUri(path.resolve(this.ws, file))
    await this.open(uri, text)
    try {
      const res = (await this.withTimeout(
        this.conn?.sendRequest(ls.RenameRequest.type as any, {
          textDocument: { uri },
          position: this.pos(line, character),
          newName,
        }) ?? Promise.resolve({}),
        12000,
      )) as { changes?: Record<string, Array<{ range: { start: Record<string, number>; end: Record<string, number> }; newText: string }>> } | null
      const changes = (res?.changes ?? {}) as Record<string, Array<{ range: { start: Record<string, number>; end: Record<string, number> }; newText: string }>>
      const edits = Object.entries(changes).flatMap(([u, textEdits]) =>
        (textEdits ?? []).flatMap((te) => {
          const loc = toLoc(this.ws, { uri: u, range: te.range })
          if (!loc) return []
          return [{
            file: loc.file, startLine: loc.startLine, startColumn: loc.startColumn,
            endLine: loc.endLine, endColumn: loc.endColumn, newText: te.newText,
          }]
        }),
      )
      if (apply) this.applyEditSet(edits)
      return { edits, applied: apply && edits.length > 0 }
    } catch (e) {
      return { edits: [], applied: false }
    } finally {
      await this.close(uri)
    }
  }

  private applyEditSet(edits: Array<{ file: string; startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }>): void {
    const byFile = new Map<string, typeof edits>()
    for (const ed of edits) {
      const abs = path.resolve(this.ws, ed.file)
      if (!isWithin(this.ws, abs)) continue
      const arr = byFile.get(ed.file) ?? []
      arr.push(ed)
      byFile.set(ed.file, arr)
    }
    for (const [file, list] of byFile) {
      const abs = path.resolve(this.ws, file)
      if (!fs.existsSync(abs)) continue
      let lines = fs.readFileSync(abs, 'utf8').split(/\r\n|\n/)
      const sorted = [...list].sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn)
      for (const ed of sorted) {
        const start = this.offsetOf(lines, ed.startLine, ed.startColumn)
        const end = this.offsetOf(lines, ed.endLine, ed.endColumn)
        const text = lines.join('\n')
        const next = text.slice(0, start) + ed.newText + text.slice(end)
        lines = next.split('\n')
      }
      writeState(abs, lines.join('\n'))
    }
  }

  private offsetOf(lines: string[], line: number, column: number): number {
    const upTo = Math.max(0, line - 1)
    const prefix = lines.slice(0, upTo).join('\n')
    return prefix.length + (upTo > 0 ? 1 : 0) + Math.max(0, column - 1)
  }

  kill(): void {
    try { this.conn?.dispose() } catch { /* ignore */ }
    try { this.child?.kill('SIGKILL') } catch { /* ignore */ }
    this.conn = null
  }

  status(): { lang: string; startedAt: string; docsOpened: number; error: string | null; stderrTail: string } {
    return {
      lang: this.lang,
      startedAt: this.startedAt,
      docsOpened: this.docsOpened,
      error: this.error,
      stderrTail: this.stderrBuf.slice(-3).join('').slice(0, 300),
    }
  }
}

// ─────────────────────────── manager ───────────────────────────

const IDLE_MS = 10 * 60 * 1000

export interface LspToolResult {
  ok: boolean
  available: boolean
  lang: string | null
  action: string
  note: string
  server?: string
  markers?: LspMarker[]
  locations?: LspLoc[]
  symbols?: Array<{ name: string; kind: string; startLine: number; endLine: number }>
  edits?: Array<{ file: string; startLine: number; startColumn: number; endLine: number; endColumn: number; newText: string }>
  applied?: boolean
  servers?: ServerInfo[]
  sessions?: unknown[]
}

export class LspServerManager {
  private clients = new Map<string, LspClient>()

  /** Return the client for a file, or null when the language has no server. */
  clientFor(ws: string, file: string): { client: LspClient | null; lang: string | null; reason: string } {
    const lang = langForFile(file)
    if (!lang) return { client: null, lang: null, reason: 'unsupported extension' }
    const res = resolveServer(lang)
    if (!res) return { client: null, lang, reason: 'no LSP server available for ' + lang }
    const key = ws + '::' + lang
    this.reap(key)
    let client = this.clients.get(key)
    if (!client || !client.alive) {
      client = new LspClient(ws, lang, res.bin, res.spec.args)
      this.clients.set(key, client)
    }
    client.lastUsed = Date.now()
    return { client, lang, reason: '' }
  }

  private reap(reuseKey: string): void {
    const now = Date.now()
    for (const [key, c] of this.clients) {
      if (key === reuseKey) continue
      if (now - c.lastUsed > IDLE_MS) {
        c.kill()
        this.clients.delete(key)
      }
    }
  }

  sessions(): unknown[] {
    return [...this.clients.values()].map((c) => c.status())
  }

  disposeAll(): void {
    for (const c of this.clients.values()) c.kill()
    this.clients.clear()
  }
}
