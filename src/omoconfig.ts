/**
 * omo.jsonc layered configuration — faithful port of OmO's omo-config-core.
 *
 * Precedence (low -> high): `~/.omo/omo.jsonc` (user) then each `.omo/omo.jsonc`
 * from the workspace root upward to `$HOME` (nearest wins; dirs closer to the
 * workspace override outer ones). Plain objects deep-merge; scalars and arrays
 * replace. `opencode` (or `[opencode]`) is a free-form record carrying the
 * plugin toggles used here:
 *
 *   {
 *     "opencode": {
 *       "disabled_tools": ["omo_code_search"],
 *       "hashline_edit": { "enabled": false },
 *       "comment_checker": { "enabled": true },
 *       "monitor": { "enabled": true }
 *     }
 *   }
 */

import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

/** Strip `//` and block comments while preserving string literals. */
export function stripJsonc(text: string): string {
  let out = ''
  let i = 0
  let inStr = false
  let strCh = ''
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (!inStr && ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (!inStr && ch === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    if (inStr) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === strCh) inStr = false
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = true
      strCh = ch
      out += ch
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

export function parseJsonc(text: string): unknown {
  const stripped = stripJsonc(text).replace(/,\s*([}\]])/g, '$1')
  return JSON.parse(stripped)
}

export interface ConfigSource {
  path: string
  existed: boolean
  parsed: unknown
  error?: string
}

export interface OmOConfigView {
  files: ConfigSource[]
  merged: Record<string, unknown>
  diagnostics: string[]
  found: boolean
}

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Deep-merge plain objects (later wins on scalars/arrays; objects merge). */
export function deepMerge(base: Record<string, unknown>, patch: unknown): Record<string, unknown> {
  if (!isPlainObj(patch)) return base
  for (const k of Object.keys(patch)) {
    const v = patch[k]
    const cur = base[k]
    if (isPlainObj(cur) && isPlainObj(v)) {
      base[k] = deepMerge({ ...cur }, v)
    } else {
      base[k] = v
    }
  }
  return base
}

const readFileOrNull = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Collect + merge the layered omo.jsonc for a workspace.
 * Ordered low->high precedence (user first, then workspace dir upward to $HOME).
 */
export function loadLayeredConfig(ws: string): OmOConfigView {
  const sources: ConfigSource[] = []
  const diagnostics: string[] = []
  const merged: Record<string, unknown> = {}

  const push = (file: string): void => {
    const raw = readFileOrNull(file)
    if (raw === null) {
      sources.push({ path: file, existed: false, parsed: null })
      return
    }
    try {
      const parsed = parseJsonc(raw)
      sources.push({ path: file, existed: true, parsed })
      if (isPlainObj(parsed)) deepMerge(merged, parsed)
    } catch (e) {
      sources.push({ path: file, existed: true, parsed: null, error: String(e) })
      diagnostics.push(file + ': ' + String(e))
    }
  }

  // user layer
  push(path.join(homedir(), '.omo', 'omo.jsonc'))

  // project layers: walk from ws upward to $HOME (exclusive), near-to-ws first.
  const dirs: string[] = []
  let cur = path.resolve(ws)
  const home = path.resolve(homedir())
  while (cur !== home && cur !== path.dirname(cur)) {
    dirs.unshift(cur)
    cur = path.dirname(cur)
  }
  for (const d of dirs) push(path.join(d, '.omo', 'omo.jsonc'))

  return { files: sources, merged, diagnostics, found: sources.some((s) => s.existed) }
}

/** Read the user-layer (~/.omo/omo.jsonc) merged config only (host-wide toggles). */
export function loadUserConfig(): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  try {
    const file = path.join(homedir(), '.omo', 'omo.jsonc')
    const raw = readFileOrNull(file)
    if (raw !== null) {
      const parsed = parseJsonc(raw)
      if (isPlainObj(parsed)) deepMerge(merged, parsed)
    }
  } catch {
    /* unreadable user config -> defaults */
  }
  return merged
}

/** Tools to skip registering, from `opencode.disabled_tools`. */
export function mergedTools(merged: Record<string, unknown>): string[] {
  const oc = ((merged.opencode ?? merged['[opencode]']) ?? {}) as Record<string, unknown>
  const disabled = oc.disabled_tools
  return Array.isArray(disabled) ? disabled.map(String) : []
}

/** Boolean toggle lookup: merged[opencode][block][key], defaulting to `def`. */
export function mergedToggle(merged: Record<string, unknown>, block: string, key: string, def = true): boolean {
  const oc = ((merged.opencode ?? merged['[opencode]']) ?? {}) as Record<string, unknown>
  const b = oc[block]
  if (isPlainObj(b)) {
    const v = (b as Record<string, unknown>)[key]
    if (typeof v === 'boolean') return v
  }
  return def
}
