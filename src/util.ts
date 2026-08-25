/**
 * Shared filesystem + workspace utilities for the dsh-oh-my-agent host half.
 *
 * Everything an agent-facing tool touches lives under the resolved session
 * workspace (`.omo/` state dir). Raw `node:fs` is fine here — host plugins run
 * in the real DSH process (same as dsh-ssh).
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

/** Name of the on-disk state directory (mirrors OmO's `.omo` semantics). */
export const OMO_DIR = '.omo'
export const PLUGIN_ID = '@dsh-external/dsh-oh-my-agent'

/** A tool-facing text content block (minimal ContentBlock surface). */
export type TextBlock = { type: 'text'; text: string }

/** Render helper mirroring what the ssh plugin does locally. */
export function text(str: string): TextBlock[] {
  return [{ type: 'text', text: str }]
}

/** POSIX-normalize a path for display / glob matching. */
export function posix(p: string): string {
  return p.split(path.sep).join('/')
}

/** Resolve the workspace root for a tool run, preferring the executing agent's session cwd. */
export function resolveWorkspace(cwd?: string): string {
  const raw = cwd && cwd.trim() ? cwd : process.env.OMO_WS || process.cwd()
  try {
    return path.resolve(raw)
  } catch {
    return path.resolve(os.homedir())
  }
}

export function omoDir(ws: string, ...parts: string[]): string {
  return path.join(ws, OMO_DIR, ...parts)
}

/** Ensure a directory exists (recursive). */
export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/** Idempotent state file write (mkdir + atomic-ish rename). */
export function writeState(file: string, data: string): void {
  ensureDir(path.dirname(file))
  const tmp = file + '.tmp' + process.pid
  fs.writeFileSync(tmp, data, 'utf8')
  fs.renameSync(tmp, file)
}

/** Read a JSON state file; returns null when missing or corrupt. */
export function readJson<T>(file: string): T | null {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export function writeJson(file: string, value: unknown): void {
  writeState(file, JSON.stringify(value, null, 2) + '\n')
}

/** True when `target` is strictly inside `root` (path-containment). */
export function isWithin(root: string, target: string): boolean {
  const r = path.resolve(root)
  const t = path.resolve(target)
  if (t === r) return true
  return t.startsWith(r + path.sep)
}

/** SHA-256 hex (short) of a string — used for file-level integrity where needed. */
export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

/** Directory → relative (posix) file list, skipping heavy/generated dirs. */
const SKIP_DIR = new Set([
  'node_modules', '.git', '.hg', '.svn', '.omo', '.next', 'dist', 'build',
  '.cache', '.parcel-cache', '.turbo', 'coverage', '.docusaurus', 'target',
  '.venv', 'venv', '.tox', '__pycache__', '.webpack', '.vite',
])

export function walkFiles(dir: string, maxDepth = 12): string[] {
  const out: string[] = []
  const root = path.resolve(dir)
  const walk = (d: string, depth: number): void => {
    if (depth > maxDepth || !fs.existsSync(d)) return
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name)) continue
        walk(full, depth + 1)
      } else if (e.isFile()) {
        out.push(full)
      }
    }
  }
  walk(root, 0)
  return out
}

/** File extension set considered "code-ish" for marker scans. */
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java',
  '.kt', '.kts', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php',
  '.swift', '.m', '.sh', '.bash', '.zsh', '.fish', '.sql', '.vue', '.svelte',
  '.html', '.css', '.scss', '.less', '.json', '.yml', '.yaml', '.toml', '.md',
  '.mdx', '.txt', '.astro', '.zig', '.dart', '.ex', '.exs', '.lua', '.r',
])

export const isCodeFile = (p: string): boolean => CODE_EXT.has(path.extname(p).toLowerCase())

/** Format a timestamp as a compact local ISO-ish string for logs/notes. */
export function nowTs(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

/** Recursively drop properties whose value is `undefined` so tool results stay
 * lossless-JSON. The harness output validator rejects explicit-undefined keys
 * even though JSON.stringify (disk writes) silently drops them — that mismatch
 * made omo_note append report failure after the note was already saved. */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripUndefined(v)) as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue
      out[k] = stripUndefined(v)
    }
    return out as T
  }
  return value
}

export { fsp, fs, path }
