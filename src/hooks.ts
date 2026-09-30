/**
 * omo_hooks — automatic hook interception layer for dsh-oh-my-agent.
 *
 * Faithful port of OmO's PreToolUse / PostToolUse hook gates, wired onto DSH's
 * `tools/pre-execute` / `tools/post-execute` waterfalls.
 *
 * Hooks (each toggled by `[opencode].hooks` in omo.jsonc; disabled via
 * `[opencode].disabled_hooks`):
 *   - write-existing-file-guard : read-before-overwrite gate for the `write`
 *       tool. Modes: off | log (default; only record) | deny (hard block unless
 *       the file was recently read — real OmO behaviour).
 *   - comment-checker          : after a successful write/edit, scan the target
 *       file for blocking markers. Modes (hooks.comment_checker): off | warn
 *       (default; attach a corrective context note) | block (hard-block the
 *       result toward the model).
 *   - rules-injector           : after a successful `edit`, attach the compiled
 *       rules for the target path as additional context (file channel; deduped
 *       per path, TTL-cached). Standing `[session, tool]` rules are excluded by
 *       the channel gate and instead injected once per session by the pre-step
 *       listener in index.ts (session channel).
 *   - read-only planning gate  : agents whose preset is listed in
 *       hooks.read_only_agents may only write `*.md` inside `.omo/` (the
 *       Prometheus-style guard). The same gate also fires while the
 *       Prometheus planning mode is active on the session (sessionModel.ts):
 *       write/edit/hashline writes are then limited to `*.md` under
 *       hooks.plan_write_scopes (default ['.omo', '.agent-notes'] — planner
 *       docs plus boulder watermarks).
 *   - edit-error-recovery      : when an edit-family tool fails, inject a
 *       STOP-read-verify-correct reminder (OmO edit-error-recovery); a per
 *       (tool,file) failure ledger escalates to "switch method" after 2 fails.
 *   - json-error-recovery      : when a tool fails with JSON/schema-style
 *       argument errors, inject a fix-your-arguments reminder (OmO
 *       json-error-recovery).
 *   - monitor-status-injector  : attach a one-line status of running background
 *       monitors whenever their state signature changes (OmO
 *       monitor-status-injector, mapped onto tools/post-execute).
 *   - hashline-read-enhancer   : after the first successful read of a file per
 *       process, hint that hashline-anchored editing is available (OmO
 *       hashline-read-enhancer, adapted: DSH post-execute can only attach
 *       context, not rewrite the read output).
 *
 * Beyond the cooperative waterfalls this module also exports one ToolGuard —
 *   - nested-delegation-guard  : monotonic guard (registered via
 *       `tools.guard`, evaluated after every pre-execute listener and before
 *       the tool body) that denies delegation tools (`delegate_as`, host
 *       named channels `subagent` / `subagent_*`) inside subagent sessions
 *       (persistent `SessionHeader.origin === 'subagent'` or
 *       `delegationDepth > 0`). Guards have no allow result, so no listener
 *       ordering can undo the denial; the header fields survive cold resume.
 *
 * Every listener is cooperative: it calls `next()` first so downstream deciders
 * (sandbox/approval) keep authority, and only appends/overrides per the model
 * above. All failures are contained — a throwing hook never breaks a tool call.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { omoDir, nowTs, isWithin } from './util.js'
import { loadLayeredConfig } from './omoconfig.js'
import { refreshRulesState, sessionRules, compileRules } from './rules.js'
import { checkComments } from './commentCheck.js'
import { MonitorRegistry } from './monitor.js'
import { isPlanningActive } from './sessionModel.js'

export interface HookEvent {
  ts: string
  hook: string
  tool: string
  file: string
  action: string
  detail: string
}

/** Ring buffer of recent hook activity (for omo_hooks status; no secrets). */
export const hookLog: HookEvent[] = []

function pushLog(hook: string, tool: string, file: string, action: string, detail: string): void {
  const ev: HookEvent = { ts: nowTs(), hook, tool, file, action, detail: detail.slice(0, 160) }
  hookLog.push(ev)
  if (hookLog.length > 200) hookLog.shift()
  try {
    const dir = omoDir(wsForExec0(), 'hooks')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'log.ndjson'), JSON.stringify(ev) + '\n')
  } catch { /* best-effort */ }
}

