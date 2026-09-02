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

  // 设置页托管层（dsh-oh-my-agent「子代理模型设置」写入的 model-routes.jsonc）。
  // 后 push 者优先，故本层压过一切手写 omo.jsonc——手写配置不被改写、设置页又必然生效。
  push(userRoutesFile())
  push(workspaceRoutesFile(ws))

  return { files: sources, merged, diagnostics, found: sources.some((s) => s.existed) }
}

const OMO_HOME = (): string => path.join(homedir(), '.omo')

/** 设置页托管层文件：用户层 ~/.omo/model-routes.jsonc（本插件自管，勿手改）。 */
export function userRoutesFile(): string {
  return path.join(OMO_HOME(), 'model-routes.jsonc')
}

/** 设置页托管层文件：工作区 <ws>/.omo/model-routes.jsonc（本插件自管，勿手改）。 */
export function workspaceRoutesFile(ws: string): string {
  return path.join(ws, '.omo', 'model-routes.jsonc')
}

/**
 * 读一个 model-routes 覆盖层；缺失或解析失败返回 null（不抛）。
 * 结构：{ opencode: { delegate_roles?: Record<role, 'provider/model'>,
 *        categories?: Record<category, { model?: {provider, model}, ... }> } }
 */
export function readRoutesLayer(file: string): Record<string, unknown> | null {
  const raw = readFileOrNull(file)
  if (raw === null) return null
  try {
    const parsed = parseJsonc(raw)
    return isPlainObj(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 写一个 model-routes 覆盖层（纯 JSON 输出，可往返解析）。patch 值 '' 表示删除该 key：
 *  - roles:    delegate_roles[role] = 'provider/model'（非空）| delete（空）
 *  - categories: categories[cat] 保留为普通对象（若已是），设 cat.model = {provider, model}；
 *               空值 delete 该 category。
 * 写文件前 mkdir -p dirname；失败返回 {ok:false, message}。
 */
export function writeRoutesLayer(
  file: string,
  patch: { roles: Record<string, string>; categories: Record<string, string> },
): { ok: boolean; message: string } {
  try {
    const base: Record<string, unknown> = readRoutesLayer(file) ?? {}
    if (!isPlainObj(base.opencode)) base.opencode = {}
    const oc = base.opencode as Record<string, unknown>

    let dr = oc.delegate_roles
    if (!isPlainObj(dr)) { dr = {}; oc.delegate_roles = dr }
    const drObj = dr as Record<string, unknown>
    for (const [role, value] of Object.entries(patch.roles)) {
      if (value) drObj[role] = value
      else delete drObj[role]
    }
    if (Object.keys(drObj).length === 0) delete oc.delegate_roles

    let cats = oc.categories
    if (!isPlainObj(cats)) { cats = {}; oc.categories = cats }
    const catsObj = cats as Record<string, unknown>
    for (const [cat, value] of Object.entries(patch.categories)) {
      if (value) {
        const idx = value.indexOf('/')
        const provider = idx > 0 ? value.slice(0, idx) : value
        const model = idx > 0 ? value.slice(idx + 1) : ''
        const prev = catsObj[cat]
        const catObj = isPlainObj(prev) ? { ...(prev as Record<string, unknown>) } : {}
        catObj.model = { provider, model }
        catsObj[cat] = catObj
      } else {
        delete catsObj[cat]
      }
    }
    if (Object.keys(catsObj).length === 0) delete oc.categories
    if (Object.keys(oc).length === 0) delete base.opencode
    if (Object.keys(base).length === 0) {
      // 全部覆盖被清空：直接删除托管文件（不存在也不报错）
      try { fs.rmSync(file, { force: true }) } catch { /* ignore */ }
      return { ok: true, message: `removed ${file}` }
    }

    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(base, null, 2) + '\n', 'utf8')
    return { ok: true, message: `wrote ${file}` }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
}

/** model-routes 覆盖层文件是否存在。 */
export function routesLayerExists(file: string): boolean {
  return readFileOrNull(file) !== null
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
