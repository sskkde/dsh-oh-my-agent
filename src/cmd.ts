/**
 * Minimal child-process helpers for the host tools.
 */

import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface CmdResult {
  code: number | null
  stdout: string
  stderr: string
  ok: boolean
}

export function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL')
        }, opts.timeoutMs)
      : undefined
    const onAbort = (): void => {
      child.kill('SIGTERM')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code: null, stdout: out, stderr: err || String((e as Error)?.message ?? e), ok: false })
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout: out, stderr: err, ok: code === 0 })
    })
  })
}

/** Run a shell command string via `bash -lc` (for git, ast-grep, monitors). */
export function runShell(
  cmd: string,
  opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CmdResult> {
  return runCmd('bash', ['-lc', cmd], opts)
}

/** Names of files changed in the git working tree (tracked modified + untracked), sync. */
export function gitChangedFilesSync(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3).trim())
      .filter((p) => p && !p.includes(' -> '))
  } catch {
    return []
  }
}

/** Locate a binary on PATH (sync, cheap). Returns absolute path or null. */
export function whichSync(name: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter)
  for (const d of dirs) {
    if (!d) continue
    const cand = path.join(d, name)
    try {
      if (existsSync(cand)) return cand
      if (process.platform !== 'win32' && existsSync(cand + '.exe')) return cand + '.exe'
    } catch {
      /* ignore unreadable dirs */
    }
  }
  return null
}
