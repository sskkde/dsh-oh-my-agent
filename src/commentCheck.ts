/**
 * Comment checker — scans changed/edited files for leftover completion markers,
 * the faithful adaptation of oh-my-openagent's comment-checker hook.
 *
 * Marker words: TODO FIXME XXX HACK BUG UNDONE WIP IMPLEMENT PLACEHOLDER TBD
 * Escapes (same as OmO):
 *   - a line containing `@allow` is not a blocker
 *   - a file containing `comment-checker-disable-file` is skipped entirely
 */

import fs from 'node:fs'
import path from 'node:path'
import { walkFiles, isCodeFile, isWithin, posix } from './util.js'
import { gitChangedFilesSync } from './cmd.js'

const MARKER_RE = /\b(TODO|FIXME|XXX|HACK|BUG|UNDONE|WIP|IMPLEMENT|PLACEHOLDER|TBD|WORKAROUND|BUGFIX)\b/i
const DISABLE_FILE_RE = /comment-checker-disable-file/

export interface MarkerHit {
  file: string
  line: number
  marker: string
  code: string
  escaped: boolean
  reason?: string
}

export interface CommentCheckResult {
  checked: number
  files: string[]
  markers: MarkerHit[]
  blockers: MarkerHit[]
  skippedFiles: string[]
}

export function checkComments(
  ws: string,
  opts: { path?: string; changedOnly?: boolean } = {},
): CommentCheckResult {
  const root = opts.path ? path.resolve(ws, opts.path) : ws
  let isFileTarget = false
  try {
    isFileTarget = opts.path !== undefined && fs.statSync(root).isFile()
  } catch {
    /* ignore */
  }
  const files: string[] = []
  if (isFileTarget) {
    // single-file scan: the target path is a file, not a directory
    if (isWithin(ws, root) && isCodeFile(root)) files.push(root)
  } else if (opts.changedOnly && fs.existsSync(path.join(ws, '.git'))) {
    const changed = gitChangedFilesSync(ws)
    for (const rel of changed) {
      const abs = path.resolve(ws, rel)
      if (isWithin(root, abs) && fs.existsSync(abs) && isCodeFile(abs)) files.push(abs)
    }
  } else {
    for (const f of walkFiles(root, 10)) {
      if (!isWithin(ws, f)) continue
      if (isCodeFile(f)) files.push(f)
      if (files.length >= 400) break
    }
  }
  if (isFileTarget) {
    // single-file result: adjust checked counting below via files.length
  }

  const markers: MarkerHit[] = []
  const skippedFiles: string[] = []
  let checked = 0
  for (const file of files) {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (DISABLE_FILE_RE.test(raw)) {
      skippedFiles.push(posix(path.relative(ws, file)))
      continue
    }
    checked += 1
    const lines = raw.split(/\r\n|\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = MARKER_RE.exec(lines[i])
      if (!m) continue
      const escaped = /@allow\b/.test(lines[i])
      const reason = escaped ? 'has @allow escape' : 'blocking marker'
      markers.push({
        file: posix(path.relative(ws, file)),
        line: i + 1,
        marker: m[1],
        code: lines[i].slice(0, 120),
        escaped,
        reason,
      })
    }
  }
  const blockers = markers.filter((m) => !m.escaped)
  return { checked, files: files.map((f) => posix(path.relative(ws, f))), markers, blockers, skippedFiles }
}
