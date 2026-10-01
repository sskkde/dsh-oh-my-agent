/**
 * sessionModel — 会话级模式（模式 ↔ 模型 ↔ 写门）：Prometheus 规划态与
 * Atlas 执行态，以及 pre-step 自动切换的意图扫描。
 *
 * ## 机制（不依赖宿主私有 API，走会话日志这个官方接缝）
 *
 * 会话每次请求的 seed config 来自会话日志最后一个 `request/header` 的 config
 * （dsh-agent-loop `buildRequest` → `requestProposal(persistedHeader)`），且宿主的
 * agent 级 model-selection（`selectionFor.current`）也优先读同一日志。因此切换
 * 模型 = 在 **open turn 内** 向会话日志追加一条 `request/header {header:{config}}`
 * 事件——宿主自己的两条瀑布（system-prompt/assemble 快照 + agent/request 覆盖）会
 * 自动把该 provider/model 应用到后续每一次请求。还原 = 追回切换前快照（无快照时
 * 用会话默认 selection）。
 *
 * ## 三态
 *   off        —— 默认态（会话自身模型，写门开）
 *   prometheus —— 规划态（/omo-ulw-plan）：规划模型 + 写入门（read-only-gate 动态段）
 *   atlas      —— 执行态（/omo-start-work）：Atlas 模型 + `omo:atlas-execution` 注入段 + 写门开
 *   ultrawork  —— auto-return to off（退出规划态；不换指挥，对齐原版语义）
 *
 * `pre`（切换前最后一个 request/header 的 config）只在 off→非 off 时快照一次，
 * prometheus↔atlas 互转不重取——还原时回到最初的默认模型。
 *
 * 注意：
 * - `request/header` 受 dsh-session 不变量约束（invariant.js: `request/header`
 *   appended outside any open turn → fail）。本模块的调用方（agent/pre-step、
 *   工具 execute）都在 turn 内，满足约束；仍对追加失败做防御（ok:false，不静默）。
 * - 生效时序与官方 `session.selectModel` 同语义：**从切换后的下一次请求生效**。
 * - 不写 settings 全局默认（那是 apiproxy selectModel 的行为），粒度=当前会话。
 * - 模式通过 omo/session-mode 事件持久化并由 omo-session-mode 投影读取；WeakMap 仅作投影不可读时的兼容回退。
 */

import { z } from 'zod'
import { findRole, type AgentRole } from './agents.js'
import { resolveRoleRoute, DEFAULT_ROUTES, type DelegateRoutes } from './delegate.js'

export type SessionMode = 'off' | 'prometheus' | 'atlas'

const SESSION_MODE_EVENT = 'omo/session-mode'
const SESSION_MODE_PROJECTION = 'omo-session-mode'

/**
 * Host `sessionProjections` service, re-read at call time.
 * There is no public `session.projections.get()` API (`Session.projections` is a
 * private message-projection field), so durability must come from this service —
 * bound once from the plugin's nested `inject(['sessionProjections'], …)`.
 */
let projectionHost: { stateOf?: (session: unknown, key: string) => unknown } | null = null

/** Bind the host projection service so the durable mode survives process restarts. */
export function bindProjectionHost(service: unknown): void {
  projectionHost = (service as { stateOf?: (session: unknown, key: string) => unknown } | null) ?? null
}

export function sessionModeProjectionUnit(): Record<string, unknown> {
  return {
    key: SESSION_MODE_PROJECTION,
    stateVersion: 1,
    stateSchema: z.object({ mode: z.union([z.literal('off'), z.literal('prometheus'), z.literal('atlas')]) }),
    init: () => ({ mode: 'off' }),
    apply: (state: { mode: SessionMode }, event: { type: string; data: { mode: SessionMode } }) =>
      event.type === SESSION_MODE_EVENT ? { mode: event.data.mode } : state,
    wire: { viewSchema: z.object({ mode: z.string() }), view: (state: { mode: SessionMode }) => ({ mode: state.mode }) },
  }
}

export interface ModelConfig {
  provider: string
  model: string
  reasoningEffort?: string
}

type AnyObj = Record<string, unknown>

/** 角色 → 委托通道规格（镜像 delegate.ts 的 CHANNEL_BY_DSH_TOOL）。
 *  route 解析只消费 tier（兜底档位）；原生通道工具名仅信息性。 */
