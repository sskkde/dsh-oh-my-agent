/**
 * delegate_as — Tier-2 角色委托（OmO `task(subagent_type=...)` / `call_omo_agent`
 * 手感的 DSH 实现）。
 *
 * 原版 OmO 在 OpenCode 里由框架从 agent 注册表自动装载角色人设；DSH 的委托面是
 * 固定具名工具（subagent_default/deep/librarian/review/oracle），没有参数化角色
 * 通道。此前流程要两步：omo_agents brief 生成简报 → 编排者手动拼进 prompt。
 * 本模块把两步合一：
 *
 *   查角色表(AGENT_ROLES) → 组装简报(buildBrief+补充) → ctx.subagents 直接派生
 *   → 后台返回 durable id / 前台等待回收最终报告。
 *
 * 通道与档位镜像本部署 agent preset（cordis-delegate）的 tier 配置：
 *   flash = opencode-go/deepseek-v4-flash（default/librarian/review）
 *   heavy = volces/glm-5.3（deep/oracle）
 * 只读通道（librarian/review/oracle）经 request.toolFilter 硬禁 write/edit ——
 * 这是宿主级强制，不是提示词软纪律。
 */

import { findRole, buildBrief, type AgentRole } from './agents.js'
import { configForCategory } from './modelRoute.js'

export interface DelegateRoutes {
  /** 子代理服务里的 provider 名（spawn-in-process 注册名）。 */
  provider: string
  /** 快档路由 "provider/model"。 */
  flash: string
  /** 重档路由 "provider/model"。 */
  heavy: string
}

export const DEFAULT_ROUTES: DelegateRoutes = {
  provider: 'spawn',
  flash: 'opencode-go/deepseek-v4-flash',
  heavy: 'volces/glm-5.3',
}

interface ChannelSpec {
  id: string
  /** 等价的宿主具名工具（信息性）。 */
  nativeTool: string
  tier: 'flash' | 'heavy'
  readOnly: boolean
}

/** AGENT_ROLES.dshTool → 通道规格。 */
const CHANNEL_BY_DSH_TOOL: Record<string, ChannelSpec> = {
  subagent_default: { id: 'default', nativeTool: 'delegate_as(role=default)', tier: 'flash', readOnly: false },
  subagent_librarian: { id: 'librarian', nativeTool: 'delegate_as(role=librarian)', tier: 'flash', readOnly: true },
  subagent_review: { id: 'review', nativeTool: 'delegate_as(role=review)', tier: 'flash', readOnly: true },
  subagent_deep: { id: 'deep', nativeTool: 'delegate_as(role=deep)', tier: 'heavy', readOnly: false },
  subagent_oracle: { id: 'oracle', nativeTool: 'delegate_as(role=oracle)', tier: 'heavy', readOnly: true },
}

/** 不可经子代理派发的角色及原因（如实拒绝，不硬造通道）。 */
const BLOCKED_ROLES: Record<string, string> = {
  sisyphus: 'sisyphus 是主会话本体（你自己），没有可派发的子代理——按其角色纪律直接在主会话执行',
  'multimodal-looker': '视觉通道不是子代理：先用 omo_look_at 生成意图化提问，再调 describe_image/read_image',
}

/** 解析 "provider/model" 路由串；格式非法时回退默认档位。 */
function parseRoute(route: string, fallback: { provider: string; model: string }): { provider: string; model: string } {
  const idx = route.indexOf('/')
  if (idx <= 0 || idx === route.length - 1) return fallback
  return { provider: route.slice(0, idx), model: route.slice(idx + 1) }
}

/** 角色系统层 persona（短）：身份 + 纪律 + 证据协议。 */
export function rolePersona(role: AgentRole): string {
  return (
    `${role.title}（${role.name}）。${role.mission}。` +
    `纪律：${role.must.join('；')}。` +
    '协议 - 开工前声明 STOP WHEN 与 EVIDENCE；以证据收尾，禁止自报完成。'
  )
}

/** 完整委托 prompt：标准简报 + 编排者本次补充 + 自包含环境说明。 */
export function composeDelegationPrompt(
  role: AgentRole,
  task: string,
  files: string[],
  extras: string,
  modelCfg: Record<string, unknown>,
): string {
  let p = buildBrief(role, task, files, modelCfg)
  const ext = extras.trim()
  if (ext) p += `\n\n## 本次补充（编排者追加；与通用纪律冲突时按更窄者执行）\n${ext}`
  p += '\n\n## 执行环境\n你在独立上下文中运行，看不到母对话；以上简报自包含。收尾只输出最终报告（含 EVIDENCE），不要反问编排者。'
  return p
}