let lastWsHint = ''
function wsForExec0(): string {
  return lastWsHint || process.env.OMO_HOOKS_WS || ''
}

/* ─────────────────────────── config ─────────────────────────── */

export type WriteGuardMode = 'off' | 'log' | 'deny'
export type CommentMode = 'off' | 'warn' | 'block'

export interface HooksConfig {
  writeGuard: WriteGuardMode
  commentChecker: CommentMode
  rulesInjector: boolean
  readOnlyAgents: string[]
  /** 规划态动态写入门允许的相对目录（须以 `.md` 结尾才放行）。 */
  planWriteScopes: string[]
  editErrorRecovery: boolean
  jsonErrorRecovery: boolean
  monitorStatusInjector: boolean
  hashlineReadEnhancer: boolean
  /** 子代理会话禁再派发（nested-delegation-guard ToolGuard）。 */
  nestedDelegationGuard: boolean
  /** 额外纳入派发面封禁的工具名，供未来新增 spawn 入口用逃生口。 */
  nestedDelegationExtraTools: string[]
  disabledHooks: string[]
}

const DEFAULT_HOOKS: HooksConfig = {
  writeGuard: 'log',
  commentChecker: 'warn',
  rulesInjector: true,
  readOnlyAgents: [],
  planWriteScopes: ['.omo', '.agent-notes'],
  editErrorRecovery: true,
  jsonErrorRecovery: true,
  monitorStatusInjector: true,
  hashlineReadEnhancer: true,
  nestedDelegationGuard: true,
  nestedDelegationExtraTools: [],
  disabledHooks: [],
}

/**
 * Read the effective hooks config for a workspace. Decided fresh on every call
 * (hooks run once per tool call) so no shared/mutated cached state can ever skew
 * a gate's decision — determinism beats micro-caching here.
 */
export function hooksConfigFor(ws: string, execWsHint?: string): HooksConfig {
  if (execWsHint) lastWsHint = execWsHint
  const merged = loadLayeredConfig(ws).merged
  const oc = ((merged.opencode ?? merged['[opencode]']) ?? {}) as Record<string, unknown>
  const h = (oc.hooks ?? {}) as Record<string, unknown>
  const disabled = new Set<string>(Array.isArray(oc.disabled_hooks) ? (oc.disabled_hooks as unknown[]).map(String) : [])

  let writeGuard: WriteGuardMode = DEFAULT_HOOKS.writeGuard
  if (h.write_guard === false) writeGuard = 'off'
  else if (typeof h.write_guard === 'string') writeGuard = ['off', 'log', 'deny'].includes(String(h.write_guard)) ? (String(h.write_guard) as WriteGuardMode) : 'log'

  let commentChecker: CommentMode = DEFAULT_HOOKS.commentChecker
  if (h.comment_checker === false) commentChecker = 'off'
  else if (typeof h.comment_checker === 'string') commentChecker = ['off', 'warn', 'block'].includes(String(h.comment_checker)) ? (String(h.comment_checker) as CommentMode) : 'warn'
  else if (h.comment_checker === true) commentChecker = 'warn'

  const rulesInjector = typeof h.rules_injector === 'boolean' ? h.rules_injector : DEFAULT_HOOKS.rulesInjector
  const readOnlyAgents = Array.isArray(h.read_only_agents) ? (h.read_only_agents as unknown[]).map(String) : []
  // 显式数组即采用（空数组=规划态只读门全禁写）；非数组回默认
  const planWriteScopes = Array.isArray(h.plan_write_scopes) ? (h.plan_write_scopes as unknown[]).map(String).filter((s) => s.length > 0) : DEFAULT_HOOKS.planWriteScopes

  // resilience/UX hooks default ON; `hooks.<name>: false` (or any falsy) turns them off
  const editErrorRecovery = h.edit_error_recovery === false ? false : DEFAULT_HOOKS.editErrorRecovery
  const jsonErrorRecovery = h.json_error_recovery === false ? false : DEFAULT_HOOKS.jsonErrorRecovery
  const monitorStatusInjector = h.monitor_status_injector === false ? false : DEFAULT_HOOKS.monitorStatusInjector
  const hashlineReadEnhancer = h.hashline_read_enhancer === false ? false : DEFAULT_HOOKS.hashlineReadEnhancer
  const nestedDelegationGuard = h.nested_delegation_guard === false ? false : DEFAULT_HOOKS.nestedDelegationGuard
  const nestedDelegationExtraTools = Array.isArray(h.nested_delegation_extra_tools) ? (h.nested_delegation_extra_tools as unknown[]).map(String).filter((s) => s.length > 0) : DEFAULT_HOOKS.nestedDelegationExtraTools

  return {
    writeGuard,
    commentChecker,
    rulesInjector,
    readOnlyAgents,
    planWriteScopes,
    editErrorRecovery,
    jsonErrorRecovery,
    monitorStatusInjector,
    hashlineReadEnhancer,
    nestedDelegationGuard,
    nestedDelegationExtraTools,
    disabledHooks: [...disabled],
  }
}

