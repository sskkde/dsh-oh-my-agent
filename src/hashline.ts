/**
 * Hashline editor — deterministic surgical edits.
 *
 * Port of oh-my-openagent's hashline edit_format: instead of ambiguous
 * string-replacement, every edit is addressed as
 *
 *   <lineno>#<2char-checksum> | <op> | <content>
 *
 * and the checksum (xxhash32 of the current line content, 2 symbols from the
 * 16-symbol alphabet) verifies the file is in the state the caller expects.
 * A stale/mismatched hash is refused instead of silently corrupting the file.
 *
 * Ops: replace (swap line content), append (insert after line), prepend
 * (insert before line), delete (remove the line). Multi-line content is
 * supported via embedded newlines.
 */

import fs from 'node:fs'
import path from 'node:path'
import { isWithin, posix, sha256, writeState, ensureDir } from './util.js'
import { hashlineChecksum } from './xxhash32.js'

export type HashOp = 'replace' | 'append' | 'prepend' | 'delete'

export interface HashEdit {
  line: number
  hash?: string
  op: HashOp
  content?: string
}

export interface HashResult {
  line: number
  op: HashOp
  ok: boolean
  reason?: string
  newHash?: string
  appliedLine?: number
}

export interface HashlineOutcome {
  ok: boolean
  file: string
  fileHash: string
  applied: HashResult[]
  conflicted: HashResult[]
  newline?: string
}

/** Read file lines, preserving an optional trailing newline convention. */
function readLines(file: string): { lines: string[]; lf: boolean; crlf: boolean; trailing: boolean } {
  const raw = fs.readFileSync(file, 'utf8')
  const crlf = raw.includes('\r\n')
  // Strip a single trailing newline before splitting so `line` count maps to text lines.
  let body = raw
  let trailing = false
  if (body.endsWith('\r\n')) { trailing = true; body = body.slice(0, -2) }
  else if (body.endsWith('\n')) { trailing = true; body = body.slice(0, -1) }
  const lines = body.split(/\r\n|\n/)
  return { lines, lf: !crlf, crlf, trailing }
}

/** Restore a trailing newline when the original file had one. */
function withTrailingNewline(text: string, crlf: boolean, trailing: boolean): string {
  if (!trailing || text === '') return text
  return text.endsWith('\n') ? text : text + (crlf ? '\r\n' : '\n')
}

function joinLines(lines: string[], crlf: boolean): string {
  return lines.join(crlf ? '\r\n' : '\n')
}

/** Apply hashline edits to `file` (must be inside `ws`). */
export function applyHashlineEdits(
  ws: string,
  file: string,
  edits: HashEdit[],
): HashlineOutcome {
  const abs = path.resolve(ws, file)
  if (!isWithin(ws, abs)) {
    return {
      ok: false,
      file,
      fileHash: '',
      applied: [],
      conflicted: [
        { line: 0, op: 'replace', ok: false, reason: 'file escapes workspace: ' + file },
      ],
    }
  }
  if (!fs.existsSync(abs)) {
    return {
      ok: false,
      file,
      fileHash: '',
      applied: [],
      conflicted: [
        { line: 0, op: 'replace', ok: false, reason: 'file does not exist: ' + file },
      ],
    }
  }

  const { lines, crlf, trailing } = readLines(abs)
  const applied: HashResult[] = []
  const conflicted: HashResult[] = []
  const originalHash = sha256(joinLines(lines, crlf))
  // Normalize the raw content lines to compare — keep original line objects
  // and add/delete by operating on a copy.
  const work = [...lines]

  for (const edit of edits) {
    const e = { ...edit }
    // resolve negative line (tail-relative): -1 = last line
    const target =
      e.line < 0 ? work.length + e.line + 1 : e.line
    const clamp = Math.max(1, Math.min(target, work.length || 1))
    const fail = (reason: string): void => {
      conflicted.push({ line: e.line, op: e.op, ok: false, reason })
    }

    if (e.op === 'append' && target === work.length + 1) {
      // append at EOF: no neighbor to verify; just push
      const added = e.content ?? ''
      work.push(added)
      applied.push({ line: e.line, op: e.op, ok: true, newHash: hashlineChecksum(added), appliedLine: work.length })
      continue
    }

    if (target < 1 || target > work.length + 1) {
      fail(`line ${e.line} out of range (file has ${work.length} lines)`)
      continue
    }

    const idx = target - 1
    // Verify checksum when the caller supplied one (hash of the CURRENT line, or for
    // append/prepend the line they're anchoring on).
    if (e.hash && e.hash.trim()) {
      const cur = work[idx] ?? ''
      if (hashlineChecksum(cur) !== e.hash.trim()) {
        fail(`stale hash on line ${target}: file has "${hashlineChecksum(cur)}", edit wanted "${e.hash.trim()}"`)
        continue
      }
    }

    const content = e.content ?? ''
    let newHash = hashlineChecksum(content.split(/\r\n|\n/)[0] ?? '')
    switch (e.op) {
      case 'replace':
        work[idx] = content
        newHash = hashlineChecksum(content)
        applied.push({ line: e.line, op: e.op, ok: true, newHash, appliedLine: target })
        break
      case 'append': {
        const insertAt = idx + 1
        work.splice(insertAt, 0, content)
        newHash = hashlineChecksum(content.split(/\r\n|\n/)[0] ?? '')
        applied.push({ line: e.line, op: e.op, ok: true, newHash, appliedLine: insertAt + 1 })
        break
      }
      case 'prepend': {
        work.splice(idx, 0, content)
        newHash = hashlineChecksum(content.split(/\r\n|\n/)[0] ?? '')
        applied.push({ line: e.line, op: e.op, ok: true, newHash, appliedLine: idx + 1 })
        break
      }
      case 'delete': {
        if (idx < work.length) {
          work.splice(idx, 1)
          newHash = ''
          applied.push({ line: e.line, op: e.op, ok: true, newHash: '', appliedLine: target })
        } else {
          fail(`no line to delete at ${target}`)
        }
        break
      }
    }
  }

  if (conflicted.length === 0) {
    const out = withTrailingNewline(joinLines(work, crlf), crlf, trailing)
    ensureDir(path.dirname(abs))
    writeState(abs, out)
  }

  return {
    ok: conflicted.length === 0,
    file: posix(path.relative(ws, abs)),
    fileHash: conflicted.length === 0 ? sha256(withTrailingNewline(joinLines(work, crlf), crlf, trailing)) : originalHash,
    applied,
    conflicted,
  }
}

/** Report the line/checksum map of a file (for callers to compute anchored edits). */
export function describeLines(ws: string, file: string, maxLines = 200): {
  file: string
  lines: Array<{ line: number; hash: string; text: string }>
} {
  const abs = path.resolve(ws, file)
  if (!fs.existsSync(abs)) return { file, lines: [] }
  const { lines, crlf: _crlf } = readLines(abs)
  return {
    file: posix(path.relative(ws, abs)),
    lines: lines.slice(0, maxLines).map((t, i) => ({ line: i + 1, hash: hashlineChecksum(t), text: t })),
  }
}