export interface ChannelResolution {
  ok: boolean
  role?: AgentRole
  spec?: ChannelSpec
  reason?: string
}

/** 角色 → 通道解析：查表、拦不可派发角色、校验 dshTool 映射存在。 */
export function resolveChannel(roleName: string): ChannelResolution {
  const role = findRole(roleName)
  if (!role) {
    const names = ['sisyphus', 'prometheus', 'atlas', 'oracle', 'librarian', 'explore', 'metis', 'momus', 'hephaestus', 'multimodal-looker', 'sisyphus-junior']
    return { ok: false, reason: `unknown role "${roleName}" - 可选：${names.join(', ')}` }
  }
  const blocked = BLOCKED_ROLES[role.name]
  if (blocked) return { ok: false, reason: blocked }
  const spec = CHANNEL_BY_DSH_TOOL[role.dshTool]
  if (!spec) return { ok: false, reason: `role "${role.name}" 的 dshTool "${role.dshTool}" 不是可派发通道` }
  return { ok: true, role, spec }
}

/* ── 子代理服务松类型（编译期不依赖 @deepseek-ai/dsh-subagent）──────── */

interface SubagentResult { stopReason: string; output: Array<{ type: string; text?: string }> }
interface SubagentRun { id: string; result: Promise<SubagentResult>; dispose: () => unknown }
interface SubagentsService {
  start(provider: string, request: Record<string, unknown>): Promise<SubagentRun>
  startContinuable?(spec: Record<string, unknown>): Promise<{ childId: string }>
}

export interface DelegationRequest {
  role: AgentRole
  spec: ChannelSpec
  prompt: string
  label: string
  parent: unknown
  signal: AbortSignal
  routes: DelegateRoutes
  /** 分层 omo.jsonc 合并结果（三级路由解析的第 1/2 级数据源；缺省时仅走档位默认）。 */
  merged?: Record<string, unknown>
}

export interface DelegationOutcome {
  mode: 'continuable' | 'foreground'
  subagentId?: string
  runId?: string
  stopReason?: string
  output?: string
  error?: string
}

/** 非 completed 停止原因视为未干净收尾（镜像 dsh-tool-subagent 语义）。 */
function stopReasonError(stopReason: string): string | undefined {
  switch (stopReason) {
    case 'completed': return undefined
    case 'aborted': return '子代理运行被取消'
    case 'error': return '子代理运行失败'
    case 'max-tokens': return '子代理在完成前触及 token 上限'
    case 'refusal': return '子代理拒绝了任务'
    default: return `子代理异常结束 (${String(stopReason)})`
  }
}

function outputText(output: Array<{ type: string; text?: string }>): string {
  return (output ?? [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text))
    .join('')
}

/** 严格的角色路由字面量：'provider/model' 字符串或 {provider,model} 对象；缺失/非法返回 null。 */
export function parseRoleRoute(v: unknown): { provider: string; model: string } | null {
  if (typeof v === 'string') {
    const idx = v.indexOf('/')
    if (idx <= 0 || idx === v.length - 1) return null
    const provider = v.slice(0, idx).trim()
    const model = v.slice(idx + 1).trim()
    if (!provider || !model) return null
    return { provider, model }
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    const provider = typeof o.provider === 'string' ? o.provider.trim() : ''
    const model = typeof o.model === 'string' ? o.model.trim() : ''
    if (!provider || !model) return null
    return { provider, model }
  }
  return null
}

export interface RoleRouteResolution {
  provider: string
  model: string
  /** 命中层级：delegate_roles:<role> | categories:<category> | tier:<flash|heavy> */
  source: string
}

/**
 * 每角色三级路由解析（优先级从高到低）：
 *   1. [opencode].delegate_roles.<role.name>   —— omo.jsonc 单角色显式覆盖
 *   2. [opencode].categories.<role.category>   —— 决策层 category 配置
 *   3. flash/heavy 档默认                       —— 既有 DelegateRoutes 行为兜底
 * 注：宿主 spawn 接缝只消费 provider/model（maxTokens 由父继承），reasoning 不在此透传。
 */