const hookEnabled = (cfg: HooksConfig, name: string): boolean => !cfg.disabledHooks.includes(name)

/* ─────────────────────────── helpers ─────────────────────────── */

export interface ExecLike {
  name: string
  arguments?: Record<string, unknown>
  agent?: { session?: { header?: { cwd?: string; agentPreset?: string; origin?: string; delegationDepth?: number }; meta?: { cwd?: string; agentPreset?: string } } }
}

function wsOf(exec: ExecLike): string {
  const s = exec.agent?.session
  return s?.header?.cwd ?? s?.meta?.cwd ?? ''
}

function agentPresetOf(exec: ExecLike): string {
  const s = exec.agent?.session
  return s?.header?.agentPreset ?? s?.meta?.agentPreset ?? ''
}

/** Extract the primary target path from tool arguments. */
function fileOf(args: ExecLike['arguments']): string | null {
  if (!args || typeof args !== 'object') return null
  for (const k of ['file_path', 'filePath', 'path', 'file']) {
    const v = args[k]
    if (typeof v === 'string' && v) return v
  }
  return null
}

const READ_TOOLS = new Set(['read'])
/** 落盘工具族：write/edit + 行锚编辑（读-改-写一体，必须与 write/edit 同门）。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'omo_hashline_edit'])
/** Edit-family tools whose failures route to edit-error-recovery. */
const EDIT_FAMILY = new Set(['write', 'edit', 'omo_hashline_edit'])

/** Error text heuristics for JSON/schema-style argument failures. */
const JSON_ERR_RE = /json|parse|schema|must be|invalid argument|unexpected token|参数|解析/i

/** Fix-your-arguments reminder (OmO json-error-recovery, DSH adaptation). */
const JSON_RECOVERY_REMINDER = `[OMO HOOK · json-error-recovery] 工具调用的参数校验失败。立即执行：
1. 逐字查看上方错误信息：期望什么 vs 实际发了什么
2. 修正参数（缺失/多余字段、类型不符、枚举值拼写、JSON 语法、转义引号）
3. 用修正后的参数重试
不要原样重复同一次失败调用。`

/** Consecutive-failure ledger per (tool,file); cleared on success. */
const editFailures = new Map<string, number>()

/** Files already hinted by hashline-read-enhancer (once per process). */
const hashlineHinted = new Set<string>()
/** Total hint budget per process - early files hint, later ones stay quiet. */
let hashlineHintBudget = 3

/** Last injected monitor-state signature (dedup: only inject on change). */
let lastMonitorSig = ''

/** Extract the rendered error text from a failed tool result. */
function errorTextOf(result: unknown): string {
  const r = result as { content?: unknown } | undefined
  const blocks = Array.isArray(r?.content) ? (r.content as Array<{ text?: unknown }>) : []
  return blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n').slice(0, 400)
}