function channelSpecOf(role: AgentRole): { id: string; nativeTool: string; tier: 'flash' | 'heavy'; readOnly: boolean } {
  const heavy = role.dshTool !== 'subagent_default'
  return { id: 'delegate', nativeTool: `delegate_as(role=${role.name})`, tier: heavy ? 'heavy' : 'flash', readOnly: false }
}

let prometheusRole: AgentRole | undefined
function roleOf(name: string): AgentRole | undefined {
  if (name === 'prometheus') {
    if (!prometheusRole) prometheusRole = findRole('prometheus')
    return prometheusRole
  }
  return findRole(name)
}

/**
 * 角色路由解析（复用 delegate_as 的三级路由）：
 *   delegate_roles.<role> > categories.<role.category> > 档位兜底（heavy/flash）。
 * 规划模型 = prometheus 角色；执行模型 = atlas 角色。
 */
export function roleModelRoute(roleName: string, merged?: Record<string, unknown>, routes?: DelegateRoutes): ModelConfig & { source: string } {
  const role = roleOf(roleName)
  if (!role) return { provider: 'volces', model: 'glm-5.3', source: `fallback:no-${roleName}-role` }
  const resolved = resolveRoleRoute(role, channelSpecOf(role), routes ?? DEFAULT_ROUTES, merged)
  return { provider: resolved.provider, model: resolved.model, source: resolved.source }
}

/** 规划模型 = prometheus 角色路由（保留旧名，供既有调用方）。 */
export function prometheusPlanRoute(merged?: Record<string, unknown>, routes?: DelegateRoutes): ModelConfig & { source: string } {
  return roleModelRoute('prometheus', merged, routes)
}

/* ─────────────────────────── per-session state ─────────────────────────── */

interface SessionModeState {
  mode: SessionMode
  /** 切换前最后一个 request/header 的 config（还原用）；无日志时 null。 */
  pre: ModelConfig | null
}

const states = new WeakMap<object, SessionModeState>()

