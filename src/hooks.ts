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
 *   - rules-injector           : after a successful `edit` (existing) or a
 *       successful `read` (adaptation: deep-AGENTS awareness before acting on
 *       a file), attach the bounded rule context for the target path as
 *       additional context (file channel; composed by projectContext — 2500
 *       char budget, whole-rule granularity, explicit contextIncomplete).
 *       Each distinct block is delivered once per session; re-delivery happens
 *       only when the rules themselves changed. There is NO TTL cache: rule
 *       edits are visible on the very next tool call. Standing
 *       `[session, tool]` rules are excluded by the channel gate and instead
 *       injected once per session by the pre-step listener in index.ts.
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
import { omoDir, nowTs, isWithin, sha256 } from './util.js'
import { loadLayeredConfig } from './omoconfig.js'
import { sessionRules, compileRules } from './rules.js'
import { ruleContextForTargets } from './projectContext.js'
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

/* The 5s-TTL per-(workspace, path) compiled-rules cache was removed on purpose
 * (omo-project-documentation 计划已决契约 7): a TTL cache kept serving stale
 * blocks for up to 5s after a rule edit. Rule resolution now runs fresh on
 * every post-execute (scanRules reads the files each time), and spam control is
 * entirely the delivery ledger below. */

interface RulesDeliveryLedger {
  /** Per-source identity of the last successful delivery (see sourceIdentity). */
  sources: Map<string, string>
  /** Composed-block fingerprint per normalized target set (file channel). */
  blocks: Map<string, string>
  /** Session-channel standing-rules block already injected for this session. */
  sessionRules?: boolean
}

/** Sessions kept by id before the oldest ledger is dropped (bounded memory). */
const LEDGER_LIMIT = 64

/** Ledgers keyed by stable session id. An agent/session wrapper re-created in a
 * later turn — or a re-mounted preset scope — must hit the same ledger, so
 * object identity is only the fallback for sessions that carry no id. */
const ledgersById = new Map<string, RulesDeliveryLedger>()
const ledgersByObject = new WeakMap<object, RulesDeliveryLedger>()

/** Stable session identity (`header.id` mirrors the Session's own id). */
export function sessionKeyOf(session: unknown): string | null {
  if (!session || typeof session !== 'object') return null
  const s = session as { id?: unknown; header?: { id?: unknown } }
  const id = s.header?.id ?? s.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function newLedger(): RulesDeliveryLedger {
  return { sources: new Map(), blocks: new Map() }
}

function ledgerFor(session: object): RulesDeliveryLedger {
  const key = sessionKeyOf(session)
  if (key) {
    let led = ledgersById.get(key)
    if (!led) {
      led = newLedger()
      ledgersById.set(key, led)
      if (ledgersById.size > LEDGER_LIMIT) {
        const oldest = ledgersById.keys().next().value
        if (oldest !== undefined && oldest !== key) ledgersById.delete(oldest)
      }
    }
    return led
  }
  let led = ledgersByObject.get(session)
  if (!led) {
    led = newLedger()
    ledgersByObject.set(session, led)
  }
  return led
}

/** Ledger key for one composed block: the normalized target set it was built for. */
function blockKeyOf(targets: readonly string[]): string {
  return targets.join('|')
}

/** True when the identical composed block was already delivered this session.
 * A block made of the header + contextIncomplete notice has an empty `included`
 * list, so the per-source ledger alone cannot dedupe it. */
function blockDelivered(led: RulesDeliveryLedger, targets: readonly string[], hash: string): boolean {
  return led.blocks.get(blockKeyOf(targets)) === hash
}

function recordBlockDelivered(led: RulesDeliveryLedger, targets: readonly string[], hash: string): void {
  led.blocks.set(blockKeyOf(targets), hash)
}

type RuleIdentity = { name: string; scopeDir: string | null; content: string; sources: string[] }
function sourceIdentity(e: RuleIdentity): string {
  return sha256(JSON.stringify({ name: e.name, scopeDir: e.scopeDir, content: e.content }))
}

function ledgerSkips(led: RulesDeliveryLedger, e: RuleIdentity): boolean {
  return led.sources.get(e.sources[0]) === sourceIdentity(e)
}

function recordDelivered(session: object, entries: readonly RuleIdentity[]): void {
  const led = ledgerFor(session)
  for (const e of entries) {
    const source = e.sources[0]
    if (source) led.sources.set(source, sourceIdentity(e))
  }
}

/** Seed sources actually selected for the once-per-session standing-rules channel. */
export function markSessionRulesDelivered(session: object, ws: string): void {
  try {
    const entries = sessionRules(ws).map((r) => ({
      name: r.name, scopeDir: r.scopeDir, content: r.content, sources: [r.relPath],
    }))
    recordDelivered(session, entries)
  } catch { /* best-effort; never break the session hook */ }
}

/** Whether the standing-rules (session channel) block was already injected for
 * this session. Strictly once per session: rule edits mid-session do not
 * re-inject. Keyed by session id, so a per-turn wrapper object cannot reset it. */
export function sessionRulesSent(session: object): boolean {
  return ledgerFor(session).sessionRules === true
}

/** Mark the session-channel standing-rules block as injected for this session. */
export function markSessionRulesSent(session: object): void {
  ledgerFor(session).sessionRules = true
}

/** Session-channel standing-rules block cache per workspace (5s TTL). */
const sessionRulesCache = new Map<string, { at: number; block: string }>()

/**
 * Compiled block for the `session` channel: alwaysApply rules declaring
 * `applyTo` containing 'session' (see rules.sessionRules). Injected once per
 * session by the pre-step listener in index.ts — never by the file (edit/read)
 * hook. The block is a once-per-session statement, so the 5s TTL here only
 * bounds recompute cost; it cannot serve stale rules to a later delivery.
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

    // 4) rules-injector: compose only sources whose identity differs from the
    //    per-session source ledger. Filtering happens before budget packing, so
    //    already-delivered ancestors cannot crowd out a new local rule. A second
    //    guard records the composed block itself: when every applicable rule is
    //    over budget the block carries only the contextIncomplete notice and
    //    `included` stays empty, so the source ledger alone would re-send the
    //    same notice on every read/edit of that path.
    if (hookEnabled(cfg, 'rules-injector') && cfg.rulesInjector && (name === 'edit' || name === 'read') && abs) {
      try {
        const session = exec.agent?.session
        const led = session && typeof session === 'object' ? ledgerFor(session) : null
        const pkg = ruleContextForTargets(ws, [fileRel ?? ''], led ? { skip: (e) => ledgerSkips(led, e) } : {})
        const fresh = pkg.block.trim().length > 0 && (led === null || !blockDelivered(led, pkg.targets, pkg.hash))
        if (fresh) {
          extra.push(ctxMessage(pkg.block))
          if (led && session && typeof session === 'object') {
            recordBlockDelivered(led, pkg.targets, pkg.hash)
            recordDelivered(session, pkg.included)
          }
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