/** Build the edit-failure recovery hint (escalates with the failure count). */
function buildEditRecovery(tool: string, fileRel: string | null, fails: number, errText: string): string {
  const stale = /hash|anchor|mismatch|不匹配|stale|no longer|changed/i.test(errText)
  const lines: string[] = [
    `[OMO HOOK · edit-error-recovery] ${tool} 编辑失败（第 ${fails} 次）${fileRel ? ` @ ${fileRel}` : ''}。停止重试，立即执行：`,
    '1. 先 read 该文件，确认它的真实当前内容 -- 你对文件状态的假设已经错了',
  ]
  if (tool === 'omo_hashline_edit' || stale) {
    lines.push('2. 重新 omo_hashline_lines 取行号#哈希，再 omo_hashline_edit 行锚编辑（内容不符会被自动拒绝）')
  } else {
    lines.push('2. old_string 不唯一/找不到时：扩大上下文使其唯一，或改用 omo_hashline_lines + omo_hashline_edit 行锚编辑')
  }
  if (fails >= 2) lines.push(`3. 已连续失败 ${fails} 次：必须换方法（read -> 行锚编辑），禁止再重复同一编辑`)
  lines.push('确认无误后再继续，不要盲目重试。')
  return lines.join('\n')
}

/** Recently-read paths (the write-guard "read-before-overwrite" ledger). */
const recentReads = new Map<string, number>()

/** Compiled-rules cache per workspace (5s TTL). */
const rulesCache = new Map<string, { at: number; block: string }>()

function compiledRulesFor(ws: string, targetRel: string): string {
  const cached = rulesCache.get(ws)
  if (cached && Date.now() - cached.at < 5000) return cached.block
  let state: ReturnType<typeof refreshRulesState> | null = null
  try {
    state = refreshRulesState(ws, targetRel)
  } catch {
    state = null
  }
  const block = state?.compiled ?? ''
  rulesCache.set(ws, { at: Date.now(), block })
  return block
}

/** Session-channel standing-rules block cache per workspace (5s TTL). */
const sessionRulesCache = new Map<string, { at: number; block: string }>()

/**
 * Compiled block for the `session` channel: alwaysApply rules declaring
 * `applyTo` containing 'session' (see rules.sessionRules). Injected once per
 * session by the pre-step listener in index.ts — never by the file (edit) hook.
 */
export function sessionRulesBlockFor(ws: string): string {
  const cached = sessionRulesCache.get(ws)
  if (cached && Date.now() - cached.at < 5000) return cached.block
  let block = ''
  try {
    block = compileRules(sessionRules(ws))
  } catch {
    block = ''
  }
  sessionRulesCache.set(ws, { at: Date.now(), block })
  return block
}