interface SessionLike {
  append(type: string, data: AnyObj, opts?: AnyObj): unknown
  requestHeader(): { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined
}

function sessionOf(agent: unknown): SessionLike | null {
  const s = (agent as { session?: unknown } | undefined)?.session
  if (!s || typeof s !== 'object') return null
  return s as SessionLike
}

function readConfig(header: { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined): ModelConfig | null {
  const c = header?.config
  if (!c || typeof c.provider !== 'string' || !c.provider || typeof c.model !== 'string' || !c.model) return null
  return {
    provider: c.provider,
    model: c.model,
    ...typeof c.reasoningEffort === 'string' && c.reasoningEffort ? { reasoningEffort: c.reasoningEffort } : {},
  }
}

function sameRoute(a: ModelConfig | null, b: ModelConfig | null): boolean {
  if (!a || !b) return false
  return a.provider === b.provider && a.model === b.model
}

/** Durable mode event is additive: a failed append keeps the in-process state authoritative. */
function appendModeEvent(session: SessionLike, mode: SessionMode): boolean {
  try { session.append(SESSION_MODE_EVENT, { mode }); return true } catch { return false }
}

/** 当前会话模式（无状态视为 off）。 */
export function sessionModeOf(agent: unknown): SessionMode {
  const s = sessionOf(agent)
  if (!s) return 'off'
  // In-process state wins: it is also the only record when the durable append failed.
  const local = states.get(s)?.mode
  if (local !== undefined) return local
  // No in-process state (fresh process / restored session) -> read the durable projection.
  // Any absent, malformed or throwing read keeps the pre-projection behavior (off).
  try {
    const projected = projectionHost?.stateOf?.(s, SESSION_MODE_PROJECTION) as { mode?: unknown } | undefined
    if (projected && (projected.mode === 'off' || projected.mode === 'prometheus' || projected.mode === 'atlas')) return projected.mode
  } catch { /* fall through to off */ }
  return 'off'
}

export function isSessionMode(agent: unknown, mode: SessionMode): boolean {
  return sessionModeOf(agent) === mode
}

/** 规划写入门判定源：仅 prometheus 规划态生效（hooks.ts read-only-gate 动态段）。 */
export function isPlanningActive(agent: unknown): boolean {
  return isSessionMode(agent, 'prometheus')
}

export interface SessionSwitchResult {
  ok: boolean
  mode?: SessionMode
  route?: ModelConfig
  source?: string
  reason?: string
}

/**
 * 切换会话模式。off→非 off：快照 pre 并 append 目标路由；非 off→off：append pre
 * （或会话默认）；prometheus↔atlas：pre 不变，直接 append 目标路由。目标路由与
 * 当前 header 相同则只改状态不追加。追加失败返回 ok:false。
 */
export async function setSessionMode(
  agent: unknown,
  mode: SessionMode,
  route?: ModelConfig,
  defaultsRoute?: ModelConfig,
): Promise<SessionSwitchResult> {
  const s = sessionOf(agent)
  if (!s) return { ok: false, reason: '无会话上下文（agent.session 不可用）' }
  const prev = states.get(s)
  const currentMode = sessionModeOf(agent)

  if (mode === 'off') {
    if (currentMode === 'off') return { ok: true, mode: 'off', reason: '当前不在激活态（无操作）' }
    const revert = prev?.pre ?? defaultsRoute
    if (!revert) {
      states.delete(s)
      return { ok: false, reason: '无法还原：无切换前快照且无会话默认 selection' }
    }
    if (!sameRoute(readConfig(s.requestHeader()), revert)) {
      try {
        s.append('request/header', { header: { config: revert }, reason: 'change' })
      } catch (e) {
        return { ok: false, reason: `还原会话模型失败（request/header 追加被拒）：${String(e)}` }
      }
    }
    // Only drop the in-process record when the durable 'off' event landed; otherwise
    // the projection would still replay the previous mode after a restart.
    if (appendModeEvent(s, 'off')) states.delete(s)
    else states.set(s, { mode: 'off', pre: prev?.pre ?? null })
    return { ok: true, mode: 'off', route: revert }
  }

  // prometheus | atlas
  if (currentMode === mode) return { ok: true, mode, route, reason: '已处于该模式（无操作）' }
  if (!route) return { ok: false, reason: `切换 ${mode} 模式缺少目标路由` }
  // pre 只在 off→非 off 时快照一次；模式互转保留最初的 pre
  const pre = prev?.pre ?? readConfig(s.requestHeader())
  if (!sameRoute(readConfig(s.requestHeader()), route)) {
    try {
      s.append('request/header', { header: { config: route }, reason: 'change' })
    } catch (e) {
      return { ok: false, reason: `切换会话模型失败（request/header 追加被拒）：${String(e)}` }
    }
  }
  states.set(s, { mode, pre })
  appendModeEvent(s, mode)
  return { ok: true, mode, route }
}

/* ─────────────────────────── pre-step 意图扫描 ─────────────────────────── */

/**
 * 从 agent/pre-step 的 decision.messages 里识别会话模式切换意图：
 * - skill-invocation 注入（/xxx 手势路径；dsh-tool-skill 已把完整技能正文注入本步
 *   消息，其 source 带技能名）
 * - 模型调用 `skill` 工具（无斜杠路径：本步消息含 tool-call 块，name='skill'，
 *   arguments.name 指向技能名）
 * 只扫描本 step 的消息（preStep 的 inbox.claim 只含本步新增），不会翻历史误触发。
 *
 * 映射：omo-ulw-plan → prometheus（规划态）；omo-start-work → atlas（执行态）；
 * omo-ultrawork → off（自动退出规划态；不换指挥，对齐原版 ultrawork 语义）；
 * omo-sisyphus / omo-cancel-ultrawork → off（显式回到默认模式 / 中止自主循环）。
 */
export function sessionModeIntentOf(decision: AnyObj): { mode: SessionMode } | null {
  const messages = Array.isArray(decision.messages) ? decision.messages : []
  for (const raw of messages) {
    const msg = raw as AnyObj
    const src = msg.source as AnyObj | undefined
    if (src && src.kind === 'skill-invocation' && typeof src.name === 'string') {
      const mode = modeOfSkill(src.name)
      if (mode) return { mode }
    }
    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const b of blocks) {
      const blk = b as AnyObj
      if (blk.type !== 'tool-call' || blk.name !== 'skill') continue
      const args = typeof blk.arguments === 'string' ? tryParseArgs(blk.arguments) : blk.arguments
      const name = (args as AnyObj | undefined)?.name
      if (typeof name === 'string') {
        const mode = modeOfSkill(name)
        if (mode) return { mode }
      }
    }
  }
  return null
}

function modeOfSkill(name: string): SessionMode | null {
  if (name === 'omo-ulw-plan') return 'prometheus'
  if (name === 'omo-start-work') return 'atlas'
  if (name === 'omo-ultrawork' || name === 'omo-sisyphus' || name === 'omo-cancel-ultrawork') return 'off'
  return null
}

function tryParseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}