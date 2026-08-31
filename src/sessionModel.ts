/**
 * sessionModel — Prometheus 规划态：主会话模型切换（规划模型 ↔ 会话默认）与
 * 规划写入门（read-only-gate 动态段）的判定源。
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
 * 注意：
 * - `request/header` 受 dsh-session 不变量约束（invariant.js: `request/header`
 *   appended outside any open turn → fail）。本模块的调用方（agent/pre-step、
 *   工具 execute）都在 turn 内，满足约束；仍对追加失败做防御（ok:false，不静默）。
 * - 生效时序与官方 `session.selectModel` 同语义：**从切换后的下一次请求生效**。
 *   对 skill 注入路径，注入发生在 pre-step（assemble 之前），但宿主 selection 的
 *   快照在 assemble 时读取——故本步第 1 个请求仍走旧模型，同 turn 后续 step 及
 *   后续 turn 走规划模型。
 * - 不写 settings 全局默认（那是 apiproxy selectModel 的行为），粒度=当前会话。
 * - 进程重启后覆盖态丢失（日志中的规划 header 仍在，但写入门重新打开）；重新
 *   调用 /omo-ulw-plan 即重新进入。
 */

import { findRole, type AgentRole } from './agents.js'
import { resolveRoleRoute, DEFAULT_ROUTES, type DelegateRoutes } from './delegate.js'

export interface ModelConfig {
  provider: string
  model: string
  reasoningEffort?: string
}

export type PlanningIntent = 'on' | 'off'

type AnyObj = Record<string, unknown>

/** Prometheus 角色在三级路由里的通道规格（tier=heavy 兜底到重档）。 */
const PLAN_SPEC = { id: 'plan', nativeTool: 'omo_session_model', tier: 'heavy', readOnly: true } as const

let prometheusRole: AgentRole | undefined
function roleOf(): AgentRole | undefined {
  if (!prometheusRole) prometheusRole = findRole('prometheus')
  return prometheusRole
}

/**
 * 规划模型 = Prometheus 角色路由（复用 delegate_as 的三级解析）：
 *   delegate_roles.prometheus > categories.<deep> > heavy 档兜底。
 */
export function prometheusPlanRoute(merged?: Record<string, unknown>, routes?: DelegateRoutes): ModelConfig & { source: string } {
  const role = roleOf()
  if (!role) return { provider: 'volces', model: 'glm-5.3', source: 'fallback:no-prometheus-role' }
  const resolved = resolveRoleRoute(role, PLAN_SPEC, routes ?? DEFAULT_ROUTES, merged)
  return { provider: resolved.provider, model: resolved.model, source: resolved.source }
}

/* ─────────────────────────── per-session state ─────────────────────────── */

interface PlanningState {
  active: boolean
  /** 切换前最后一个 request/header 的 config（还原用）；无日志时 null。 */
  pre: ModelConfig | null
}

const states = new WeakMap<object, PlanningState>()

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

/** 规划写入门判定源：该会话当前是否处于规划态。 */
export function isPlanningActive(agent: unknown): boolean {
  const s = sessionOf(agent)
  if (!s) return false
  return states.get(s)?.active ?? false
}

export interface PlanningSwitchResult {
  ok: boolean
  active?: boolean
  route?: ModelConfig
  source?: string
  reason?: string
}

/**
 * 开/关规划态。开：快照当前 header，把会话日志的 request/header 换成规划模型
 * （若已同路由则只记状态不追加）；关：追回快照或会话默认。追加失败返回 ok:false。
 */
export async function setPlanning(
  agent: unknown,
  active: boolean,
  planRoute: ModelConfig,
  defaultsRoute?: ModelConfig,
): Promise<PlanningSwitchResult> {
  const s = sessionOf(agent)
  if (!s) return { ok: false, reason: '无会话上下文（agent.session 不可用）' }
  const prev = states.get(s)

  if (active) {
    if (prev?.active) return { ok: true, active: true, route: planRoute }
    const pre = readConfig(s.requestHeader())
    if (!sameRoute(pre, planRoute)) {
      try {
        s.append('request/header', { header: { config: planRoute }, reason: 'change' })
      } catch (e) {
        return { ok: false, reason: `切换会话模型失败（request/header 追加被拒）：${String(e)}` }
      }
    }
    states.set(s, { active: true, pre })
    return { ok: true, active: true, route: planRoute }
  }

  if (!prev?.active) return { ok: true, active: false, reason: '当前不在规划态（无操作）' }
  const revert = prev.pre ?? defaultsRoute
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
  states.delete(s)
  return { ok: true, active: false, route: revert }
}

/* ─────────────────────────── pre-step 意图扫描 ─────────────────────────── */

/**
 * 从 agent/pre-step 的 decision.messages 里识别规划态切换意图：
 * - skill-invocation 注入（/omo-ulw-plan 手势路径；dsh-tool-skill 已把完整技能
 *   正文注入本步消息，其 source 带技能名）
 * - 模型调用 `skill` 工具（无斜杠路径：本步消息含 tool-call 块，name='skill'，
 *   arguments.name 指向技能名）
 * 只扫描本 step 的消息（preStep 的 inbox.claim 只含本步新增），不会翻历史误触发。
 */
export function planningIntentOf(decision: AnyObj): PlanningIntent | null {
  const messages = Array.isArray(decision.messages) ? decision.messages : []
  for (const raw of messages) {
    const msg = raw as AnyObj
    const src = msg.source as AnyObj | undefined
    if (src && src.kind === 'skill-invocation' && typeof src.name === 'string') {
      const intent = intentOfSkill(src.name)
      if (intent) return intent
    }
    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const b of blocks) {
      const blk = b as AnyObj
      if (blk.type !== 'tool-call' || blk.name !== 'skill') continue
      const args = typeof blk.arguments === 'string' ? tryParseArgs(blk.arguments) : blk.arguments
      const name = (args as AnyObj | undefined)?.name
      if (typeof name === 'string') {
        const intent = intentOfSkill(name)
        if (intent) return intent
      }
    }
  }
  return null
}

function intentOfSkill(name: string): PlanningIntent | null {
  if (name === 'omo-ulw-plan') return 'on'
  if (name === 'omo-start-work' || name === 'omo-ultrawork') return 'off'
  return null
}

function tryParseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}