/** Build a user-role context message for attachment. */
function ctxMessage(text: string): unknown {
  return createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

/* ─────────────────────────── pre-execute ─────────────────────────── */

/**
 * tools/pre-execute listener. Cooperative: awaits `next()` first so downstream
 * deciders keep authority; only overrides to deny per the configured gates.
 */
export async function omoPreExecute(
  exec: ExecLike,
  next: () => Promise<{ kind: string }>,
): Promise<{ kind: string; reason?: string }> {
  try {
    const name = String(exec.name ?? '')
    const ws = wsOf(exec)
    const decision = await next()
    if (decision.kind !== 'allow') return decision

    const args = exec.arguments
    const fileRel = fileOf(args)
    const abs = fileRel && ws ? path.resolve(ws, fileRel) : ''

    // track reads for the write-guard ledger
    if (READ_TOOLS.has(name) && abs) recentReads.set(abs, Date.now())

    const cfg = hooksConfigFor(ws || (lastWsHint || process.cwd()), ws)

    // 1) write-existing-file-guard
    if (hookEnabled(cfg, 'write-existing-file-guard') && name === 'write' && cfg.writeGuard !== 'off' && abs && fs.existsSync(abs)) {
      const justRead = (recentReads.get(abs) ?? 0) > Date.now() - 60_000
      pushLog('write-existing-file-guard', name, fileRel || '', cfg.writeGuard, justRead ? 'file recently read — allow' : 'existing file overwrite')
      if (cfg.writeGuard === 'deny' && !justRead) {
        return { kind: 'deny', reason: `[omo_hooks] write-existing-file-guard: "${fileRel}" already exists and was not read first. Read the file before overwriting (or call write with an explicit overwrite intent).` }
      }
    }

    // 2) read-only planning gate (Prometheus-style, static preset list + dynamic planning mode)
    const presetGated = cfg.readOnlyAgents.includes(agentPresetOf(exec))
    const planningGated = isPlanningActive(exec.agent)
    if (hookEnabled(cfg, 'read-only-gate') && (presetGated || planningGated) && WRITE_TOOLS.has(name) && abs) {
      const isMarkdown = /\.md$/i.test(abs)
      const allowed = presetGated
        ? isWithin(path.join(ws, '.omo'), abs) && isMarkdown
        : cfg.planWriteScopes.some((scope) => scope && isWithin(path.join(ws, scope), abs)) && isMarkdown
      if (!allowed) {
        const who = presetGated ? `agent "${String(agentPresetOf(exec))}"` : 'planning mode (Prometheus)'
        const scopeDesc = presetGated ? '.omo/' : cfg.planWriteScopes.join('、') || '(none)'
        pushLog('read-only-gate', name, fileRel || '', 'deny', `${who}: may only write *.md under ${scopeDesc}`)
        return { kind: 'deny', reason: `[omo_hooks] read-only-gate: ${who} may only write markdown under ${scopeDesc}; target "${fileRel}" denied.` }
      }
    }

    return decision
  } catch (e) {
    // never break the pipeline on a hook failure
    try { pushLog('omo_pre_execute_error', String(exec.name ?? ''), '', 'error', String(e)) } catch { /* ignore */ }
    return next()
  }
}

/* ─────────────────────────── nested-delegation guard ─────────────────────────── */

/**
 * 派发工具面：插件 `delegate_as` + 宿主具名通道 `subagent` / `subagent_*`
 * （前缀匹配，不依赖部署名册——本部署是 subagent_default/deep/librarian/review/oracle）
 * + 内部直调 `subagents.start()` 的工具入口 `workflow` / `ralph`（它们本身是工具调用，
 * 纳入即闭合"绕过 ToolRuntime 直接 spawn"的绕过面）。
 * `extra` 为调用方额外纳入的工具名（hooks.nested_delegation_extra_tools 逃生口）。
 */
const DELEGATION_TOOL_NAMES = new Set(['delegate_as', 'subagent', 'workflow', 'ralph'])
export function isDelegationTool(name: string, extra?: readonly string[]): boolean {
  if (DELEGATION_TOOL_NAMES.has(name)) return true
  if (name.startsWith('subagent_')) return true
  // Array.isArray 判断不可省：`Array.prototype.filter(isDelegationTool)` 会把 index(number) 当第二参传入。
  return Array.isArray(extra) && extra.includes(name)
}

/** 会话是否子代理：持久 SessionHeader 判定（origin/delegationDepth 冷恢复依然成立）。 */
function isSubagentSession(exec: ExecLike): boolean {
  const header = exec.agent?.session?.header
  if (!header) return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/**
 * ToolGuard（monotonic）：子代理会话里拒绝一切派发工具（嵌套派发），主会话不受影响。
 * 覆盖 `delegate_as` / `subagent` / `subagent_*` / `workflow` / `ralph`，
 * 另可经 `hooks.nested_delegation_extra_tools` 追加工具名逃生口。
 * 判定顺序：子代理会话先筛（主会话零配置读取直接放行），再读配置。
 * 注册为 plain-context 全局守卫——位于 pre-execute waterfall 之后、工具体之前，
 * 无 allow 结果，任何监听器顺序都翻不了案；返回 string 即最终拒绝。
 */
export function nestedDelegationGuard(exec: ExecLike): string | undefined {
  try {
    const name = String(exec.name ?? '')
    if (!isSubagentSession(exec)) return undefined
    const ws = wsOf(exec)
    const cfg = hooksConfigFor(ws || (lastWsHint || process.cwd()), ws)
    if (!cfg.nestedDelegationGuard || !hookEnabled(cfg, 'nested-delegation-guard')) return undefined
    if (!isDelegationTool(name, cfg.nestedDelegationExtraTools)) return undefined
    pushLog('nested-delegation-guard', name, '', 'deny', 'subagent session may not spawn subagents')
    return '[omo_hooks] nested-delegation-guard: 子代理不能再派发子代理（嵌套委托已被宿主级守卫拒绝）。若任务需要分工或更多算力，把可并行的子任务连同所需上下文写进你的最终报告，由编排者统一派发；不要重试本调用。'
  } catch {
    // never break the pipeline on a guard failure
    return undefined
  }
}

/**
 * 档②纵深：把同一守卫注册到 agent 自己的 scope（`agent.ctx.tools.guard`）。
 * 作用域守卫只对该 agent 生效，且随 agent ctx 销毁自动回收；
 * 与全局守卫形成双保险，不依赖全局层的注册时序。
 */
export function registerPerAgentGuard(agent: unknown): (() => void) | undefined {
  try {
    const ctx = (agent as { ctx?: { tools?: { guard?: (g: unknown) => unknown } } } | null | undefined)?.ctx
    const tools = ctx?.tools
    if (tools === undefined || typeof tools.guard !== 'function') return undefined
    // 必须以 `tools.guard(...)` 方法调用形式执行以保留 this（作用域视图）；不要解构后单独调用。
    const disposer = tools.guard(nestedDelegationGuard)
    return typeof disposer === 'function' ? (disposer as () => void) : undefined
  } catch {
    return undefined
  }
}

/* ─────────────────────────── post-execute ─────────────────────────── */

interface ResultLike {
  isError?: boolean
}

/** Line count of a monitor log file (for state signatures); -1 when unreadable. */
function logLineCount(logFile: string): number {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').length
  } catch {
    return -1
  }
}

/**
 * tools/post-execute listener. Awaits `next()` then appends corrective context
 * (comment-checker / rules-injector / recovery hooks) only when the downstream
 * decision accepted. Failure results route to the recovery hooks instead.
 */
export async function omoPostExecute(
  exec: ExecLike,
  result: ResultLike,
  next: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    const name = String(exec.name ?? '')
    const ws = wsOf(exec)
    const decision = await next()
    if (!decision || decision.kind !== 'accept') return decision

    const extra: unknown[] = []
    const args = exec.arguments
    const fileRel = fileOf(args)
    const abs = fileRel && ws ? path.resolve(ws, fileRel) : ''
    const cfg = hooksConfigFor(ws || (lastWsHint || process.cwd()), ws)

    /* ── failure path: recovery hooks ── */
    if (result?.isError) {
      // 5) edit-error-recovery: stop, re-read, then re-anchor (escalates per fail count)
      if (hookEnabled(cfg, 'edit-error-recovery') && cfg.editErrorRecovery && EDIT_FAMILY.has(name)) {
        const key = `${name}::${fileRel ?? ''}`
        const fails = (editFailures.get(key) ?? 0) + 1
        editFailures.set(key, fails)
        const errText = errorTextOf(result)
        pushLog('edit-error-recovery', name, fileRel ?? '', `fail#${fails}`, errText.slice(0, 120) || 'edit failed')
        extra.push(ctxMessage(buildEditRecovery(name, fileRel, fails, errText)))
      }
      // 6) json-error-recovery: argument parse/schema failures (edit family handled above)
      else if (hookEnabled(cfg, 'json-error-recovery') && cfg.jsonErrorRecovery && JSON_ERR_RE.test(errorTextOf(result))) {
        pushLog('json-error-recovery', name, '', 'inject', 'argument parse/schema error')
        extra.push(ctxMessage(JSON_RECOVERY_REMINDER))
      }
      if (extra.length === 0) return decision
      const baseErr = (decision.additionalContexts ?? []) as unknown[]
      return { ...decision, additionalContexts: [...baseErr, ...extra] }
    }

    // success path: reset the failure ledger for this (tool,file)
    if (EDIT_FAMILY.has(name) && fileRel) editFailures.delete(`${name}::${fileRel}`)

    // 3) comment-checker after successful write/edit
    if (hookEnabled(cfg, 'comment-checker') && cfg.commentChecker !== 'off' && WRITE_TOOLS.has(name) && abs && fs.existsSync(abs)) {
      try {
        const res = checkComments(ws, { path: fileRel ?? '' })
        const blockers = res.blockers.filter((b) => b.file === (fileRel ?? '') || b.file.endsWith('/' + (fileRel ?? '')))
        if (blockers.length > 0) {
          pushLog('comment-checker', name, fileRel || '', cfg.commentChecker, `${blockers.length} blocking markers`)
          if (cfg.commentChecker === 'block') {
            return { kind: 'block', feedback: [{ type: 'text', text: `[omo_hooks] comment-checker: ${blockers.length} blocking marker(s) in ${fileRel} (${blockers[0].marker} @${blockers[0].line}). Clean them or mark @allow.` }] }
          }
          const sample = blockers.slice(0, 5).map((b) => `- ${b.marker} @${b.file}:${b.line}`).join('\n')
          extra.push(ctxMessage(`[OMO HOOK · comment-checker] ${blockers.length} 个阻断标记刚被写入 ${fileRel}:\n${sample}\n→ 清理或加 @allow，或将 hook 模式调为 block 以硬拦截。`))
        }
      } catch { /* contained */ }
    }

    // 4) rules-injector: attach compiled rules once per path (file channel —
    //    matched through rulesForPath(ws, fileRel, 'file'), so rules whose
    //    applyTo excludes 'file' (e.g. [session, tool]) never fire here)
    if (hookEnabled(cfg, 'rules-injector') && cfg.rulesInjector && name === 'edit' && abs) {
      try {
        const block = compiledRulesFor(ws, fileRel ?? '')
        // Only inject when there is actual rule content ('' when no rules
        // matched); never fire for an empty shell.
        if (block && block.trim().length > 0) {
          extra.push(ctxMessage(`[OMO HOOK · rules] 适用于 ${fileRel} 的已编译规则，请遵守：\n${block.slice(0, 2500)}`))
        }
      } catch { /* contained */ }
    }

    // 7) hashline-read-enhancer: one-time hint after the first read of a file
    //    (budget-capped so a bulk-read burst does not spam hints)
    if (hookEnabled(cfg, 'hashline-read-enhancer') && cfg.hashlineReadEnhancer && name === 'read' && abs && hashlineHintBudget > 0) {
      const key = `${ws}::${abs}`
      if (!hashlineHinted.has(key)) {
        hashlineHinted.add(key)
        hashlineHintBudget -= 1
        pushLog('hashline-read-enhancer', name, fileRel ?? '', 'hint', 'one-time hashline hint')
        extra.push(ctxMessage(`[OMO HINT · hashline] 已记录读取 ${fileRel}。对该文件做精确编辑：先 omo_hashline_lines 取“行号#哈希”，再 omo_hashline_edit 行锚编辑（内容不符自动拒绝，防 stale 误写）。`))
      }
    }

    // 8) monitor-status-injector: one-line status when the set of running
    //    monitors changes (start/exit boundaries; output growth is the
    //    [OMO MONITOR OUTPUT] envelope's job, not this hook's)
    if (hookEnabled(cfg, 'monitor-status-injector') && cfg.monitorStatusInjector && ws) {
      try {
        const running = new MonitorRegistry(ws).list().filter((m) => m.running)
        if (running.length > 0) {
          const sig = running.map((m) => `${m.id}:${m.running ? 'r' : 'x'}:${logLineCount(m.logFile)}`).join('|')
          if (sig !== lastMonitorSig) {
            lastMonitorSig = sig
            const brief = running.slice(0, 4).map((m) => `${m.id}（${m.command.slice(0, 60)}）`).join('、')
            pushLog('monitor-status-injector', name, '', 'inject', `${running.length} running`)
            extra.push(ctxMessage(`[OMO MONITOR STATUS] ${running.length} 个后台 monitor 运行中：${brief}。用 omo_monitor action=output id=<id> 查看输出。`))
          }
        }
      } catch { /* contained */ }
    }

    if (extra.length === 0) return decision
    const base = (decision.additionalContexts ?? []) as unknown[]
    return { ...decision, additionalContexts: [...base, ...extra] }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (e: any) {
    try { pushLog('omo_post_execute_error', String(exec.name ?? ''), '', 'error', String(e)) } catch { /* ignore */ }
    return next()
  }
}

/** Current effective hook config + recent activity (for the omo_hooks tool). */
export function hooksStatus(ws: string, execWsHint?: string): {
  config: HooksConfig
  recent: HookEvent[]
} {
  return { config: hooksConfigFor(ws, execWsHint), recent: hookLog.slice(-30) }
}