export function resolveRoleRoute(role: AgentRole, spec: ChannelSpec, routes: DelegateRoutes, merged?: Record<string, unknown>): RoleRouteResolution {
  const oc = ((merged?.opencode ?? merged?.['[opencode]']) ?? {}) as Record<string, unknown>
  const dr = oc.delegate_roles
  if (dr !== null && typeof dr === 'object' && !Array.isArray(dr)) {
    const hit = parseRoleRoute((dr as Record<string, unknown>)[role.name])
    if (hit) return { ...hit, source: `delegate_roles:${role.name}` }
  }
  const catCfg = configForCategory(merged ?? {}, role.category)
  if (catCfg.chosen) return { provider: catCfg.chosen.provider, model: catCfg.chosen.model, source: `categories:${role.category}` }
  const fallback = spec.tier === 'heavy'
    ? parseRoute(routes.heavy, { provider: 'volces', model: 'glm-5.3' })
    : parseRoute(routes.flash, { provider: 'opencode-go', model: 'deepseek-v4-flash' })
  return { ...fallback, source: `tier:${spec.tier}` }
}

/** 组装 SubagentRequest（persona 系统层注入 + 只读通道硬禁写）。 */
export function buildSubagentRequest(req: DelegationRequest): Record<string, unknown> {
  const resolved = resolveRoleRoute(req.role, req.spec, req.routes, req.merged)
  return {
    label: req.label,
    prompt: [{ type: 'text', text: req.prompt }],
    parent: req.parent,
    agentOptions: { provider: resolved.provider, model: resolved.model },
    persona: rolePersona(req.role),
    ...(req.spec.readOnly ? { toolFilter: { deny: ['write', 'edit'] } } : {}),
  }
}

/**
 * 执行一次委托：默认走 continuable（立即返回 durable 子代理 id，结算后运行时
 * 通知母会话）；foreground=true 时等待回收最终文本并释放 run。
 */
export async function runDelegation(subagents: SubagentsService, req: DelegationRequest, foreground: boolean): Promise<DelegationOutcome> {
  const request = buildSubagentRequest(req)
  if (!foreground) {
    if (typeof subagents.startContinuable !== 'function') {
      return { mode: 'continuable', error: '当前 subagents 服务不支持 continuable 派生 —— 请改 foreground=true 同步等待' }
    }
    try {
      const r = await subagents.startContinuable({ provider: req.routes.provider, label: req.label, request, signal: req.signal })
      return { mode: 'continuable', subagentId: r.childId }
    } catch (e) {
      return { mode: 'continuable', error: `continuable 派生失败：${String(e)}` }
    }
  }
  try {
    const run = await subagents.start(req.routes.provider, { ...request, signal: req.signal })
    let result: SubagentResult
    try {
      result = await run.result
    } catch (e) {
      return { mode: 'foreground', runId: String(run.id), error: String(e) }
    }
    const headline = stopReasonError(result.stopReason)
    const partial = outputText(result.output)
    try { await run.dispose() } catch (e) {
      if (headline === undefined) return { mode: 'foreground', runId: String(run.id), stopReason: result.stopReason, error: `dispose 失败：${String(e)}` }
    }
    if (headline !== undefined) {
      return {
        mode: 'foreground',
        runId: String(run.id),
        stopReason: result.stopReason,
        error: partial ? `${headline}\n结束前的部分输出：\n${partial}` : headline,
        ...(partial ? { output: partial } : {}),
      }
    }
    return { mode: 'foreground', runId: String(run.id), stopReason: result.stopReason, output: partial }
  } catch (e) {
    return { mode: 'foreground', error: `派生失败：${String(e)}` }
  }
}

/** 从宿主 ctx 取 subagents 服务（缺失时返回 null，调用方给明确错误）。 */
export function getSubagentsService(ctx: unknown): SubagentsService | null {
  const c = ctx as { get?: (k: string) => unknown; subagents?: unknown } | null | undefined
  if (!c) return null
  const svc = (typeof c.get === 'function' ? c.get('subagents') : undefined) ?? c.subagents
  if (svc && typeof (svc as SubagentsService).start === 'function') return svc as SubagentsService
  return null
}

/** 供 omo_status 展示的通道清单。 */
export function delegateChannelsSummary(routes: DelegateRoutes): string[] {
  return Object.values(CHANNEL_BY_DSH_TOOL).map((s) => `${s.nativeTool}[tier=${s.tier}${s.readOnly ? ' ro' : ''}] -> ${s.tier === 'heavy' ? routes.heavy : routes.flash}`)
}
