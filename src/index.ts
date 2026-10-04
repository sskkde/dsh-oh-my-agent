/**
 * dsh-oh-my-agent — 忠实复刻 oh-my-openagent (OmO) 核心能力的 DSH 插件。
 *
 * Host half: registers 22 agent tools (status, rules engine, boulder notepad,
 * memory, hashline editor, structured code search, comment checker, background
 * monitors, ultrawork conductor, handoff, team task table, layered config,
 * codegraph, lsp, model routing, planning-mode session switch, hooks
 * introspection, agent roster/briefs, context7 docs, look-at orchestrator,
 * dynamic SKILL.md loader), 18 runtime skills (ultrawork / start-work / ulw-plan
 * / rules / handoff / memory / model-routing / subagent-roles / deliver /
 * hyperplan / refactor / remove-ai-slops / debugging / review-work / init-deep
 * / git-master / sisyphus-return / cancel-ultrawork), and a JSON API for the
 * client panel (/dsh-oh-my-agent/api/*).
 *
 * Session modes (Plugin source): /omo-ulw-plan → prometheus planning mode
 * (model = prometheus role route, write gate closed to plan artifacts);
 * /omo-start-work → atlas execution mode (model = atlas role route, atlas
 * discipline section injected, gate open); /omo-ultrawork → auto-exit planning
 * and /omo-sisyphus / /omo-cancel-ultrawork → return to default (revert, no
 * agent switch); cancel also clears the boulder activePlan watermark.
 * Manual fallback tool: omo_session_model.
 *
 * Ultrawork Oracle verification gate: a completion claim (<promise>…</promise>,
 * not VERIFIED) left in the session log is detected at pre-step and a mandatory
 * independent Oracle verification notice is injected until VERIFIED clears it.
 *
 * Everything an agent-facing tool persists lands under `<workspace>/.omo/`
 * (the same state-dir convention OmO uses).
 */

import type { Context } from '@deepseek-ai/cordis'
// side-effect: pull in the webServer augmentation for the host runtime
import '@deepseek-ai/dsh-host-webserver'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from 'schemastery'

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { text, PLUGIN_ID, ensureDir, resolveWorkspace, nowTs, omoDir, stripUndefined, writeState } from './util.js'
import { scanRules, refreshRulesState } from './rules.js'
import { ruleContextForTargets } from './projectContext.js'
import { boulderSummary, listNotes, appendNote, updateNote, newThreadBoulder, checkpointBoulder, isSection, SECTIONS, loadBoulder, saveBoulder } from './boulder.js'
import { applyHashlineEdits, describeLines, type HashEdit } from './hashline.js'
import { structuredSearch, astRewrite, astGrepScan } from './codeSearch.js'
import { checkComments } from './commentCheck.js'
import { runCodegraph } from './codegraph.js'
import { LspServerManager, serverAvailability } from './lsp.js'
import { resolveCategory, routeLabel, CATEGORIES, CATEGORY_ROLES, DEFAULT_CHAINS, type Category } from './modelRoute.js'
import { AGENT_ROLES, findRole, buildBrief, buildTeamPlan } from './agents.js'
import { resolveChannel, composeDelegationPrompt, getSubagentsService, runDelegation, resolveRoleRoute, DEFAULT_ROUTES, CHANNEL_BY_DSH_TOOL, parseRoleRoute, type DelegateRoutes } from './delegate.js'
import { docsSearch, docsGet } from './docs.js'
import { lookAt, LOOK_INTENTS } from './lookAt.js'
import { registerSkills, listRegistered } from './dynamicSkills.js'
import { omoPreExecute, omoPostExecute, hooksStatus, nestedDelegationGuard, registerPerAgentGuard, isDelegationTool, hooksConfigFor, sessionRulesBlockFor, type ExecLike, type HooksConfig } from './hooks.js'
import { roleModelRoute, prometheusPlanRoute, sessionModeIntentOf, setSessionMode, sessionModeOf, sessionModeProjectionUnit, bindProjectionHost, type SessionMode, type ModelConfig } from './sessionModel.js'
import { buildPlanReviewQuestion, goalFromPlan, interpretPlanReviewAnswer, validatePlanMarkdown } from './planReview.js'
import { ATLAS_SECTION } from './atlasPrompt.js'
import { OMO_MESSAGE_KIND } from './messageSource.js'
import * as mem from './memory.js'
import { MonitorRegistry } from './monitor.js'
import { createUltraPlan, updateUltraPhase, ultraworkPhaseText, readUltraPlan, recordWaveProgress, type UltraPhase, type Wave } from './ultrawork.js'
import { buildHandoff } from './handoff.js'
import { skillRegistrations } from './skills.js'
import { SISYPHUS_SECTION } from './sisyphusPrompt.js'
import { PROMETHEUS_SECTION } from './prometheusPrompt.js'
import { loadTasks, saveTasks, type TaskRow } from './teamTask.js'
import { loadLayeredConfig, mergedTools, mergedToggle, loadUserConfig, userRoutesFile, workspaceRoutesFile, readRoutesLayer, writeRoutesLayer, routesLayerExists } from './omoconfig.js'
import { GoalGuard, countRunningChildren, type GoalsServiceLike, type SubagentRowLike } from './goalGuard.js'

export const name = PLUGIN_ID
// 'systemPrompt' is optional at runtime: hosts without dsh-system-prompt still
// load (the registration below guards on its presence).
export const inject = ['tools', 'skills', 'webServer', 'systemPrompt']

export interface Config {
  defaultWorkspace: string
  workspaceHints: string[]
  delegateProvider: string
  delegateFlashRoute: string
  delegateHeavyRoute: string
  /** Main-session system-prompt section mode (dsh-system-prompt channel). */
  mainPrompt: 'off' | 'sisyphus' | 'custom'
  /** Section text when mainPrompt=custom; ignored otherwise. */
  customPromptSection: string
  /** goal-guard（方案 B）：派发后台子代理期间解除 goal 自动续跑，结算后自动恢复。 */
  goalGuardOn: boolean
}

export const Config = z.object({
  defaultWorkspace: z.string().default(''),
  workspaceHints: z.array(z.string()).default([]),
  // delegate_as 通道档位（镜像 agent preset 的 tier 配置；可按部署覆盖）
  delegateProvider: z.string().default(DEFAULT_ROUTES.provider),
  delegateFlashRoute: z.string().default(DEFAULT_ROUTES.flash),
  delegateHeavyRoute: z.string().default(DEFAULT_ROUTES.heavy),
  // 主会话系统提示词附加段：默认注入 Sisyphus 编排纪律（见 src/sisyphusPrompt.ts）
  mainPrompt: z.union(['off', 'sisyphus', 'custom']).default('sisyphus'),
  customPromptSection: z.string().default(''),
  // goal-guard：默认开启；关闭即退回 harness 原生行为（等待窗口仍会注入 goal 轮次）
  goalGuardOn: z.boolean().default(true),
})

type AnyObj = Record<string, unknown>

/** Reachable host-service shapes (loose; plugin compiles against these). */
interface ToolsCtx { tools: { register(d: unknown): unknown; guard(g: (exec: ExecLike) => string | undefined): unknown } }
interface SkillsCtx { skills: { register(d: unknown): unknown } }
/** dsh-system-prompt service surface (loose; optional on the ctx). */
interface OptionalInjectCtx {
  inject(deps: string[], callback: (ctx: AnyObj) => void): unknown
}

interface SysPromptCtx {
  systemPrompt?: {
    section(s: { name: string; order: number; text: string | ((context: { agent?: unknown }) => string); complete?: boolean }): () => void
  }
}

/** Last-seen workspace (updated by every tool run; used by the client API). */
let lastWs = ''
/** Host ctx (set in apply) — delegate_as reads the subagents service lazily. */
let hostCtx: unknown = null

// ── goal-guard（方案 B）模块级状态 ─────────────────────────────────────
// 等待窗口内由插件在宿主服务层 disarm goal（模型工具层 pause/resume 需人类回合，
// 救不了"派发子代理期间 idle 被 goal-round-driver 反复注入"）。全部子代理结算后
// 自动 resume。见 src/goalGuard.ts。
let goalGuard: GoalGuard | null = null
let goalGuardLog: ((msg: string, warn?: boolean) => void) | null = null
let goalGuardGoals: (() => GoalsServiceLike | undefined) | null = null
/** 诊断计数器（api/goalguard 暴露；排查事件送达与决策卡点）。 */
const goalGuardDiag = {
  statusSeen: 0, statusIdleSeen: 0, goalChangeSeen: 0, idleRuns: 0,
  agentsMissing: 0, subsMissing: 0, listFails: 0, running: -1, disarms: 0, resumes: 0,
  // disarms 总数 = 派发点 disarm + 等待窗口再 disarm；下两项为分解（排查用）。
  dispatchDisarms: 0, windowDisarms: 0,
  dispatches: 0, dispatchAid: '', 
  sessionEvents: 0, sessionTurnEnds: 0, sessionSettled: 0, sessionKinds: [] as string[],
  last: '',
}

/** delegate_as 派发成功（continuable）后的守卫钩子：goal armed → 立即 disarm（等待窗口不注入）。 */
function delegateGoalGuardDispatch(agent: unknown): void {
  const guard = goalGuard
  if (!guard) return
  try {
    const aid = String((agent as { id?: string } | undefined)?.id ?? '')
    if (!aid) return
    goalGuardDiag.dispatches += 1
    goalGuardDiag.dispatchAid = aid
    const svc = goalGuardGoals?.()
    const goal = svc?.get(agent)
    const mark = guard.dispatch(aid, goal)
    if (mark) {
      svc?.disarm(agent)
      guard.recordDisarm(aid, mark)
      goalGuardDiag.disarms += 1
      goalGuardDiag.dispatchDisarms += 1
      goalGuardLog?.(`[goal-guard] disarmed goal ${mark.goalId}@${mark.revision}（等待窗口不注入）`)
    }
  } catch (e) {
    goalGuardLog?.(`[goal-guard] dispatch hook failed: ${String(e)}`, true)
  }
}

/** settings namespace 注册失败原因（module-level，供 settingsMirror 暴露）。 */
let settingsNsError = ''

/** 是否存在可执行计划：.omo/plans/ 下有计划文件，或 boulder 有 activePlan（start-work 切 Atlas 的前置条件）。 */
export function hasExecutablePlan(ws: string): boolean {
  try {
    const b = loadBoulder(ws) as unknown as AnyObj
    if (b.activePlan) return true
  } catch { /* ignore */ }
  try {
    const dir = omoDir(ws, 'plans')
    if (existsSync(dir)) return readdirSync(dir).some((f) => f.endsWith('.md'))
  } catch { /* ignore */ }
  return false
}

/* ── ultrawork Oracle 验证门（系统钩子）────────────────────────── */

const PROMISE_CLAIM_RE = /<promise>((?!VERIFIED)[^<]*)<\/promise>/i

/** 扫描会话事件尾部：是否存在未经验证的完成宣称 <promise>X</promise>（X≠VERIFIED）。 */
export function hasUnverifiedUltraworkClaim(session: unknown): boolean {
  try {
    const events = (session as { events?: unknown[] } | undefined)?.events
    if (!Array.isArray(events)) return false
    let claimed = false
    let verified = false
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue
      const e = ev as { type?: string; data?: AnyObj }
      if (e.type !== 'assistant/message') continue
      const blocks = Array.isArray((e.data?.message as AnyObj | undefined)?.content) ? (e.data!.message as AnyObj).content as unknown[] : []
      for (const b of blocks) {
        const blk = b as AnyObj
        if (blk.type !== 'text' || typeof blk.text !== 'string') continue
        if (/<promise>VERIFIED<\/promise>/i.test(blk.text)) verified = true
        else if (PROMISE_CLAIM_RE.test(blk.text)) claimed = true
      }
    }
    return claimed && !verified
  } catch {
    return false
  }
}

/** 每会话每 claim 只提醒一次（claim 消解（VERIFIED）后复位）。 */
const ultraworkGateNotified = new WeakMap<object, boolean>()

const ULTRAWORK_GATE_NOTICE =
  '[OMO GATE] 系统检测到未经验证的完成宣称 <promise>…</promise>——ultrawork 循环**不会结束**。' +
  '立即执行：1) delegate_as(role=oracle, run_in_background=false) 独立验证（核对交付物/证据/验证输出，怀疑默认不完成）；' +
  '2) 仅当 Oracle 验证通过后输出 <promise>VERIFIED</promise> 结束循环；不通过则修复后重送验证。'

/** 会话默认模型 selection（agent-default-model 服务；不可用时 undefined）。 */
function defaultsSelection(): ModelConfig | undefined {
  try {
    const svc = (hostCtx as { get?: (name: string) => unknown } | null)?.get?.('agentDefaultModel') as { currentSelection?: () => ModelConfig } | undefined
    const sel = svc?.currentSelection?.()
    if (sel && typeof sel.provider === 'string' && sel.provider && typeof sel.model === 'string' && sel.model) {
      return { provider: sel.provider, model: sel.model, ...(typeof sel.reasoningEffort === 'string' && sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}) }
    }
  } catch { /* ignore */ }
  return undefined
}
/** Tool names actually registered this run (filtered by omo.jsonc toggles). */
let registeredToolNames: string[] = []
/** ctx.skills.register bound at apply() (dynamic SKILL.md loader). */
let ctxSkillsRegister: (d: unknown) => unknown = () => { /* set in apply */ }
/** Shared LSP server manager (sessions collide per <ws>::<lang>). */
const lspMgr = new LspServerManager()

function wsForConfig(config: Config, cwd?: string): string {
  const pick = cwd || lastWs || config.defaultWorkspace
  const resolved = resolveWorkspace(pick)
  lastWs = resolved
  return resolved
}

/** Resolve a workspace from the executing agent (session header cwd), else config. */
function wsFromExec(config: Config, exec: { agent?: unknown }): string {
  const agent = exec.agent as { session?: { header?: { cwd?: string }; meta?: { cwd?: string } } } | undefined
  return wsForConfig(config, agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd)
}

/** Minimal typed wrapper around defineTool (loose where nested schemas live). */
function tool(
  name: string,
  description: string,
  parameters: AnyObj,
  schema: AnyObj,
  render: (args: AnyObj, value: AnyObj) => unknown[],
  execute: (args: AnyObj, exec: { signal: AbortSignal; agent?: unknown }) => Promise<AnyObj>,
): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters: parameters as never,
    output: {
      schema: schema as never,
      render: ((args: unknown, value: unknown) => render(args as AnyObj, value as AnyObj)) as never,
    },
    async execute(args: AnyObj, exec: { signal: AbortSignal; agent?: unknown }) {
      // Lossless-JSON fence: the harness output validator rejects results that
      // carry explicit-undefined keys; sanitize once here for every omo_* tool.
      return stripUndefined(await execute(args, { signal: exec.signal, agent: exec.agent }))
    },
  } as never)
}

function summarize(rules: ReturnType<typeof scanRules>): AnyObj[] {
  return rules.map((r) => ({
    file: r.relPath,
    name: r.name,
    description: r.description,
    globs: r.globs,
    alwaysApply: r.alwaysApply,
    priority: r.priority,
  }))
}

/** Exported for tests (rulesHooks.test.mjs captures the omo_agents brief
 * entry); registration itself goes through apply(). */
export function buildTools(config: Config): ToolDefinition[] {
  const tools: ToolDefinition[] = []

  // ─────────────────────────── omo_status ───────────────────────────
  tools.push(
    tool(
      'omo_status',
      '查询 dsh-oh-my-agent（oh-my-openagent 复刻）插件状态：已注册工具清单、当前工作区、rules 扫描统计、boulder 记忆概况、monitor 运行数。每轮工作开始时调用一次。',
      {},
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugin: { type: 'string' },
          workspace: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
          rules: { type: 'object', additionalProperties: false, properties: { scanned: { type: 'integer' }, alwaysApply: { type: 'integer' } } },
          counts: { type: 'object', additionalProperties: true },
          plan: { type: 'object', additionalProperties: true },
          monitors: { type: 'integer' },
          goalGuard: { type: 'integer' },
        },
      },
      (_a, v) =>
        text(
          'dsh-oh-my-agent 状态\n' +
            `- 工作区: ${String(v.workspace)}\n` +
            `- 工具: ${(v.tools as string[]).join(', ')}\n` +
            `- rules: ${String((v.rules as AnyObj)?.scanned)} scanned, ${String((v.rules as AnyObj)?.alwaysApply)} alwaysApply\n` +
            `- boulder: ${JSON.stringify(v.counts)}\n` +
            `- monitors: ${String(v.monitors)}\n` +
            `- goal-guard: ${String(v.goalGuard)} agents guarded`,
        ),
      async (_args, exec) => {
        const ws = wsFromExec(config, exec)
        const rules = scanRules(ws)
        const b = boulderSummary(ws)
        const planWm = loadBoulder(ws).activePlan
        const monitors = new MonitorRegistry(ws).list().length
        return {
          plugin: PLUGIN_ID,
          workspace: ws,
          tools: [
            'omo_status', 'omo_rules', 'omo_note', 'omo_hashline_edit', 'omo_hashline_lines',
            'omo_code_search', 'omo_comment_check', 'omo_monitor', 'omo_ultrawork', 'omo_handoff', 'omo_team_task', 'omo_jsonc', 'omo_codegraph', 'omo_lsp', 'omo_model_route', 'omo_hooks', 'omo_memory',
            'omo_agents', 'omo_docs', 'omo_look_at', 'omo_skills', 'delegate_as',
          ],
          rules: { scanned: rules.length, alwaysApply: rules.filter((r) => r.alwaysApply).length },
          counts: b.counts,
          ...(planWm ? { plan: { planId: planWm.planId, name: planWm.name, total: planWm.total, completed: planWm.completed, status: planWm.status } } : {}),
          monitors,
          goalGuard: goalGuard?.guardedCount() ?? 0,
        }
      },
    ),
  )

  // ─────────────────────────── omo_rules ───────────────────────────
  tools.push(
    tool(
      'omo_rules',
      '规则引擎（复刻 oh-my-openagent）：扫描/编译/按路径匹配 .mdc 与规则目录。action=scan 列出所有规则文件；action=compile 生成编译块写入 .omo/rules/compiled.md；action=path 返回某文件命中的规则。',
      {
        action: { type: 'string', enum: ['scan', 'compile', 'path'], required: true },
        path: { type: 'string' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          rules: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
                globs: { type: 'array', items: { type: 'string' } }, alwaysApply: { type: 'boolean' }, priority: { type: 'integer' },
              },
            },
          },
          matchedFor: { type: 'string' },
          compiledFile: { type: 'string' },
          compiled: { type: 'string' },
          message: { type: 'string' },
        },
      },
      (_a, v) => {
        const action = String(v.action)
        const rules = (v.rules as Array<AnyObj>) ?? []
        if (action === 'compile') {
          return text(`规则已编译 → ${String(v.compiledFile)}\n\n${String(v.compiled || '(empty)').slice(0, 3000)}`)
        }
        if (action === 'path') {
          return text(
            `匹配路径「${String(v.matchedFor)}」的规则:\n` +
              rules.map((r) => `- ${r.name} (${r.file}) ${r.alwaysApply ? '[alwaysApply]' : ''}`).join('\n') +
              `\n\n编译块:\n${String(v.compiled || '(empty)').slice(0, 2000)}`,
          )
        }
        return text(
          `扫描到 ${rules.length} 条规则:\n` +
            rules.map((r) => `- [${r.priority}] ${r.name} — ${r.description}\n  ${r.file}`).join('\n'),
        )
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const action = String(args.action || 'scan')
        if (action === 'compile') {
          const state = refreshRulesState(ws)
          return { action, rules: summarize(state.files), matchedFor: '', compiledFile: state.compiledFile, compiled: state.compiled, message: 'compiled' }
        }
        if (action === 'path') {
          const rel = String(args.path || '')
          const state = refreshRulesState(ws, rel)
          return { action, rules: summarize(state.files), matchedFor: rel, compiledFile: state.compiledFile, compiled: state.compiled, message: 'matched' }
        }
        const rules = scanRules(ws)
        refreshRulesState(ws)
        return { action, rules: summarize(rules), matchedFor: '', compiledFile: '', compiled: '', message: `scanned ${rules.length}` }
      },
    ),
  )

  // ─────────────────────────── omo_note (boulder) ───────────────────
  tools.push(
    tool(
      'omo_note',
      'Boulder 持久记忆（复刻 oh-my-openagent）：跨任务累积 learnings/decisions/issues/verifications/problems。append 记录，list 查看，update 标记状态，checkpoint 快照，new-thread 开新线程。',
      {
        action: { type: 'string', enum: ['list', 'append', 'update', 'checkpoint', 'new-thread'], required: true },
        section: { type: 'string', enum: ['learnings', 'decisions', 'issues', 'verifications', 'problems'] },
        content: { type: 'string' },
        id: { type: 'integer' },
        status: { type: 'string' },
        thread: { type: 'string' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' }, section: { type: 'string' }, count: { type: 'integer' },
          message: { type: 'string' },
          notes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'integer' }, ts: { type: 'string' }, content: { type: 'string' }, status: { type: 'string' } },
            },
          },
          checkpointFile: { type: 'string' },
        },
      },
      (_a, v) => {
        const notes = (v.notes as Array<AnyObj>) ?? []
        const head = `${v.action} → ${v.section} (${v.count} notes) ${v.message}`
        const body = notes.map((n) => `- #${n.id} [${n.ts}] ${n.content}`).join('\n')
        return text(`${head}${body ? '\n' + body : ''}`)
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const action = String(args.action)
        const secRaw = String(args.section)
        const section = isSection(secRaw) ? secRaw : 'learnings'
        switch (action) {
          case 'list': {
            const r = listNotes(ws, section)
            return { action, section: r.section, count: r.count, message: r.message, notes: r.notes }
          }
          case 'append': {
            if (!args.content) return { action, section, count: 0, message: 'content required', notes: [] }
            const r = appendNote(ws, section, String(args.content), args.status ? String(args.status) : undefined)
            return { action, section: r.section, count: r.count, message: r.message, notes: r.notes }
          }
          case 'update': {
            const r = updateNote(ws, section, Number(args.id ?? 0), args.status ? String(args.status) : undefined, args.content ? String(args.content) : undefined)
            return { action, section: r.section, count: r.count, message: r.message, notes: r.notes }
          }
          case 'checkpoint': {
            const r = checkpointBoulder(ws)
            return { action, section, count: 0, message: r.message, notes: [], checkpointFile: r.file }
          }
          case 'new-thread': {
            const r = newThreadBoulder(ws, args.thread ? String(args.thread) : '')
            return { action, section, count: r.count, message: r.message, notes: [] }
          }
          default:
            return { action, section, count: 0, message: 'unknown action', notes: [] }
        }
      },
    ),
  )

  // ─────────────────────────── omo_hashline_edit ────────────────────
  tools.push(
    tool(
      'omo_hashline_edit',
      'hashline 确定性精编（复刻 oh-my-openagent edit_format）：以「行号 + 2 字符内容哈希」寻址，避免字符串替换歧义。ops: replace(替换该行)/append(行后插入)/prepend(行前插入)/delete(删行)。edits[].hash 为原行内容哈希(用 omo_hashline_lines 获取)，不匹配则拒绝(防 stale 误写)。file 相对工作区。',
      {
        file: { type: 'string', required: true },
        edits: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line: { type: 'integer', required: true },
              hash: { type: 'string' },
              op: { type: 'string', enum: ['replace', 'append', 'prepend', 'delete'], required: true },
              content: { type: 'string' },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          file: { type: 'string' },
          fileHash: { type: 'string' },
          applied: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { line: { type: 'integer' }, op: { type: 'string' }, ok: { type: 'boolean' }, newHash: { type: 'string' }, appliedLine: { type: 'integer' } },
            },
          },
          conflicted: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { line: { type: 'integer' }, op: { type: 'string' }, ok: { type: 'boolean' }, reason: { type: 'string' } },
            },
          },
        },
      },
      (_a, v) => {
        const applied = (v.applied as Array<AnyObj>) ?? []
        const conflicted = (v.conflicted as Array<AnyObj>) ?? []
        const head = `hashline 编辑 ${String(v.file)}: ${applied.length} 处应用, ${conflicted.length} 处冲突`
        const body = [
          ...applied.map((r) => `✓ L${r.line} ${r.op} → ${String(r.appliedLine)} (${r.newHash})`),
          ...conflicted.map((r) => `✗ L${r.line} ${r.op}: ${String(r.reason)}`),
        ].join('\n')
        return text(`${head}\n${body}`)
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const edits = (Array.isArray(args.edits) ? args.edits : []) as HashEdit[]
        const out = applyHashlineEdits(ws, String(args.file || ''), edits)
        return {
          ok: out.ok, file: out.file, fileHash: out.fileHash,
          applied: out.applied.map((r) => ({ line: r.line, op: r.op, ok: r.ok, newHash: r.newHash ?? '', appliedLine: r.appliedLine ?? 0 })),
          conflicted: out.conflicted.map((r) => ({ line: r.line, op: r.op, ok: r.ok, reason: r.reason ?? '' })),
        }
      },
    ),
  )

  // ─────────────────────────── omo_hashline_lines ───────────────────
  tools.push(
    tool(
      'omo_hashline_lines',
      '输出文件「行号 + 2 字符哈希 + 行文本」映射，供 omo_hashline_edit 做确定性锚定。',
      { file: { type: 'string', required: true } },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string' },
          lines: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { line: { type: 'integer' }, hash: { type: 'string' }, text: { type: 'string' } },
            },
          },
        },
      },
      (_a, v) => {
        const lines = (v.lines as Array<AnyObj>) ?? []
        return text(
          `行哈希映射 ${String(v.file)}:\n` +
            lines.map((l) => `${String(l.line).padStart(4)} #${l.hash} | ${String(l.text).slice(0, 80)}`).join('\n'),
        )
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        return describeLines(ws, String(args.file || ''))
      },
    ),
  )

  // ─────────────────────────── omo_code_search ──────────────────────
  tools.push(
    tool(
      'omo_code_search',
      '代码搜索（复刻 oh-my-openagent ast-grep）：search 结构化/文本搜索返回 backend；rewrite AST 重写（需 ast-grep 二进制，否则明确不可用）。',
      {
        action: { type: 'string', enum: ['search', 'rewrite', 'scan'], required: true, default: 'search' },
        pattern: { type: 'string', required: true },
        rule: { type: 'string', description: 'scan 时的模式列表（每行一个 ast-grep 模式）' },
        replacement: { type: 'string' },
        path: { type: 'string' },
        include: { type: 'string' },
        lang: { type: 'string' },
        caseSensitive: { type: 'boolean' },
        word: { type: 'boolean' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          backend: { type: 'string' }, query: { type: 'string' }, total: { type: 'integer' }, note: { type: 'string' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { file: { type: 'string' }, line: { type: 'integer' }, column: { type: 'integer' }, matched: { type: 'string' }, snippet: { type: 'string' } },
            },
          },
          rewritten: { type: 'array', items: { type: 'string' } },
        },
      },
      (_a, v) => {
        const hits = (v.hits as Array<AnyObj>) ?? []
        const note = String(v.note || '')
        const head = `代码搜索 [${String(v.backend)}]: ${String(v.query)} → ${String(v.total)} 结果${note ? ` (${note})` : ''}`
        const body = hits.slice(0, 30).map((h) => `- ${h.file}:${h.line}:${h.column}  ${String(h.matched || '').slice(0, 90)}`).join('\n')
        return text(`${head}\n${body}`)
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const pattern = String(args.pattern || '')
        const opts = {
          path: args.path ? String(args.path) : undefined,
          lang: args.lang ? String(args.lang) : undefined,
          caseSensitive: Boolean(args.caseSensitive),
          include: args.include ? String(args.include) : undefined,
          word: Boolean(args.word),
        }
        const action = String(args.action || 'search')
        if (action === 'rewrite') {
          const rw = await astRewrite(ws, pattern, String(args.replacement || ''), { path: opts.path, lang: opts.lang })
          return { backend: rw.backend, query: pattern, total: rw.files.length, note: rw.note ?? '' + (rw.ok ? '' : ' [rewrite unavailable]'), hits: [], rewritten: rw.files }
        }
        if (action === 'scan') {
          const patterns = String(args.rule || pattern).split('\n').map((x) => x.trim()).filter(Boolean)
          const sc = await astGrepScan(ws, patterns, { path: opts.path, lang: opts.lang })
          const per = sc.perPattern.map((p2) => p2.pattern + ':' + p2.count).join('  ')
          return { backend: sc.backend, query: sc.query, total: sc.total, note: (sc.note || '') + (per ? '  per-pattern[' + per + ']' : ''), hits: sc.hits, rewritten: [] }
        }
        const res = await structuredSearch(ws, pattern, opts)
        return { backend: res.backend, query: res.query, total: res.total, note: res.note ?? '', hits: res.hits }
      },
    ),
  )

  // ─────────────────────────── omo_comment_check ────────────────────
  tools.push(
    tool(
      'omo_comment_check',
      '评论/占位标记检查（复刻 oh-my-openagent comment-checker）：扫描 TODO/FIXME/XXX/HACK/BUG/UNDONE/WIP/IMPLEMENT/PLACEHOLDER/TBD。changedOnly=true 只看 git 变更文件。含 @allow 豁免行、comment-checker-disable-file 豁免文件。',
      {
        path: { type: 'string' },
        changedOnly: { type: 'boolean' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          checked: { type: 'integer' },
          blockers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { file: { type: 'string' }, line: { type: 'integer' }, marker: { type: 'string' }, code: { type: 'string' }, escaped: { type: 'boolean' } },
            },
          },
          markers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { file: { type: 'string' }, line: { type: 'integer' }, marker: { type: 'string' }, code: { type: 'string' }, escaped: { type: 'boolean' } },
            },
          },
          skippedFiles: { type: 'array', items: { type: 'string' } },
          message: { type: 'string' },
        },
      },
      (_a, v) => {
        const blockers = (v.blockers as Array<AnyObj>) ?? []
        const markers = (v.markers as Array<AnyObj>) ?? []
        const head = `comment-check: 检查 ${String(v.checked)} 个文件, 阻断标记 ${blockers.length} 个, 共 ${markers.length} 个${String(v.message)}`
        const body = blockers.slice(0, 40).map((m) => `⛔ ${m.file}:${m.line} [${m.marker}] ${m.code}`).join('\n')
        return text(`${head}\n${body}`)
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const res = checkComments(ws, {
          path: args.path ? String(args.path) : undefined,
          changedOnly: Boolean(args.changedOnly),
        })
        return {
          checked: res.checked,
          blockers: res.blockers.map((m) => ({ file: m.file, line: m.line, marker: m.marker, code: m.code, escaped: m.escaped })),
          markers: res.markers.map((m) => ({ file: m.file, line: m.line, marker: m.marker, code: m.code, escaped: m.escaped })),
          skippedFiles: res.skippedFiles,
          message: res.blockers.length ? ' → 需要清理或标注 @allow' : ' → 全部通过',
        }
      },
    ),
  )

  // ─────────────────────────── omo_monitor ──────────────────────────
  tools.push(
    tool(
      'omo_monitor',
      '后台命令监控（复刻 oh-my-openagent monitor）：start 起后台命令将输出流入 .omo/monitor/<id>.log；output 读尾部（含 [OMO MONITOR OUTPUT] 信封，属不可信输出）；list / stop。',
      {
        action: { type: 'string', enum: ['start', 'output', 'list', 'stop'], required: true },
        command: { type: 'string' },
        workdir: { type: 'string' },
        id: { type: 'string' },
        tail: { type: 'integer' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' }, id: { type: 'string' }, running: { type: 'boolean' },
          exitCode: { type: 'json' }, output: { type: 'string' }, message: { type: 'string' },
          monitors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, command: { type: 'string' }, running: { type: 'boolean' }, exitCode: { type: 'integer' } },
            },
          },
        },
      },
      (_a, v) => {
        if (v.action === 'output') return text(`后台命令 ${String(v.id)} (running=${String(v.running)})\n\n${String(v.output || '')}`)
        if (v.action === 'list') {
          const ms = (v.monitors as Array<AnyObj>) ?? []
          return text('后台命令监控:\n' + ms.map((m) => `- ${m.id} ${m.running ? '运行中' : '已结束(exit ' + String(m.exitCode ?? '?') + ')'}: ${m.command}`).join('\n') || '(none)')
        }
        return text(`monitor ${String(v.action)}: ${String(v.message)}`)
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const reg = new MonitorRegistry(ws)
        const action = String(args.action)
        // schema-declared projection only (full MonitorEntry violates the
        // additionalProperties:false items contract; null exitCode is omitted)
        const briefs = (): AnyObj[] =>
          reg.list().map((m) => {
            const o: AnyObj = { id: m.id, command: m.command, running: m.running }
            if (m.exitCode !== null && m.exitCode !== undefined) o.exitCode = m.exitCode
            return o
          })
        switch (action) {
          case 'start': {
            const cmd = String(args.command || '')
            if (!cmd.trim()) return { action, message: 'empty command', monitors: briefs() }
            const entry = reg.start(cmd, args.workdir ? String(args.workdir) : ws, exec.signal)
            return { action, id: entry.id, running: true, message: `started ${entry.id}`, monitors: [] }
          }
          case 'output': {
            const r = reg.output(String(args.id || ''), Number(args.tail ?? 30))
            if (!r.entry) return { action, message: 'monitor not found', monitors: briefs() }
            return { action, id: r.entry.id, running: r.entry.running, exitCode: String(r.entry.exitCode ?? 'null'), output: r.output, monitors: [] }
          }
          case 'stop': {
            const entry = reg.stop(String(args.id || ''))
            if (!entry) return { action, message: 'monitor not found', monitors: briefs() }
            return { action, id: entry.id, running: false, message: `stopped ${entry.id}`, monitors: [] }
          }
          default:
            return { action, message: '', monitors: briefs() }
        }
      },
    ),
  )

  // ─────────────────────────── omo_ultrawork ────────────────────────
  tools.push(
    tool(
      'omo_ultrawork',
      'ultrawork 纪律协议指挥器：action=submit_plan 提交完整计划并弹审批卡，Approve 后落盘到 .omo/plans/<planId>.md 并切 Atlas；Keep planning 保持规划态。其余参数用于创建/推进 ultrawork 计划与清除水位。',
      {
        action: { type: 'string', enum: ['submit_plan'] },
        plan: { type: 'string', description: 'submit_plan 必填：完整 Markdown（必须以 # 开头）' },
        goal: { type: 'string' },
        phase: { type: 'string', enum: ['plan', 'explore', 'waves', 'verify', 'deliver'] },
        completed: { type: 'integer', description: '已完成的波浪数，用于 boulder RESUME 进度' },
        cancel: { type: 'boolean', description: 'true=清 boulder activePlan 水位并停止续跑（无需其他参数）' },
        waves: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', required: true },
              category: { type: 'string', enum: ['ultrabrain', 'deep', 'quick', 'visual', 'writing', 'unspecified-high', 'unspecified-low'], required: true },
              task: { type: 'string', required: true },
              files: { type: 'array', items: { type: 'string' } },
              depends_on: { type: 'array', items: { type: 'string' } },
            },
          },
        },
        verification: { type: 'array', items: { type: 'string' } },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          phase: { type: 'string' },
          plan: {
            type: 'object',
            additionalProperties: true,
            properties: { id: { type: 'string' }, goal: { type: 'string' }, phase: { type: 'string' }, waves: { type: 'array', items: { type: 'object', additionalProperties: true } } },
          },
          progress: { type: 'object', additionalProperties: true },
          markdown: { type: 'string' },
          message: { type: 'string' },
          approved: { type: 'boolean' },
          planPath: { type: 'string' },
          mode: { type: 'string', enum: ['off', 'prometheus', 'atlas'] },
          route: { type: 'string' },
          feedback: { type: 'string' },
        },
      },
      (_a, v) => text(v.markdown ? String(v.markdown) : (v.message ? String(v.message) : '')),
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        if (args.action === 'submit_plan') {
          const planMarkdown = typeof args.plan === 'string' ? args.plan : ''
          validatePlanMarkdown(planMarkdown)
          if (sessionModeOf(exec.agent) !== 'prometheus') {
            return { ok: false, approved: false, mode: sessionModeOf(exec.agent), message: '请先调用 omo_session_model state=on 进入规划态，再提交审批。' }
          }
          const userQuestions = ((hostCtx as unknown as { get?: (name: string) => unknown } | null)?.get?.('userQuestions')) as { ask?: (request: AnyObj) => Promise<{ answers?: unknown }> } | undefined
          if (!userQuestions || typeof userQuestions.ask !== 'function') {
            return { ok: false, approved: false, mode: 'prometheus', message: '当前宿主没有 userQuestions 审批卡；请使用聊天式批准后再继续。' }
          }
          let answers: unknown
          try {
            const result = await userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [buildPlanReviewQuestion(planMarkdown)] })
            answers = result.answers
          } catch (error) {
            const code = String((error as { code?: unknown } | null)?.code ?? error)
            if (code.includes('ASK_CANCELLED')) return { ok: false, approved: false, mode: 'prometheus', message: '审批已取消；已停在规划态，等待你的消息。' }
            if (code.includes('NO_PROVIDER')) return { ok: false, approved: false, mode: 'prometheus', message: '当前界面无法显示审批卡；请使用聊天式批准。' }
            if (code.includes('DELEGATED_CALLER')) return { ok: false, approved: false, mode: 'prometheus', message: '子代理无法弹出审批卡；请把计划交回 root 编排者提交。' }
            if (code.includes('CALLER_NOT_LIVE')) return { ok: false, approved: false, mode: 'prometheus', message: '当前会话 agent 已失效；请由 live 会话重新提交审批。' }
            throw error
          }
          const choice = interpretPlanReviewAnswer(answers)
          if (choice === 'keep') {
            const first = (answers as Array<{ custom?: unknown }>)[0]
            const feedback = typeof first?.custom === 'string' && first.custom.trim() ? first.custom.trim() : '用户选择继续规划。'
            throw new Error(`Keep planning：保持在 Prometheus 规划态。用户反馈：${feedback}`)
          }
          if (choice !== 'approve') return { ok: false, approved: false, mode: 'prometheus', message: '审批卡未返回有效选择；已停在规划态，请重新提交。' }
          const existingBoulder = loadBoulder(ws)
          let ultraPlan = readUltraPlan(ws)
          if (!existingBoulder.activePlan || !ultraPlan) {
            const modelCfg = loadLayeredConfig(ws).merged
            const waves = (Array.isArray(args.waves) ? args.waves as AnyObj[] : []).map((wave): Wave => {
              const category = String(wave.category || 'quick')
              const decision = resolveCategory({ category, mergedConfig: modelCfg })
              return {
                name: String(wave.name || 'wave'), category, goal: String(wave.task || ''),
                files: Array.isArray(wave.files) ? wave.files.map(String) : [],
                dependsOn: Array.isArray(wave.depends_on) ? wave.depends_on.map(String) : [],
                ...(decision.chosen ? { model: { provider: decision.chosen.provider, model: decision.chosen.model, reasoning: decision.chosen.reasoning } } : {}),
              }
            })
            const verification = Array.isArray(args.verification) ? args.verification.map(String) : ['run build/tests']
            ultraPlan = createUltraPlan(ws, typeof args.goal === 'string' && args.goal.trim() ? args.goal : goalFromPlan(planMarkdown), waves, verification)
          }
          if (!/^uw-[a-z0-9]+$/.test(ultraPlan.id)) {
            return { ok: false, approved: true, mode: 'prometheus', message: '计划水位的 planId 格式无效；为安全起见未写入文件或切换模式。' }
          }
          const planPath = `.omo/plans/${ultraPlan.id}.md`
          try {
            // Intentional direct write: approved plan artifact is not a user edit through the write tool.
            ensureDir(omoDir(ws, 'plans'))
            writeState(path.join(ws, planPath), planMarkdown)
          } catch (error) {
            return { ok: false, approved: true, mode: 'prometheus', message: `计划水位已建立，但完整计划写入失败（${String(error)}）；未切执行态。` }
          }
          const merged = loadLayeredConfig(ws).merged
          const routes: DelegateRoutes = { provider: config.delegateProvider, flash: config.delegateFlashRoute, heavy: config.delegateHeavyRoute }
          const routeResult = roleModelRoute('atlas', merged, routes)
          const switched = await setSessionMode(exec.agent, 'atlas', routeResult, defaultsSelection())
          if (!switched.ok) return { ok: false, approved: true, planPath, mode: 'prometheus', message: `计划已落盘，但切换 Atlas 失败（${switched.reason || '未知错误'}）；请手动调用 omo_session_model state=atlas。` }
          return { ok: true, approved: true, planPath, mode: 'atlas', route: `${routeResult.provider}/${routeResult.model}`, message: '计划已批准、落盘并切换到 Atlas 执行态。' }
        }
        // cancel：清 boulder activePlan 水位，停止 RESUME 续跑
        if (args.cancel === true) {
          const b = loadBoulder(ws)
          if (b.activePlan) {
            delete (b as unknown as AnyObj).activePlan
            saveBoulder(ws, b)
            return { ok: true, message: 'ultrawork 已取消：boulder activePlan 水位已清除，后续不再自动续跑；可搭配 omo_session_model(state=off) 还原会话模式' }
          }
          return { ok: true, message: 'ultrawork 当前无活跃计划（无操作）' }
        }
        const existing = readUltraPlan(ws)
        const phaseProp = (['plan', 'explore', 'waves', 'verify', 'deliver'] as const).find((p) => p === String(args.phase || '')) as UltraPhase | undefined
        if (typeof args.completed === 'number') recordWaveProgress(ws, Number(args.completed))
        // Returns a spread fragment: { progress } when the boulder watermark
        // exists, {} otherwise (schema declares progress as object-only, so
        // absent beats null — same convention as omo_status.plan).
        const progressOf = (): AnyObj => {
          const b = loadBoulder(ws)
          return b.activePlan ? { progress: { planId: b.activePlan.planId, name: b.activePlan.name, total: b.activePlan.total, completed: b.activePlan.completed, status: b.activePlan.status } } : {}
        }

        if (!existing && args.goal) {
          const modelCfg = loadLayeredConfig(ws).merged
          const waves = (Array.isArray(args.waves) ? (args.waves as AnyObj[]) : []).map((w): Wave => {
            const cat = String(w.category || 'quick')
            const dec = resolveCategory({ category: cat, mergedConfig: modelCfg })
            return {
              name: String(w.name || 'wave'),
              category: cat,
              goal: String(w.task || ''),
              files: Array.isArray(w.files) ? (w.files as unknown[]).map(String) : [],
              dependsOn: Array.isArray(w.depends_on) ? (w.depends_on as unknown[]).map(String) : [],
              model: dec.chosen ? { provider: dec.chosen.provider, model: dec.chosen.model, reasoning: dec.chosen.reasoning } : undefined,
            }
          })
          const ver = Array.isArray(args.verification) ? (args.verification as unknown[]).map(String) : []
          const plan = createUltraPlan(ws, String(args.goal), waves, ver.length ? ver : ['run build/tests', 'omo_comment_check changedOnly=true'])
          const target = phaseProp ?? 'plan'
          plan.phase = target
          updateUltraPhase(ws, target)
          const tx = ultraworkPhaseText(ws)
          return { phase: tx.phase, plan: { id: plan.id, goal: plan.goal, phase: plan.phase, waves: plan.waves }, ...progressOf(), markdown: tx.markdown, message: 'plan created' }
        }

        if (existing && phaseProp) {
          updateUltraPhase(ws, phaseProp)
          const tx = ultraworkPhaseText(ws)
          return { phase: tx.phase, plan: { id: tx.plan!.id, goal: tx.plan!.goal, phase: tx.plan!.phase, waves: tx.plan!.waves }, ...progressOf(), markdown: tx.markdown, message: 'advanced' }
        }

        const tx = ultraworkPhaseText(ws)
        if (!tx.plan) return { phase: 'plan', markdown: tx.markdown, message: 'no active plan; provide goal to start' }
        return { phase: tx.phase, plan: { id: tx.plan.id, goal: tx.plan.goal, phase: tx.plan.phase, waves: tx.plan.waves }, ...progressOf(), markdown: tx.markdown, message: 'status' }
      },
    ),
  )

  // ─────────────────────────── omo_handoff ──────────────────────────
  tools.push(
    tool(
      'omo_handoff',
      '交接上下文（复刻 oh-my-openagent /handoff）：汇集工作区、编译规则、boulder 记忆、活跃 ultrawork 计划与下一步，生成可粘贴给新会话继续的 markdown。',
      {
        goal: { type: 'string' },
        conversation: { type: 'string' },
        next_steps: { type: 'array', items: { type: 'string' } },
        include_rules: { type: 'boolean', default: true },
        include_boulder: { type: 'boolean', default: true },
        include_plan: { type: 'boolean', default: true },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: { markdown: { type: 'string' }, length: { type: 'integer' } },
      },
      (_a, v) => text(String(v.markdown || '')),
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const md = buildHandoff(ws, {
          goal: args.goal ? String(args.goal) : undefined,
          conversation: args.conversation ? String(args.conversation) : undefined,
          nextSteps: Array.isArray(args.next_steps) ? (args.next_steps as unknown[]).map(String) : [],
          includeBoulder: args.include_boulder !== false,
          includePlan: args.include_plan !== false,
          includeRules: args.include_rules !== false,
        })
        return { markdown: md, length: md.length }
      },
    ),
  )

  // ─────────────────────────── omo_team_task ────────────────────────
  tools.push(
    tool(
      'omo_team_task',
      '团队共享任务表（复刻 oh-my-openagent team-core）：任何 agent/子代理可读写同一张任务表实现协作排队。list/add/update。',
      {
        action: { type: 'string', enum: ['list', 'add', 'update'], required: true },
        title: { type: 'string' },
        assignee: { type: 'string' },
        status: { type: 'string', enum: ['backlog', 'todo', 'running', 'done', 'failed', 'cancelled'] },
        id: { type: 'string' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' }, message: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' }, title: { type: 'string' }, assignee: { type: 'string' },
                status: { type: 'string' }, ts: { type: 'string' }, summary: { type: 'string' },
              },
            },
          },
        },
      },
      (_a, v) => {
        const tasks = (v.tasks as Array<AnyObj>) ?? []
        if (!tasks.length) return text(`team-task ${String(v.action)}: (空)`)
        return text(
          `${String(v.message)}\n` +
            tasks.slice(0, 30).map((t) => `- [${t.status}] #${t.id} ${t.title}${t.assignee ? ` @${t.assignee}` : ''}`).join('\n'),
        )
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const tasks = loadTasks(ws)
        const action = String(args.action)
        const short = (s: string): string => (s.length > 70 ? s.slice(0, 70) + '…' : s)
        if (action === 'add') {
          const row: TaskRow = {
            id: 't-' + Date.now().toString(36),
            title: short(String(args.title || 'untitled')),
            assignee: args.assignee ? String(args.assignee) : '',
            status: 'todo',
            ts: nowTs(),
            summary: '',
          }
          tasks.push(row)
          saveTasks(ws, tasks)
          return { action, message: `task ${row.id} added`, tasks }
        }
        if (action === 'update') {
          const id = String(args.id || '')
          const row = tasks.find((t) => t.id === id)
          if (!row) return { action, message: `task ${id} not found`, tasks }
          if (args.status) row.status = String(args.status)
          if (args.assignee) row.assignee = String(args.assignee)
          row.ts = nowTs()
          saveTasks(ws, tasks)
          return { action, message: `task ${id} → ${row.status}`, tasks }
        }
        return { action: 'list', message: `${tasks.length} tasks`, tasks }
      },
    ),
  )

  // ─────────────────────────── omo_jsonc (layered config) ──────────
  tools.push(
    tool(
      'omo_jsonc',
      'omo.jsonc 分层配置（复刻 oh-my-openagent omo-config）：读取用户层 ~/.omo/omo.jsonc 与项目层逐级 .omo/omo.jsonc（近者覆盖远者），深合并 [opencode]/[codex] 自由块。action=read 返回合并结果与来源；action=validate 校验 JSONC 合法性。',
      {
        action: { type: 'string', enum: ['read', 'validate'], required: true },
        key: { type: 'string', description: 'read 时可选指定键路径（如 opencode.disabled_tools）', },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          found: { type: 'boolean' },
          diagnostics: { type: 'array', items: { type: 'string' } },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { path: { type: 'string' }, existed: { type: 'boolean' }, error: { type: 'string' } },
            },
          },
          merged: { type: 'object', additionalProperties: true },
          message: { type: 'string' },
        },
      },
      (_a, v) => {
        const files = (v.files as Array<AnyObj>) ?? []
        const diag = (v.diagnostics as string[]) ?? []
        return text(
          `omo.jsonc 分层配置（found=${String(v.found)}）\n` +
            '来源（低→高优先级）:\n' +
            files.map((f) => `- ${f.path}${f.existed ? '' : ' (不存在)'}${f.error ? ' — ERROR ' + f.error : ''}`).join('\n') +
            (diag.length ? `\n诊断:\n${diag.join('\n')}` : '') +
            `\n合并结果:\n${JSON.stringify(v.merged ?? {}, null, 2).slice(0, 1500)}`,
        )
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const view = loadLayeredConfig(ws)
        if (String(args.action) === 'validate') {
          return {
            action: 'validate',
            found: view.found,
            diagnostics: view.diagnostics,
            files: view.files.map((f) => ({ path: f.path, existed: f.existed, error: f.error ?? '' })),
            merged: {},
            message: view.diagnostics.length ? '存在解析错误' : '全部合法',
          }
        }
        const key = args.key ? String(args.key) : ''
        let merged = view.merged
        let keyFound = true
        if (key) {
          const parts = key.split('.')
          let cur: unknown = merged
          for (const p of parts) {
            if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[p]
            else { cur = undefined; break }
          }
          keyFound = cur !== undefined
          // undefined is not lossless JSON - omit the key instead of nulling it
          merged = keyFound ? { [key]: cur } : {}
        }
        let message = view.found ? `${view.files.filter((f) => f.existed).length} 个配置文件` : '未找到任何 omo.jsonc'
        if (key && !keyFound) message += `；键 "${key}" 不存在（合并结果为空）`
        return {
          action: 'read',
          found: view.found,
          diagnostics: view.diagnostics,
          files: view.files.map((f) => ({ path: f.path, existed: f.existed, error: f.error ?? '' })),
          merged,
          message,
        }
      },
    ),
  )

  // ─────────────────────────── omo_codegraph ────────────────────────
  tools.push(
    tool(
      'omo_codegraph',
      '代码知识图谱（复刻 oh-my-openagent codegraph）：包装 ~/.omo/codegraph 自包含 CLI。action=status 当前工作区索引状态；query/node/explore 查询符号/节点/区域（需 symbol）；paths 列出已索引项目。未索引时如实说明。',
      {
        action: { type: 'string', enum: ['status', 'query', 'node', 'explore', 'paths'], required: true },
        symbol: { type: 'string' },
        limit: { type: 'integer' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, action: { type: 'string' }, backend: { type: 'string' },
          note: { type: 'string' }, output: { type: 'string' },
          projects: { type: 'array', items: { type: 'string' } },
        },
      },
      (_a, v) => {
        const head = `codegraph ${String(v.action)} [${String(v.backend)}]${v.note ? ' — ' + String(v.note) : ''}`
        if (v.action === 'paths') {
          return text(`${head}\n已索引项目:\n${((v.projects as string[]) ?? []).map((p) => '- ' + p).join('\n') || '(none)'}`)
        }
        return text(`${head}\n\n${String(v.output || '(empty)').slice(0, 2500)}`)
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const r = await runCodegraph(ws, String(args.action || 'status'), args.symbol ? String(args.symbol) : '', { limit: Number(args.limit ?? 3000) })
        return { ok: r.ok, action: r.action, backend: r.backend, note: r.note, output: r.output, projects: r.projects ?? [] }
      },
    ),
  )

  // ─────────────────────────── omo_memory (memory-core 移植) ────────
  tools.push(
    tool(
      'omo_memory',
      '持久记忆引擎（复刻 oh-my-openagent memory-core）：git 后端(尽力而为) + markdown MemFS + frontmatter 契约（description 必填 / read_only 禁改）+ 事务日志 + compile 注入块。actions: status/list/create/put/read/str_replace/insert/delete/rename/update_description/compile/search/reflect/extract/journal。',
      {
        action: { type: 'string', enum: ['status', 'list', 'create', 'put', 'read', 'str_replace', 'insert', 'delete', 'rename', 'update_description', 'compile', 'search', 'reflect', 'extract', 'journal'], required: true },
        name: { type: 'string', description: '记忆名（A-Za-z0-9._-，≤60）' },
        content: { type: 'string', description: '记忆正文（create/put/insert）' },
        description: { type: 'string', description: '记忆描述（create/put/update_description 必填非空）' },
        old_text: { type: 'string', description: 'str_replace 的旧文本' },
        new_text: { type: 'string', description: 'str_replace 的新文本' },
        new_name: { type: 'string', description: 'rename 新名' },
        after_line: { type: 'integer', description: 'insert 插入行（1 基，默认文末）' },
        read_only: { type: 'boolean', description: 'create 时标记只读' },
        query: { type: 'string', description: 'search 查询' },
        text: { type: 'string', description: 'extract 的文本源' },
        max_chars: { type: 'integer', description: 'compile 最大字符数' },
        tail: { type: 'integer', description: 'journal 条数' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, action: { type: 'string' }, message: { type: 'string' },
          status: { type: 'object', additionalProperties: true },
          files: { type: 'array', items: { type: 'object', additionalProperties: true } },
          memory: { type: 'object', additionalProperties: true },
          block: { type: 'string' }, hash: { type: 'string' }, cached: { type: 'boolean' },
          hits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          added: { type: 'array', items: { type: 'string' } },
          journal: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      (_a, v) => {
        const action = String(v.action)
        const wrap = (s2: string): string[] => [`memory ${action}: ${s2}`]
        if (action === 'status') {
          const st = (v.status as AnyObj) ?? {}
          const l = [`memory status: dir=${String(st.dir)} files=${String(st.files)} readOnly=${String(st.readOnly)} git=${String(st.gitBacked)} ops=${String(st.ops)} compiled=${String(st.compiledHash).slice(0, 8)}`]
          l.push(((v.files as Array<AnyObj>) ?? []).map((f) => `  - ${f.name} — ${f.description}${f.readOnly ? ' [ro]' : ''}`).join('\n') || '  (empty)')
          return text(l.join('\n'))
        }
        if (action === 'compile') return text(`记忆编译 ${String(v.cached) ? '(缓存)' : '(新)'} hash=${String(v.hash).slice(0, 12)}\n\n${String(v.block).slice(0, 2000)}`)
        if (action === 'search') {
          const hits = (v.hits as Array<AnyObj>) ?? []
          return text(`memory search「${String(v.query)}」→ ${hits.length} 条\n` + hits.map((h) => `  - ${h.name} (score ${h.score}): ${h.snippet}`).join('\n') || '(none)')
        }
        if (action === 'list') {
          const files = (v.files as Array<AnyObj>) ?? []
          return text(`记忆文件 ${files.length} 个:\n` + files.map((f) => `  - ${f.name} — ${f.description}${f.readOnly ? ' [ro]' : ''}`).join('\n') || '(empty)')
        }
        if (action === 'read') {
          const m = (v.memory as AnyObj) ?? {}
          return text(`# ${m.name} — ${m.description}\n\n${String(m.body || '')}`.slice(0, 2500))
        }
        return text(String(v.message || '') + ((v.added && (v.added as string[]).length) ? ' 新增: ' + (v.added as string[]).join(' | ') : ''))
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const action = String(args.action || 'status')
        try {
          const name = String(args.name || '')
          const content = String(args.content ?? '')
          const description = String(args.description ?? '')
          const say = (message: string, extra: AnyObj = {}): AnyObj => ({ ok: true, action, message, ...extra })
          switch (action) {
            case 'status': {
              const st = mem.memoryStatus(ws)
              return say('', { status: st, files: st.fileList })
            }
            case 'list': {
              const files = mem.listMemory(ws)
              return say(`${files.length} 个记忆文件`, { files: files.map((f) => ({ name: f.name, description: f.description, readOnly: f.readOnly })) })
            }
            case 'create': {
              if (!name || !content) return { ok: false, action, message: 'create 需要 name 与 content' }
              const m = mem.createMemory(ws, name, content, description)
              return say(`created ${m.name}`, { memory: { name: m.name, description: m.description, body: m.body } })
            }
            case 'put': {
              if (!name || !content) return { ok: false, action, message: 'put 需要 name 与 content' }
              const m = mem.putMemory(ws, name, content, description || undefined)
              return say(`saved ${m.name}`, { memory: { name: m.name, description: m.description, body: m.body } })
            }
            case 'read': {
              const m = mem.readMemoryFile(ws, name)
              if (!m) return { ok: false, action, message: `memory "${name}" not found` }
              return say('', { memory: { name: m.name, description: m.description, body: m.body, readOnly: m.readOnly } })
            }
            case 'str_replace': {
              if (!name || args.old_text === undefined) return { ok: false, action, message: 'str_replace 需要 name 与 old_text' }
              const m = mem.strReplaceMemory(ws, name, String(args.old_text), String(args.new_text ?? ''))
              return say(`replaced in ${m.name}`, { memory: { name: m.name, description: m.description, body: m.body } })
            }
            case 'insert': {
              if (!name || !content) return { ok: false, action, message: 'insert 需要 name 与 content' }
              const m = mem.insertMemory(ws, name, content, Number(args.after_line ?? undefined) || undefined)
              return say(`inserted into ${m.name}`, { memory: { name: m.name, description: m.description, body: m.body } })
            }
            case 'delete': {
              const r = mem.deleteMemory(ws, name)
              return say(`deleted ${r.name}`)
            }
            case 'rename': {
              const m = mem.renameMemory(ws, name, String(args.new_name || ''))
              return say(`renamed to ${m.name}`, { memory: { name: m.name, description: m.description } })
            }
            case 'update_description': {
              const m = mem.updateDescriptionMemory(ws, name, description)
              return say(`description updated`, { memory: { name: m.name, description: m.description } })
            }
            case 'compile': {
              const c = mem.compileMemory(ws, { maxChars: Number(args.max_chars ?? 12000) })
              return say(c.cached ? 'cached' : 'compiled', { hash: c.hash, cached: c.cached, block: c.block, files: c.files })
            }
            case 'search': {
              const hits = mem.searchMemory(ws, String(args.query || ''))
              return say(`${hits.length} 条命中`, { query: String(args.query || ''), hits })
            }
            case 'reflect': {
              const r = mem.reflectMemory(ws)
              return say(`reflection 新增 ${r.added.length} 条`, { added: r.added })
            }
            case 'extract': {
              const r = mem.extractFacts(ws, String(args.text || ''))
              return say(`extract 新增 ${r.added.length} 条事实`, { added: r.added })
            }
            case 'journal': {
              const ops = mem.memoryJournal(ws, Number(args.tail ?? 15))
              return say(`${ops.length} 条事务`, { journal: ops })
            }
            default:
              return { ok: false, action, message: 'unknown action' }
          }
        } catch (e) {
          return { ok: false, action, message: String((e as Error)?.message ?? e) }
        }
      },
    ),
  )

  // ─────────────────────────── omo_hooks (auto interception) ────────
  tools.push(
    tool(
      'omo_hooks',
      '自动 hook 拦截层（复刻 oh-my-openagent Pre/PostToolUse 闸门，挂 DSH tools/pre-execute + post-execute）：write-existing-file-guard（覆盖已存在文件守卫）、comment-checker（写后自动扫阻断标记）、rules-injector（编辑时自动注入该路径的已编译规则）、read-only-gate（read_only_agents 名单只许写 .omo/ 下 md；Prometheus 规划态动态门，默认另放行 .agent-notes/，可经 plan_write_scopes 配置）、edit-error-recovery（编辑失败注入"停止-重读-验证"恢复指引，连续 2 次失败升级为换方法）、json-error-recovery（参数 JSON/schema 校验失败注入修正指引）、monitor-status-injector（运行中后台 monitor 状态变化时注入一行状态）、hashline-read-enhancer（首次 read 后提示行锚编辑可用）、nested-delegation-guard（ToolGuard 单调守卫：子代理会话调用 delegate_as/subagent*/workflow/ralph 一律拒绝，杜绝嵌套派发——挡的是工具入口，含 workflow/ralph 内部直调 spawn 的绕过面；另有 agent/created per-agent 作用域守卫纵深；hooks.nested_delegation_extra_tools 可追加封禁工具名，hooks.nested_delegation_guard=false 关闭）。开关经 omo.jsonc [opencode].hooks 与 disabled_hooks；status 显示生效配置与最近事件，log 看事件流。',
      {
        action: { type: 'string', enum: ['status', 'log'], required: true, default: 'status' },
        tail: { type: 'integer', description: 'log 返回条数' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          config: { type: 'object', additionalProperties: true },
          enabled: { type: 'array', items: { type: 'string' } },
          disabled: { type: 'array', items: { type: 'string' } },
          recent: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { ts: { type: 'string' }, hook: { type: 'string' }, tool: { type: 'string' }, file: { type: 'string' }, action: { type: 'string' }, detail: { type: 'string' } },
            },
          },
        },
      },
      (_a, v) => {
        const cfg = (v.config as AnyObj) ?? {}
        const enabled = (v.enabled as string[]) ?? []
        const disabled = (v.disabled as string[]) ?? []
        const recent = (v.recent as Array<AnyObj>) ?? []
        const lines = ['omo_hooks 自动拦截层']
        lines.push('config: write_guard=' + String(cfg.writeGuard) + ' comment_checker=' + String(cfg.commentChecker) + ' rules_injector=' + String(cfg.rulesInjector) + ' edit_error_recovery=' + String(cfg.editErrorRecovery) + ' json_error_recovery=' + String(cfg.jsonErrorRecovery) + ' monitor_status_injector=' + String(cfg.monitorStatusInjector) + ' hashline_read_enhancer=' + String(cfg.hashlineReadEnhancer) + ' read_only_agents=' + JSON.stringify(cfg.readOnlyAgents ?? []))
        lines.push('enabled hooks: ' + enabled.join(', '))
        if (disabled.length) lines.push('disabled hooks: ' + disabled.join(', '))
        if (recent.length) {
          lines.push('最近 ' + recent.length + ' 条事件:')
          lines.push(recent.slice(0, Number(v.tail ?? 15)).map((e) => `  [${e.hook}] ${e.tool} ${e.file || ''} → ${e.action}: ${e.detail}`.slice(0, 140)).join('\n'))
        }
        return text(lines.join('\n'))
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const st = hooksStatus(ws)
        const all = ['write-existing-file-guard', 'comment-checker', 'rules-injector', 'read-only-gate', 'edit-error-recovery', 'json-error-recovery', 'monitor-status-injector', 'hashline-read-enhancer']
        const cfg = st.config as unknown as HooksConfig
        const disabled = new Set(cfg.disabledHooks ?? [])
        return {
          ok: true,
          config: { writeGuard: cfg.writeGuard, commentChecker: cfg.commentChecker, rulesInjector: cfg.rulesInjector, readOnlyAgents: cfg.readOnlyAgents ?? [], editErrorRecovery: cfg.editErrorRecovery, jsonErrorRecovery: cfg.jsonErrorRecovery, monitorStatusInjector: cfg.monitorStatusInjector, hashlineReadEnhancer: cfg.hashlineReadEnhancer },
          enabled: all.filter((h) => !disabled.has(h)),
          disabled: [...disabled],
          recent: st.recent,
        }
      },
    ),
  )

  // ─────────────────────────── omo_model_route ──────────────────────
  tools.push(
    tool(
      'omo_model_route',
      '模型 category→fallback 链路由（复刻 oh-my-openagent model-core category 系统）：按语义意图 category 而非模型名选型。resolve 返回该 category 的选定路线(source 标注：explicit/config/builtin)+整个 fallback 链+全网目录；list 返回 8 类默认路线。可经 omo.jsonc [opencode].categories.<name>.model/.fallback_models/.reasoning 与 models 短名映射覆盖。注：DSH 会话实发路由跟随 agent-default-model，此路线为委托选脑决策。',
      {
        action: { type: 'string', enum: ['resolve', 'list'], required: true, default: 'resolve' },
        category: { type: 'string', enum: ['ultrabrain', 'deep', 'visual', 'writing', 'quick', 'unspecified-high', 'unspecified-low', 'artistry'], description: 'resolve 时必填' },
        model: { type: 'string', description: '显式覆盖模型（例如 deepseek-v4-pro 或 provider/model，优先于配置）' },
        reasoning: { type: 'string', description: '显式覆盖 reasoning 级别' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, category: { type: 'string' }, source: { type: 'string' }, note: { type: 'string' },
          chosen: { type: 'object', additionalProperties: true },
          chain: { type: 'array', items: { type: 'object', additionalProperties: true } },
          catalog: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      (_a, v) => {
        const cat = String(v.category || '')
        const chosen = (v.chosen as AnyObj) ?? {}
        const chain = (v.chain as Array<AnyObj>) ?? []
        const catList = (v.catalog as Array<AnyObj>) ?? []
        const lines: string[] = []
        if (v.action === 'list' || !cat) {
          lines.push('category → 默认模型路线（8 类）:')
          for (const c of catList) {
            const def = (c.default as AnyObj) ?? {}
            lines.push(`  - ${c.category}: ${def.provider}/${def.model} (${def.reasoning}) — ${c.role} [fallback×${c.fallbackCount}]`)
          }
        } else {
          lines.push(`route ${cat} → ${chosen.provider}/${chosen.model} (${chosen.reasoning})  [source: ${v.source}]`)
          lines.push('fallback 链:')
          for (const r of chain) lines.push(`  - ${r.provider}/${r.model} (${r.reasoning})`)
        }
        if (v.note) lines.push('note: ' + String(v.note))
        return text(lines.join('\n'))
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const merged = loadLayeredConfig(ws).merged
        const action = String(args.action || 'resolve')
        if (action === 'list') {
          const dec = resolveCategory({ category: 'deep', mergedConfig: merged, model: args.model ? String(args.model) : undefined, reasoning: args.reasoning })
          return { ok: true, category: '', source: '', note: '', chain: [], catalog: dec.catalog }
        }
        const cat = String(args.category || '')
        const dec = resolveCategory({
          category: cat,
          mergedConfig: merged,
          model: args.model ? String(args.model) : undefined,
          reasoning: args.reasoning ? String(args.reasoning) : undefined,
        })
        return { ok: dec.ok, category: dec.category ?? '', source: dec.source, note: dec.note, chosen: dec.chosen, chain: dec.chain, catalog: dec.catalog }
      },
    ),
  )

  // ─────────────────────── omo_session_model (会话级模式) ──────────────
  tools.push(
    tool(
      'omo_session_model',
      '会话级模式开关（model change + 注入段联动）。state=prometheus：规划态——模型切 Prometheus 角色路由（delegate_roles.prometheus > categories.deep > heavy 档）并开启规划写入门（write/edit/hashline 仅能写 plan_write_scopes 内 *.md）；state=atlas：执行态——模型切 Atlas 角色路由（delegate_roles.atlas > categories.ultrabrain > heavy 档）并注入 Atlas 执行纪律段（omo:atlas-execution），写门开；state=off：还原切换前模型（或会话默认）、注入段消失。模式通常由技能注入自动切换（/omo-ulw-plan→规划态、/omo-start-work→执行态、/omo-ultrawork→自动退出规划态）；本工具用于手动兜底与状态确认。生效时序与官方 selectModel 同语义：从切换后的下一次请求生效。',
      {
        state: { type: 'string', enum: ['off', 'on', 'atlas'], required: true, description: 'off=还原默认；on=prometheus 规划态（向后兼容别名）；atlas=执行态' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          active: { type: 'boolean' },
          route: { type: 'string' },
          source: { type: 'string' },
          reason: { type: 'string' },
        },
      },
      (_a, v) => {
        const label = v.mode === 'atlas' ? 'Atlas 执行态' : v.mode === 'prometheus' ? 'Prometheus 规划态' : 'OFF（已还原）'
        return text(v.ok ? `会话模式: ${String(label)}${v.route ? `  route=${String(v.route)}` : ''}${v.source ? `（${v.source}）` : ''}` : `切换失败: ${String(v.reason || '')}`)
      },
      async (args, exec) => {
        const raw = String(args.state || 'off')
        const mode: SessionMode = raw === 'atlas' ? 'atlas' : raw === 'on' ? 'prometheus' : 'off'
        const ws = wsFromExec(config, exec)
        const merged = loadLayeredConfig(ws).merged
        const routes: DelegateRoutes = { provider: config.delegateProvider, flash: config.delegateFlashRoute, heavy: config.delegateHeavyRoute }
        const route = mode === 'atlas' ? roleModelRoute('atlas', merged, routes) : mode === 'prometheus' ? prometheusPlanRoute(merged, routes) : undefined
        const r = await setSessionMode(exec.agent, mode, route, defaultsSelection())
        const out: AnyObj = { ok: r.ok, mode: r.mode ?? mode, active: r.mode !== 'off' }
        if (r.route) out.route = `${r.route.provider}/${r.route.model}`
        if (r.source) out.source = r.source
        if (r.reason) out.reason = r.reason
        return out
      },
    ),
  )

  // ─────────────────────────── omo_agents (roster + briefs) ────────
  tools.push(
    tool(
      'omo_agents',
      '差异化 agent 角色库（复刻 OmO 11-agent 体系：sisyphus/prometheus/atlas/oracle/librarian/explore/metis/momus/hephaestus/multimodal-looker/sisyphus-junior）。action=list 看角色清单（职责/category 模型路线/推荐 DSH 委托工具）；action=brief role=<名> task=<任务> files=[...] 生成完整委托简报（角色 prompt + 纪律 + 停止条件 + 证据要求 + category 模型绑定），可直接用 delegate_as(role=<名>) 一键派发执行；action=team goal=<目标> members=[角色...] 生成 agent_teams 建队方案（含每成员 provider/model 绑定与派发步骤）。',
      {
        action: { type: 'string', enum: ['list', 'brief', 'team'], required: true, default: 'list' },
        role: { type: 'string', description: 'brief 时必填：角色名（见 list）' },
        task: { type: 'string', description: 'brief：该角色的任务；team：建队目标' },
        files: { type: 'array', items: { type: 'string' }, description: 'brief 可选：涉及文件' },
        members: { type: 'array', items: { type: 'string' }, description: 'team 可选：角色名列表（缺省用 oracle+librarian+hephaestus+sisyphus-junior 默认队形）' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          roles: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' }, title: { type: 'string' }, mission: { type: 'string' },
                category: { type: 'string' }, dshTool: { type: 'string' }, when: { type: 'string' },
              },
            },
          },
          brief: { type: 'string' },
          plan: { type: 'string' },
          note: { type: 'string' },
        },
      },
      (_a, v) => {
        if (v.action === 'brief') return text(String(v.brief || v.note || ''))
        if (v.action === 'team') return text(String(v.plan || v.note || ''))
        const roles = (v.roles as Array<AnyObj>) ?? []
        return text(
          'omo_agents 角色库（OmO 11-agent 复刻）\n' +
            roles.map((r) => `- ${r.name}（${r.title}）[${r.category}] -> ${r.dshTool}\n    ${r.mission}\n    何时: ${r.when}`).join('\n'),
        )
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const modelCfg = loadLayeredConfig(ws).merged
        const action = String(args.action || 'list')
        if (action === 'list') {
          return {
            ok: true,
            action,
            roles: AGENT_ROLES.map((r) => ({ name: r.name, title: r.title, mission: r.mission, category: r.category, dshTool: (r.name === 'sisyphus' || r.name === 'multimodal-looker') ? r.dshTool : `delegate_as role=${r.name}`, when: r.when })),
            note: '用 action=brief 生成委托简报；action=team 生成建队方案',
          }
        }
        if (action === 'brief') {
          const role = findRole(String(args.role || ''))
          if (!role) return { ok: false, action, note: `unknown role "${String(args.role || '')}" - see action=list` }
          const task = String(args.task || '')
          if (!task.trim()) return { ok: false, action, note: 'task required' }
          const files = Array.isArray(args.files) ? (args.files as unknown[]).map(String) : []
          // 同一有界规则组合（projectContext）服务 brief 与 hook：files 目标带
          // 祖先规则包（files 为空仅根/常设规则），局部范围不提升为任务全局规则。
          const contextPkg = ruleContextForTargets(ws, files)
          return { ok: true, action, brief: buildBrief(role, task, files, modelCfg, contextPkg.block), note: `简报已生成（可经 delegate_as role=${role.name} 一键派发）` }
        }
        // team
        const goal = String(args.task || args.goal || '')
        if (!goal.trim()) return { ok: false, action, note: 'team requires goal (pass via task)' }
        const names = Array.isArray(args.members) && args.members.length ? (args.members as unknown[]).map(String) : ['oracle', 'librarian', 'hephaestus', 'sisyphus-junior']
        const roles = names.map((n) => findRole(n)).filter((r): r is NonNullable<typeof r> => Boolean(r))
        const missing = names.filter((n) => !findRole(n))
        if (roles.length === 0) return { ok: false, action, note: `no valid roles in ${JSON.stringify(names)}` }
        return { ok: true, action, plan: buildTeamPlan(goal, roles, modelCfg), note: missing.length ? `ignored unknown roles: ${missing.join(', ')}` : '建队方案已生成' }
      },
    ),
  )

  // ─────────────────────────── delegate_as (Tier-2 role delegation) ─
  tools.push(
    tool(
      'delegate_as',
      '一键带角色委托（OmO call_omo_agent 手感）：role=OmO 角色（explore/librarian/prometheus/atlas/oracle/metis/momus/hephaestus/sisyphus-junior），内部自动查角色表→组装纪律简报→经 subagents 服务派生子代理并回收。模型按每角色三级解析：delegate_roles.<role> 覆盖 > categories.<category> 决策层 > flash/heavy 档默认（均可经 omo.jsonc 配置）；只读角色（librarian/review/oracle）宿主级硬禁 write/edit。默认后台 continuable（立即返回 subagentId，结算后运行时通知母会话；send_message 可续聊同一子代理）；run_in_background=false 时同步等待最终报告。sisyphus 与 multimodal-looker 不可派发（分别是主会话本体/视觉工具通道）。',
      {
        role: { type: 'string', required: true, description: 'OmO 角色名（omo_agents action=list 可查）' },
        task: { type: 'string', required: true, description: '任务描述（并入简报「任务」段）' },
        files: { type: 'array', items: { type: 'string' }, description: '可选：涉及文件/目录' },
        extras: { type: 'string', description: '可选：本次临时补充要求（裁剪/追加，不污染角色模板）' },
        run_in_background: { type: 'boolean', description: '默认 true：continuable 后台派发立即返回 subagentId；false：同步等待最终报告' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          role: { type: 'string' },
          channel: { type: 'string' },
          native_tool: { type: 'string' },
          route: { type: 'string' },
          read_only: { type: 'boolean' },
          mode: { type: 'string' },
          subagentId: { type: 'string' },
          runId: { type: 'string' },
          stopReason: { type: 'string' },
          output: { type: 'string' },
          note: { type: 'string' },
        },
      },
      (_a, v) => {
        if (!v.ok) return text(String(v.note || 'delegate_as 失败'))
        if (v.mode === 'continuable') {
          return text(`[${v.role}] 已派发 → ${v.native_tool}（route=${v.route}${v.read_only ? '，只读(write/edit 已禁)' : ''}）\nsubagentId=${v.subagentId}\n后台 continuable：结算后运行时通知母会话；send_message(subagent_id) 可续聊同一子代理。`)
        }
        if (v.note && v.output === undefined) return text(`[${v.role}] 前台委托未干净收尾（stopReason=${v.stopReason ?? 'n/a'}）：\n${v.note}`)
        return text(String(v.output || '(子代理无文本输出)'))
      },
      async (args, exec) => {
        const roleName = String(args.role || '')
        const task = String(args.task || '')
        const res = resolveChannel(roleName)
        if (!res.ok || !res.role || !res.spec) return { ok: false, role: roleName, note: res.reason }
        if (!task.trim()) return { ok: false, role: roleName, note: 'task required' }
        const subagents = getSubagentsService(hostCtx)
        if (!subagents) return { ok: false, role: roleName, note: 'subagents 服务不可用（宿主未装配 dsh-subagent）' }
        const ws = wsFromExec(config, exec)
        const modelCfg = loadLayeredConfig(ws).merged
        const files = Array.isArray(args.files) ? (args.files as unknown[]).map(String) : []
        const routes: DelegateRoutes = { provider: config.delegateProvider, flash: config.delegateFlashRoute, heavy: config.delegateHeavyRoute }
        // 子代理会话内禁再派发：只 deny 宿主实际已注册的插件派发工具（restrict 对未知名
        // 响亮失败；宿主具名通道 subagent_* 非本插件注册，交由 nested-delegation-guard 兜底）
        const denySpawn = registeredToolNames.filter((n) => isDelegationTool(n))
        const spec = res.spec
        const resolved = resolveRoleRoute(res.role, spec, routes, modelCfg)
        const routeStr = `${resolved.provider}/${resolved.model}（${resolved.source}）`
        // 与 omo_agents brief 同一 context 组合（projectContext）：files 目标祖先
        // 规则包入简报，局部范围按目标标注、不提升为全局。
        const contextPkg = ruleContextForTargets(ws, files)
        const prompt = composeDelegationPrompt(res.role, task, files, String(args.extras || ''), modelCfg, contextPkg.block)
        const outcome = await runDelegation(subagents, {
          role: res.role,
          spec,
          prompt,
          label: `[omo:${res.role.name}] ${task.slice(0, 60)}`,
          parent: exec.agent,
          signal: exec.signal,
          routes,
          merged: modelCfg,
          denyTools: denySpawn,
        }, args.run_in_background === false)
        if (outcome.mode === 'continuable') {
          if (outcome.error) return { ok: false, role: roleName, channel: spec.id, native_tool: spec.nativeTool, route: routeStr, read_only: spec.readOnly, note: outcome.error }
          delegateGoalGuardDispatch(exec.agent)
          return { ok: true, role: roleName, channel: spec.id, native_tool: spec.nativeTool, route: routeStr, read_only: spec.readOnly, mode: 'continuable', subagentId: String(outcome.subagentId) }
        }
        // foreground：逐字段挂值，绝不携带 undefined（lossless JSON 拒绝）
        const fg: AnyObj = { ok: !outcome.error, role: roleName, channel: spec.id, native_tool: spec.nativeTool, route: routeStr, read_only: spec.readOnly, mode: 'foreground', output: outcome.output ?? '' }
        if (outcome.runId !== undefined) fg.runId = outcome.runId
        if (outcome.stopReason !== undefined) fg.stopReason = outcome.stopReason
        if (outcome.error !== undefined && outcome.output !== undefined) fg.note = outcome.error
        else if (outcome.error !== undefined) { fg.ok = false; fg.note = outcome.error }
        return fg
      },
    ),
  )

  // ─────────────────────────── omo_docs (context7 bridge) ──────────
  tools.push(
    tool(
      'omo_docs',
      '官方文档检索（复刻 OmO context7 MCP，桥接 context7.com 免费 API）：action=search query=<关键词> 搜库（返回 library id/标题/描述/信任分）；action=get library=<owner/repo> topic=<主题> tokens=<500-12000> 拉取该库聚焦文档（markdown）。网络不可达时如实报告并建议降级 web_search。',
      {
        action: { type: 'string', enum: ['search', 'get'], required: true },
        query: { type: 'string', description: 'search 时的检索词' },
        library: { type: 'string', description: 'get 时的库 id（owner/repo 形式，先 search 拿）' },
        topic: { type: 'string', description: 'get 可选：聚焦主题' },
        tokens: { type: 'integer', description: 'get 可选：文档长度预算（500-12000，默认 4000）' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, action: { type: 'string' }, query: { type: 'string' }, library: { type: 'string' },
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } },
            },
          },
          docs: { type: 'string' },
          note: { type: 'string' },
        },
      },
      (_a, v) => {
        const hits = (v.results as Array<AnyObj>) ?? []
        if (v.action === 'search') {
          return text('context7 文档检索\n' + hits.map((h) => `- ${h.id} - ${h.title}\n    ${h.description}`).join('\n') + `\n${String(v.note || '')}`)
        }
        return text(`context7 文档：${String(v.library || '')}\n${String(v.note || '')}\n\n${String(v.docs || '')}`)
      },
      async (args, exec) => {
        const action = String(args.action || 'search')
        if (action === 'search') {
          const r = await docsSearch(String(args.query || ''), 5)
          return { ok: r.ok, action, query: r.query, results: r.results?.map((h) => ({ id: h.id, title: h.title, description: h.description })), note: r.note }
        }
        const r = await docsGet(String(args.library || ''), String(args.topic || ''), Number(args.tokens ?? 4000))
        return { ok: r.ok, action, library: r.library, docs: r.docs, note: r.note }
      },
    ),
  )

  // ─────────────────────────── omo_look_at (vision orchestrator) ───
  tools.push(
    tool(
      'omo_look_at',
      '视觉查看编排器（复刻 OmO look-at / multimodal-looker）：把"看图意图"编译成精准的视觉提问 + 原生工具调用方案。intent：ui-diagnose（UI 截图诊断：布局/遮挡/一致性/可读性逐项过）、chart-read（图表读数：轴/系列/趋势/异常）、text-transcribe（全文转录）、compare（两图对比，第二张写在 question）、general（客观描述）。返回的 prompt 直接传给 describe_image（视觉模型，图不进对话）；需要亲自看时用 read_image。',
      {
        intent: { type: 'string', enum: LOOK_INTENTS, required: true, default: 'general' },
        image: { type: 'string', required: true, description: '图片路径 / http(s) URL / attachment id' },
        question: { type: 'string', description: '关注点；compare 时写第二张图的路径/URL' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, intent: { type: 'string' }, image: { type: 'string' },
          prompt: { type: 'string' }, tool: { type: 'string' },
          args: { type: 'object', additionalProperties: true },
          note: { type: 'string' },
        },
      },
      (_a, v) =>
        text(
          `omo_look_at [${String(v.intent)}] -> ${String(v.tool)}\n` +
            `把下面的 prompt 连同图片 (${String(v.image)}) 传给 ${String(v.tool)}：\n\n${String(v.prompt)}`,
        ),
      async (args, exec) => {
        const image = String(args.image || '')
        if (!image.trim()) return { ok: false, intent: String(args.intent || 'general'), image: '', prompt: '', tool: 'describe_image', args: {}, note: 'image required' }
        const r = lookAt(String(args.intent || 'general'), image, String(args.question || ''))
        return { ok: r.ok, intent: r.intent, image: r.image, prompt: r.prompt, tool: r.tool, args: r.args, note: r.note }
      },
    ),
  )

  // ─────────────────────────── omo_skills (SKILL.md loader) ────────
  tools.push(
    tool(
      'omo_skills',
      '动态技能加载器（复刻 OmO 自定义技能面）：扫描工作区 .opencode/skills/<name>/SKILL.md 与 .omo/skills/<name>/SKILL.md（frontmatter：description 必填，name 缺省用目录名，可选 whenToUse；正文为技能内容），解析后注册为 DSH 运行时技能（当轮即可被模型/用户调用）。action=scan 扫描并注册（幂等）；action=list 看本进程已注册清单。',
      {
        action: { type: 'string', enum: ['scan', 'list'], required: true, default: 'scan' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, action: { type: 'string' },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { name: { type: 'string' }, description: { type: 'string' }, file: { type: 'string' }, status: { type: 'string' }, reason: { type: 'string' } },
            },
          },
          registered: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
      (_a, v) => {
        const skills = (v.skills as Array<AnyObj>) ?? []
        const reg = (v.registered as string[]) ?? []
        if (v.action === 'list') return text('动态技能（本进程已注册）:\n' + (reg.map((n) => `- ${n}`).join('\n') || '(none)'))
        return text(
          'SKILL.md 扫描结果:\n' +
            (skills.map((s) => `- ${s.name} [${s.status}] ${s.file}${s.reason ? ' - ' + String(s.reason) : ''}`).join('\n') || '(未发现 SKILL.md)') +
            `\n本进程累计注册: ${reg.length}`,
        )
      },
      async (args, exec) => {
        const action = String(args.action || 'scan')
        if (action === 'list') {
          return { ok: true, action, registered: listRegistered(), note: '本进程已注册的动态技能' }
        }
        const ws = wsFromExec(config, exec)
        const skills = registerSkills(ws, (d) => ctxSkillsRegister(d))
        return {
          ok: true,
          action,
          skills: skills.map((s) => ({ name: s.name, description: s.description, file: s.file, status: s.status, reason: s.reason ?? '' })),
          registered: listRegistered(),
          note: `${skills.filter((s) => s.status === 'registered').length} 新注册 / ${skills.filter((s) => s.status === 'skipped').length} 跳过 / ${skills.filter((s) => s.status === 'invalid').length} 无效`,
        }
      },
    ),
  )

  // ─────────────────────────── omo_lsp ──────────────────────────────
  tools.push(
    tool(
      'omo_lsp',
      '语言服务器（复刻 oh-my-openagent lsp-tools，内嵌 vscode-languageserver-protocol）：按文件语言拉起真实 LSP 服务器（typescript-language-server/pyright/gopls/…，未装则如实返回）做精确代码智能。actions: status(可用服务器与会话)/diagnostics(诊断)/definition(跳转定义)/references(查找引用)/rename(改名，apply=true 落盘)/symbols(文件符号)。line/character 为 1 基。',
      {
        action: { type: 'string', enum: ['status', 'diagnostics', 'definition', 'references', 'rename', 'symbols'], required: true },
        file: { type: 'string', description: '相对工作区的文件（status 可省）' },
        line: { type: 'integer', description: '1 基行号（定义/引用/改名需要）' },
        character: { type: 'integer', description: '1 基列号（定义/引用/改名需要）' },
        new_name: { type: 'string', description: 'rename 的新名字' },
        include_declaration: { type: 'boolean', default: false },
        apply: { type: 'boolean', default: false, description: 'rename 是否直接落盘（默认只计算不写）' },
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' }, available: { type: 'boolean' }, lang: { type: 'string' },
          action: { type: 'string' }, note: { type: 'string' }, server: { type: 'string' },
          applied: { type: 'boolean' },
          markers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          locations: { type: 'array', items: { type: 'object', additionalProperties: true } },
          symbols: { type: 'array', items: { type: 'object', additionalProperties: true } },
          edits: { type: 'array', items: { type: 'object', additionalProperties: true } },
          sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          servers: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      (_a, v) => {
        const head = `LSP ${String(v.action)}${v.lang ? ' [' + String(v.lang) + ']' : ''}${v.available === false ? ' — 不可用: ' + String(v.note) : ''}`
        const lines = [head]
        const mk = (v.markers as Array<AnyObj>) ?? []
        if (mk.length) lines.push(mk.slice(0, 25).map((m) => `  ${m.severity} ${String(m.file)}:${m.line}:${m.column} — ${m.message}`).join('\n'))
        const loc = (v.locations as Array<AnyObj>) ?? []
        if (loc.length) lines.push(loc.slice(0, 25).map((l) => `  ${l.file}:${l.startLine}:${l.startColumn}`).join('\n'))
        const sy = (v.symbols as Array<AnyObj>) ?? []
        if (sy.length) lines.push(sy.slice(0, 40).map((x) => `  ${x.startLine}: ${x.name}`).join('\n'))
        const ed = (v.edits as Array<AnyObj>) ?? []
        if (ed.length) lines.push(`  ${ed.length} 处编辑 ${v.applied ? '[已落盘]' : '[未写盘]'}`)
        if (v.servers) {
          const sv = (v.servers as Array<AnyObj>) ?? []
          lines.push('服务器可用性:')
          lines.push(sv.map((x) => `  - ${x.lang}: ${x.available ? '✓ ' + String(x.binary) : '✗ ' + String(x.note)}`).join('\n'))
        }
        if (v.sessions) {
          const ss = (v.sessions as Array<AnyObj>) ?? []
          lines.push('活动 LSP 会话: ' + String(ss.length))
        }
        return text(lines.join('\n'))
      },
      async (args, exec) => {
        const ws = wsFromExec(config, exec)
        const action = String(args.action || 'status')
        if (action === 'status') {
          return { ok: true, available: true, action, note: '', servers: serverAvailability(), sessions: lspMgr.sessions() }
        }
        const file = String(args.file || '')
        if (!file) return { ok: false, available: false, action, note: 'file required for ' + action }
        const abs = pathResolve(ws, file)
        let text = ''
        try { text = await readFileText(abs) } catch { return { ok: false, available: false, action, note: 'cannot read ' + file } }
        const { client, lang, reason } = lspMgr.clientFor(ws, file)
        if (!client || !lang) {
          return { ok: false, available: false, lang: lang, action, note: reason }
        }
        const server = (client as unknown as { lang: string }).lang || lang
        const line = Number(args.line ?? 1)
        const ch = Number(args.character ?? 1)
        const includeDecl = args.include_declaration !== false
        const apply = Boolean(args.apply)
        switch (action) {
          case 'diagnostics': {
            const markers = await client.diagnostics(file, text)
            return { ok: true, available: true, lang, action, note: markers.length + ' diagnostics', server, markers }
          }
          case 'definition': {
            const locations = await client.definition(file, text, line, ch)
            return { ok: true, available: true, lang, action, note: locations.length + ' definitions', server, locations }
          }
          case 'references': {
            const locations = await client.references(file, text, line, ch, includeDecl)
            return { ok: true, available: true, lang, action, note: locations.length + ' references', server, locations }
          }
          case 'rename': {
            const newName = String(args.new_name || '')
            if (!newName) return { ok: false, available: true, lang, action, note: 'new_name required for rename', server }
            const r = await client.rename(file, text, line, ch, newName, apply)
            return { ok: true, available: true, lang, action, note: r.edits.length + ' edits', server, edits: r.edits, applied: r.applied }
          }
          case 'symbols': {
            const symbols = await client.symbols(file, text)
            return { ok: true, available: true, lang, action, note: symbols.length + ' symbols', server, symbols }
          }
          default:
            return { ok: false, available: true, lang, action, note: 'unknown action' }
        }
      },
    ),
  )

  return tools
}

function pathResolve(ws: string, file: string): string {
  return path.resolve(ws, file)
}

async function readFileText(abs: string): Promise<string> {
  return readFile(abs, 'utf8')
}

/** Build client-facing status payload for the default/last workspace. */
function apiStatus(config: Config): AnyObj {
  const ws = wsForConfig(config)
  const rules = scanRules(ws)
  const b = boulderSummary(ws)
  const reg = new MonitorRegistry(ws)
  return {
    plugin: PLUGIN_ID,
    workspace: ws,
    tools: registeredToolNames.length > 0 && registeredToolNames.length >= buildTools(config).length - 2 ? registeredToolNames : buildTools(config).map((t) => String((t as unknown as { name?: string }).name ?? '')),
    ts: nowTs(),
    rules: {
      total: rules.length,
      alwaysApply: rules.filter((r) => r.alwaysApply).length,
      files: rules.slice(0, 40).map((r) => r.relPath),
    },
    boulder: { counts: b.counts, thread: b.markdown.slice(0, 400) },
    monitors: reg.list().map((m) => ({ id: m.id, command: m.command, running: m.running, exitCode: m.exitCode })),
    sections: [...SECTIONS],
  }
}

const isPlainObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 子代理模型路由视图（设置页数据源）：角色/分类三级解析、候选模型、
 * 各层高优先级覆盖扫描与托管层文件状态。
 */
async function apiModelRoutes(config: Config): Promise<AnyObj> {
  const ws = wsForConfig(config)
  const view = loadLayeredConfig(ws)
  const merged = view.merged
  const routes: DelegateRoutes = { provider: config.delegateProvider, flash: config.delegateFlashRoute, heavy: config.delegateHeavyRoute }

  // 每角色三级解析（delegate_roles > categories > tier 档位）；无派发通道的角色
  // （sisyphus / multimodal-looker）展示其 category 决策层结论。
  const roles = AGENT_ROLES.map((role) => {
    const spec = CHANNEL_BY_DSH_TOOL[role.dshTool]
    let resolution: { provider: string; model: string; source: string }
    if (spec) {
      resolution = resolveRoleRoute(role, spec, routes, merged)
    } else {
      const dec = resolveCategory({ category: role.category, mergedConfig: merged })
      resolution = dec.chosen
        ? { provider: dec.chosen.provider, model: dec.chosen.model, source: 'category(default)' }
        : { provider: '', model: '', source: 'category(default)' }
    }
    return {
      name: role.name,
      title: role.title,
      category: role.category,
      channel: role.dshTool,
      tier: spec?.tier ?? '',
      readOnly: spec?.readOnly ?? false,
      resolution,
    }
  })

  // 分类决策层展示
  const categories = CATEGORIES.map((cat) => {
    const dec = resolveCategory({ category: cat, mergedConfig: merged })
    return {
      name: cat,
      role: CATEGORY_ROLES[cat],
      chosen: dec.chosen ? routeLabel(dec.chosen) : '',
      source: dec.source,
      fallbackCount: dec.chain.length,
    }
  })

  // 候选模型：动态取自已注册 provider 的模型目录（llm.listProviders × listModels，
  // 随 provider 配置变化实时刷新），再补档位/内置默认/配置中出现过的 'p/m' 串。
  const seen = new Set<string>()
  const pushModel = (s: string | undefined | null): void => {
    if (s && s.includes('/') && !seen.has(s)) seen.add(s)
  }
  const providersView: AnyObj[] = []
  const providerFailures: string[] = []
  const llmGet = ((hostCtx as unknown as { get?: (k: string) => unknown }).get) ?? (() => undefined)
  const llm = llmGet('llm') as { listProviders?: () => Array<AnyObj>; listModels?: (p: string) => Promise<Array<AnyObj>> } | undefined
  if (llm && typeof llm.listProviders === 'function' && typeof llm.listModels === 'function') {
    try {
      const providers = llm.listProviders() ?? []
      for (const p of providers) {
        const id = String(p?.id ?? '')
        if (!id) continue
        try {
          const models = await llm.listModels(id)
          const entries = (models ?? []).map((m) => ({ provider: id, model: String(m?.id ?? '') })).filter((m) => m.model)
          providersView.push({ provider: id, credentialEnv: p?.apiKeyEnv !== undefined ? String(p.apiKeyEnv) : undefined, count: entries.length, models: entries.map((m) => m.model) })
          for (const m of entries) pushModel(`${m.provider}/${m.model}`)
        } catch (e) {
          providerFailures.push(`${id}: ${String(e)}`)
        }
      }
    } catch (e) {
      providerFailures.push(`llm.listProviders: ${String(e)}`)
    }
  } else {
    providerFailures.push('llm 服务不可用（未装配 @deepseek-ai/dsh-llm）')
  }
  pushModel(config.delegateFlashRoute)
  pushModel(config.delegateHeavyRoute)
  pushModel(DEFAULT_ROUTES.flash)
  pushModel(DEFAULT_ROUTES.heavy)
  for (const chain of Object.values(DEFAULT_CHAINS)) {
    for (const r of chain) pushModel(`${r.provider}/${r.model}`)
  }
  const scanSpec = (v: unknown): void => {
    if (typeof v === 'string') { pushModel(v); return }
    if (!isPlainObj(v)) return
    if (typeof v.provider === 'string' && typeof v.model === 'string') { pushModel(`${v.provider}/${v.model}`); return }
    scanSpec(v.model) // 设置页写入形态：categories[cat].model = { provider, model }
  }
  const oc = ((merged.opencode ?? merged['[opencode]']) ?? {}) as AnyObj
  if (isPlainObj(oc.delegate_roles)) for (const v of Object.values(oc.delegate_roles)) scanSpec(v)
  if (isPlainObj(oc.categories)) for (const v of Object.values(oc.categories)) scanSpec(v)
  const score = (s: string): number => {
    const low = s.toLowerCase()
    if (low.includes('flash')) return 0
    if (low.includes('deepseek') || low.includes('pro')) return 1
    return 2
  }
  const available = [...seen].sort((a, b) => score(a) - score(b))

  // 每 key 只记最高优先级来源：files 逆序扫描（后 push 者高）。
  const ocOf = (p: unknown): AnyObj => {
    if (!isPlainObj(p)) return {}
    return ((p.opencode ?? p['[opencode]']) ?? {}) as AnyObj
  }
  const normalizeOverride = (raw: unknown): string | null => {
    if (typeof raw === 'string') return raw.includes('/') ? raw : null
    if (!isPlainObj(raw)) return null
    if (typeof raw.provider === 'string' && typeof raw.model === 'string') return `${raw.provider}/${raw.model}`
    return normalizeOverride(raw.model) // 设置页写入形态解析
  }
  const pickOverride = (key: string, bucketName: 'delegate_roles' | 'categories'): { value: string | null; file: string } | null => {
    for (let i = view.files.length - 1; i >= 0; i -= 1) {
      const src = view.files[i]
      if (!src.existed) continue
      const bucket = ocOf(src.parsed)[bucketName]
      if (!isPlainObj(bucket)) continue
      if (!(key in bucket)) continue
      return { value: normalizeOverride(bucket[key]), file: src.path }
    }
    return null
  }
  const roleOverrides: AnyObj = {}
  for (const role of AGENT_ROLES) {
    const hit = pickOverride(role.name, 'delegate_roles')
    if (hit) roleOverrides[role.name] = hit
  }
  const categoryOverrides: AnyObj = {}
  for (const cat of CATEGORIES) {
    const hit = pickOverride(cat, 'categories')
    if (hit) categoryOverrides[cat] = hit
  }

  return {
    ok: true,
    ts: nowTs(),
    roles,
    categories,
    available,
    providers: providersView,
    providerFailures,
    roleOverrides,
    categoryOverrides,
    settings: settingsMirror(),
    files: [
      { scope: 'user', path: userRoutesFile(), existed: routesLayerExists(userRoutesFile()) },
      { scope: 'workspace', path: workspaceRoutesFile(ws), existed: routesLayerExists(workspaceRoutesFile(ws)) },
    ],
  }
}

/** 探测 settings 服务镜像：设置页 tab 是否会把我们的卡片纳入渲染。 */
function settingsMirror(): AnyObj {
  const svcGet = ((hostCtx as unknown as { get?: (k: string) => unknown }).get) ?? (() => undefined)
  const svc = svcGet('settings') as { describe?: (o: { redactSecrets?: boolean }) => Array<AnyObj> } | undefined
  if (settingsNsError) return { available: true, served: [], registered: false, error: settingsNsError }
  if (!svc || typeof svc.describe !== 'function') return { available: false, served: [], registered: false, error: settingsNsError || 'settings describe unavailable' }
  try {
    const desc = svc.describe({ redactSecrets: true })
    const served = (desc ?? []).map((d) => String(d.ns ?? ''))
    return { available: true, served, registered: served.includes('dsh-oh-my-agent') }
  } catch (e) {
    return { available: false, served: [], registered: false, error: String(e) }
  }
}

/** Register a side effect whose disposer may be typed `unknown`. */
function regOnce(ctx: Context, fn: () => unknown, tag: string): void {
  ctx.effect(() => {
    const disposer = fn()
    if (typeof disposer === 'function') return () => (disposer as () => void)()
    return () => {}
  }, tag)
}

export function apply(ctx: Context, config: Config): void {
  hostCtx = ctx
  // Optional dependency: projection-capable hosts get the durable view without making it a top-level requirement.
  ;(ctx as unknown as OptionalInjectCtx).inject(['sessionProjections'], (scope) => {
    const projections = scope.sessionProjections as { register(unit: unknown): unknown; stateOf?: (session: unknown, key: string) => unknown }
    // Durability hang-off: `session.projections.get()` is not a public API, so the read
    // path must go through this service (bound here, re-read at call time).
    bindProjectionHost(projections)
    if (projections && typeof projections.register === 'function') {
      regOnce(ctx, () => projections.register(sessionModeProjectionUnit()), 'dsh-oh-my-agent: session mode projection')
    }
  })
  // Optional command package remains a nested injection, never a root dependency.
  ;(ctx as unknown as OptionalInjectCtx).inject(['commands'], (scope) => {
    const commands = scope.commands as { register(definition: AnyObj): unknown }
    if (!commands || typeof commands.register !== 'function') return
    regOnce(ctx, () => commands.register({
      definitionId: 'omo-session-mode',
      name: 'omo-mode',
      description: '切换会话模式：off | plan（prometheus）| exec（atlas）',
      input: { hint: '[off|plan|exec]' },
      handler: async ({ agent, rawInput }: { agent: unknown; rawInput: string }) => {
        const value = rawInput.trim().toLowerCase()
        const mode: SessionMode | null = value === 'off' ? 'off' : value === 'plan' || value === 'on' ? 'prometheus' : value === 'exec' ? 'atlas' : null
        if (!mode) return { kind: 'error', text: '用法: /omo-mode off|plan|exec（on 兼容 plan）' }
        const ws = wsForConfig(config, ((agent as { session?: { header?: { cwd?: string } } } | undefined)?.session?.header?.cwd))
        const merged = loadLayeredConfig(ws).merged
        const routes: DelegateRoutes = { provider: config.delegateProvider, flash: config.delegateFlashRoute, heavy: config.delegateHeavyRoute }
        const route = mode === 'atlas' ? roleModelRoute('atlas', merged, routes) : mode === 'prometheus' ? prometheusPlanRoute(merged, routes) : undefined
        const result = await setSessionMode(agent, mode, route, defaultsSelection())
        return result.ok
          ? { kind: 'success', text: `会话模式: ${mode}${result.route ? `（route=${result.route.provider}/${result.route.model}）` : ''}` }
          : { kind: 'error', text: `切换失败: ${result.reason || '未知错误'}` }
      },
    }), 'dsh-oh-my-agent: /omo-mode command')
  })
  ensureDir(omoDir(wsForConfig(config), '_meta'))
  ctxSkillsRegister = (d: unknown) => ((ctx as unknown as SkillsCtx).skills).register(d)

  // omo.jsonc host-wide toggles (user layer): disabled_tools + feature switches
  const machine = loadUserConfig()
  const disabledTools = new Set(mergedTools(machine))
  const hashlineOn = mergedToggle(machine, 'hashline_edit', 'enabled', true)
  const monitorOn = mergedToggle(machine, 'monitor', 'enabled', true)
  const allTools = buildTools(config)
  const toolsToRegister = allTools.filter((t) => {
    const n = t.name
    if (disabledTools.has(n)) return false
    if (!hashlineOn && (n === 'omo_hashline_edit' || n === 'omo_hashline_lines')) return false
    if (!monitorOn && n === 'omo_monitor') return false
    return true
  })
  registeredToolNames = toolsToRegister.map((t) => t.name)

  // tools
  for (const def of toolsToRegister) {
    regOnce(ctx, () => ((ctx as unknown as ToolsCtx).tools).register(def), `dsh-oh-my-agent tool: ${String(def.name)}`)
  }

  // skills
  for (const reg of skillRegistrations()) {
    regOnce(ctx, () => ((ctx as unknown as SkillsCtx).skills).register(reg), `dsh-oh-my-agent skill: ${reg.name}`)
  }

  // settings namespace 注册：设置页「插件配置」tab 只派发宿主 settings 服务已注册
  // namespace 的卡片（ConfigurablePluginsTab 取 describe 镜像 ∩ slot entries）；
  // 不注册则 key=dsh-oh-my-agent 的 settings.plugin.item 卡片永不渲染。
  // schema 用宽松空对象——本卡片不消费 settings 值，只需 namespace 被 serve。
  // 注册失败绝不拖垮 fiber：捕获并记录，供 settingsMirror() 暴露。
  settingsNsError = ''
  const svcGet = ((ctx as unknown as { get?: (k: string) => unknown }).get) ?? (() => undefined)
  const settingsSvc = svcGet('settings') as { register?: (ns: string, schema: unknown, options?: unknown) => unknown } | undefined
  if (settingsSvc && typeof settingsSvc.register === 'function') {
    regOnce(ctx, () => {
      try {
        return settingsSvc.register!('dsh-oh-my-agent', z.object({}).loose(), { base: config })
      } catch (e) {
        // 双挂载（include + patch 两路 fiber）时第二实例会抛 already registered：
        // 视为正常（namespace 已由另一实例持有，随该 fiber 生命周期管理）。
        settingsNsError = /already registered/i.test(String(e)) ? '' : String(e)
        return () => {}
      }
    }, 'dsh-oh-my-agent: settings namespace')
  } else {
    settingsNsError = 'settings service unavailable'
  }

  // webServer API (client panel data source)
  const webServer = (ctx as unknown as AnyObj).webServer as { register: (o: AnyObj, tag?: string) => unknown } | undefined
  if (webServer) {
    /**
     * Idempotent route registration (first-wins). The webserver's exact-path
     * table is PROCESS-GLOBAL and throws on a second identical handler, so a
     * dual mount (preset include in agent.cordis.yml + a host-plane injection)
     * used to blow up the whole preset mount transaction. When another
     * instance already serves the path, degrade to a warn + no-op disposer.
     */
    const regRoute = (route: AnyObj): unknown => {
      try {
        return webServer.register(route)
      } catch (e) {
        if (/duplicate/i.test(String(e))) {
          try { ctx.logger?.warn?.(`[dsh-oh-my-agent] route ${String(route.path)} already registered by another instance - dual-mount tolerated (first instance serves it)`) } catch { /* ignore */ }
          return () => {}
        }
        throw e
      }
    }
    const h = (fn: (req: unknown, res: unknown) => void) => (req: unknown, res: unknown) => fn(req, res)
    regOnce(ctx, () => regRoute({
      kind: 'exact',
      path: '/dsh-oh-my-agent/api/status',
      handler: h((_req, res) => json(res, apiStatus(config))),
    }), 'dsh-oh-my-agent: api/status')

    regOnce(ctx, () => regRoute({
      kind: 'exact',
      path: '/dsh-oh-my-agent/api/goalguard',
      handler: h((_req, res) => json(res, goalGuard
        ? { ok: true, guarded: goalGuard.guardedCount(), states: goalGuard.snapshot(), diag: goalGuardDiag }
        : { ok: true, guarded: 0, states: [], diag: goalGuardDiag })),
    }), 'dsh-oh-my-agent: api/goalguard')

    regOnce(ctx, () => regRoute({
      kind: 'exact',
      path: '/dsh-oh-my-agent/api/scan',
      handler: h(async (_req, res) => {
        const ws = wsForConfig(config)
        const state = refreshRulesState(ws)
        json(res, { ok: true, ws, files: state.files.map((r) => r.relPath), compiledFile: state.compiledFile })
      }),
    }), 'dsh-oh-my-agent: api/scan')

    regOnce(ctx, () => regRoute({
      kind: 'exact',
      path: '/dsh-oh-my-agent/api/boulder',
      handler: h(async (_req, res) => {
        const ws = wsForConfig(config)
        const b = boulderSummary(ws)
        json(res, { ok: true, counts: b.counts, summary: b.markdown })
      }),
    }), 'dsh-oh-my-agent: api/boulder')

    regOnce(ctx, () => regRoute({
      kind: 'exact',
      path: '/dsh-oh-my-agent/api/monitors',
      handler: h(async (_req, res) => {
        const ws = wsForConfig(config)
        json(res, { ok: true, monitors: new MonitorRegistry(ws).list() })
      }),
    }), 'dsh-oh-my-agent: api/monitors')

    regOnce(ctx, () => regRoute({
      kind: 'exact',
      path: '/dsh-oh-my-agent/api/note',
      method: 'POST',
      handler: ((req: { on: (ev: string, cb: (chunk: string) => void) => void }, res: unknown) => {
        const ws = wsForConfig(config)
        let body = ''
        req.on('data', (chunk) => { body += String(chunk) })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}') as { section?: string; content?: string }
            const raw = String(parsed.section || 'learnings')
            const section = isSection(raw) ? raw : 'learnings'
            const r = appendNote(ws, section, String(parsed.content || ''))
            json(res, { ok: true, section: r.section, count: r.count, message: r.message })
          } catch (e) {
            json(res, { ok: false, message: String(e) })
          }
        })
      }),
    }), 'dsh-oh-my-agent: api/note')

    // 注意：webServer 的 exact 表只按 path 键（register 重路径即抛 duplicate，
    // match 也只取 pathname），method 不参与路由。同路径 GET+POST 必须合并为
    // 单一 handler，内部按 req.method 分发——否则第二条注册被 dup 容错降级成
    // no-op，POST 会落到 GET 分支（只读视图、不写盘）。
    regOnce(ctx, () => regRoute({
      kind: 'exact',
      path: '/dsh-oh-my-agent/api/modelroutes',
      handler: ((req: { method?: string; on: (ev: string, cb: (chunk: string) => void) => void }, res: unknown) => {
        if (String(req.method || 'GET').toUpperCase() !== 'POST') {
          apiModelRoutes(config).then((v) => json(res, v)).catch((e) => json(res, { ok: false, message: String(e) }))
          return
        }
        const ws = wsForConfig(config)
        let body = ''
        req.on('data', (chunk) => { body += String(chunk) })
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}') as { scope?: string; roles?: Record<string, string>; categories?: Record<string, string> }
            const scope = parsed.scope === 'workspace' ? 'workspace' : 'user'
            const roles = parsed.roles && typeof parsed.roles === 'object' ? parsed.roles : {}
            const categories = parsed.categories && typeof parsed.categories === 'object' ? parsed.categories : {}
            for (const name of Object.keys(roles)) {
              if (!findRole(name)) { json(res, { ok: false, message: `unknown role "${name}"` }); return }
            }
            for (const name of Object.keys(categories)) {
              if (!(CATEGORIES as readonly string[]).includes(name)) { json(res, { ok: false, message: `unknown category "${name}"` }); return }
            }
            for (const v of [...Object.values(roles), ...Object.values(categories)]) {
              if (v && !parseRoleRoute(v)) { json(res, { ok: false, message: `invalid route "${String(v)}" (expected provider/model)` }); return }
            }
            const file = scope === 'workspace' ? workspaceRoutesFile(ws) : userRoutesFile()
            const r = writeRoutesLayer(file, { roles, categories })
            if (!r.ok) { json(res, { ok: false, message: r.message }); return }
            apiModelRoutes(config).then((v) => json(res, { ok: true, file, message: r.message, view: v })).catch((e) => json(res, { ok: false, message: String(e) }))
          } catch (e) {
            json(res, { ok: false, message: String(e) })
          }
        })
      }),
    }), 'dsh-oh-my-agent: api/modelroutes')
  }

  // monitor cleanup on stop
  ctx.effect(() => () => {
    // no persistent registry held at root; tools instantiate per-call and
    // child cleanup is handled by the OS / plugin unload.
  })

  // LSP sessions cleanup on plugin stop
  ctx.effect(() => () => {
    lspMgr.disposeAll()
  }, 'dsh-oh-my-agent: dispose lsp sessions')

  // automatic hook interception layer (tools/pre-execute + post-execute)
  ctx.effect(() => {
    const anyCtx = ctx as unknown as { on: (ev: string, fn: unknown) => (() => void) | undefined }
    const a = anyCtx.on('tools/pre-execute', omoPreExecute)
    const b = anyCtx.on('tools/post-execute', omoPostExecute)
    // 档②纵深：每个新建 agent 在自己的 scope 上再注册一份 nested-delegation-guard
    // （作用域守卫只对该 agent 生效，随其 ctx 销毁自动回收）
    const c = anyCtx.on('agent/created', (payload: unknown) => {
      registerPerAgentGuard((payload as { agent?: unknown } | undefined)?.agent)
    })
    ctx.logger?.info?.('[dsh-oh-my-agent] omo_hooks 监听器已挂载（write-guard / comment-checker / rules-injector / read-only-gate / nested-delegation-guard）')
    return () => {
      try { if (typeof a === 'function') a() } catch { /* ignore */ }
      try { if (typeof b === 'function') b() } catch { /* ignore */ }
      try { if (typeof c === 'function') c() } catch { /* ignore */ }
    }
  }, 'dsh-oh-my-agent: hooks listeners')

  // nested-delegation-guard：全局 ToolGuard（monotonic，pre-execute 之后、工具体之前）——
  // 子代理会话（SessionHeader.origin/delegationDepth 持久判定）调用派发工具
  // （delegate_as / 宿主具名通道 subagent、subagent_* / workflow / ralph）一律拒绝，
  // 主会话不受影响；另有 agent/created per-agent 作用域守卫纵深。
  // 开关经 omo.jsonc hooks.nested_delegation_guard / hooks.nested_delegation_extra_tools / disabled_hooks。
  regOnce(ctx, () => ((ctx as unknown as ToolsCtx).tools).guard(nestedDelegationGuard), 'dsh-oh-my-agent: nested-delegation-guard')

  // goal-guard（方案 B）：派发后台 continuable 子代理期间 disarm goal（进程内），
  // 全部结算后自动 resume——消除等待窗口内 goal-round-driver 的反复 <goal_round>
  // 注入（driver 只认 idle，不知道有未结算子代理）。见 src/goalGuard.ts。
  if (config.goalGuardOn) {
    const guard = new GoalGuard()
    goalGuard = guard
    ctx.effect(() => {
      const anyCtx = ctx as unknown as {
        on: (ev: string, fn: (...args: unknown[]) => unknown) => (() => void) | undefined
        logger?: { info?: (m: string) => void; warn?: (m: string) => void }
      }
      const log = (msg: string, warn = false): void => {
        try {
          const l = anyCtx.logger
          if (!l) return
          if (warn) l.warn?.(`[dsh-oh-my-agent] ${msg}`)
          else l.info?.(`[dsh-oh-my-agent] ${msg}`)
        } catch { /* ignore */ }
      }
      const goalsSvc = (): GoalsServiceLike | undefined => {
        try {
          const svc = ((hostCtx as { get?: (k: string) => unknown } | null)?.get)?.('goals')
          if (svc && typeof (svc as GoalsServiceLike).get === 'function' && typeof (svc as GoalsServiceLike).disarm === 'function' && typeof (svc as GoalsServiceLike).resume === 'function') {
            return svc as GoalsServiceLike
          }
        } catch { /* ignore */ }
        return undefined
      }
      const agentIdOf = (payload: unknown): string => String((payload as { agent?: { id?: string } } | undefined)?.agent?.id ?? '')
      const disposers: Array<(() => void) | undefined> = []
      const on = (ev: string, fn: (...args: unknown[]) => unknown): void => {
        try {
          const d = anyCtx.on(ev, fn)
          if (typeof d === 'function') disposers.push(d)
        } catch (e) {
          log(`[goal-guard] listen ${ev} failed: ${String(e)}`, true)
        }
      }

      goalGuardGoals = goalsSvc
      goalGuardLog = log

      // ── children 查询与共享决策执行器 ──────────────────────────────
      // "是否有子代理在跑"用 subagents.listDescendants——**只有它**给每行补
      // `activity`（'running' = 记录仍 live 于 ctx.sessions，即工作未结束，含
      // send_message 冷恢复的 epoch2；'inactive' = 已 dispose）。listChildren 的
      // 返回类型 SubagentCatalogEntry 根本没有 activity 字段，拿它判活恒为 0
      // （2026-10-03 实测故障：等待窗口不成立、goal 仍被注入）。
      // 不用 subagent/start|end 生命周期边：那是"驻留期终止"边且经作用域过滤，
      // 外部监听器收不到（dsh-subagent 文档明言）。查询失败按"有子代理在跑"
      // 保守处理（不自动 resume）。
      const agentsSvc = (): { get: (id: string) => unknown } | undefined => {
        try {
          return ((hostCtx as { get?: (k: string) => unknown } | null)?.get)?.('agents') as { get: (id: string) => unknown } | undefined
        } catch { /* ignore */ }
        return undefined
      }
      const subagentsSvc = (): { listDescendants: (parentSessionId: string) => Promise<SubagentRowLike[]> } | undefined => {
        try {
          const svc = ((hostCtx as { get?: (k: string) => unknown } | null)?.get)?.('subagents')
          if (svc && typeof (svc as { listDescendants?: unknown }).listDescendants === 'function') {
            return svc as { listDescendants: (parentSessionId: string) => Promise<SubagentRowLike[]> }
          }
        } catch { /* ignore */ }
        return undefined
      }
      const runningChildrenOf = async (agentId: string): Promise<number> => {
        try {
          const subs = subagentsSvc()
          if (!subs) {
            goalGuardDiag.subsMissing += 1
            goalGuardDiag.last = `subagents svc missing (${agentId})`
            return 1
          }
          const rows = await subs.listDescendants(agentId)
          const running = countRunningChildren(rows)
          goalGuardDiag.running = running
          return running
        } catch (e) {
          goalGuardDiag.listFails += 1
          goalGuardDiag.last = `listDescendants failed: ${String(e)}`
          log(`[goal-guard] listDescendants failed（按有子代理在跑保守处理）: ${String(e)}`, true)
          return 1
        }
      }
      const applyIdleDecision = async (agentId: string): Promise<void> => {
        // 双挂载/热重载下效果闭包的 guard 可能与模块级不同步（旧 fiber 监听仍生效）：
        // 一律在调用时重读模块级实例（最新 apply 者，与派发钩子/路由同一实例）。
        const guard = goalGuard
        if (!guard) return
        goalGuardDiag.idleRuns += 1
        try {
          const svc = goalsSvc()
          const agent = agentsSvc()?.get(agentId)
          if (!agent) {
            goalGuardDiag.agentsMissing += 1
            goalGuardDiag.last = `agents.get(${agentId}) missing`
            return
          }
          const goal = svc?.get(agent)
          const running = await runningChildrenOf(agentId)
          goalGuardDiag.last = `decide(${agentId}) running=${running} goal=${goal ? goal.phase + '/' + goal.activation : 'none'}`
          const dec = guard.decideAtIdle(agentId, goal, running)
          if (dec.kind === 'disarm') {
            svc?.disarm(agent)
            guard.recordDisarm(agentId, dec.mark)
            goalGuardDiag.disarms += 1
            goalGuardDiag.windowDisarms += 1
            log(`[goal-guard] waiting window: re-disarmed goal ${dec.mark.goalId}@${dec.mark.revision}（等待中设置/重新武装的 goal）`)
          } else if (dec.kind === 'resume') {
            try {
              const view = svc?.resume(agent, { id: dec.mark.goalId, revision: dec.mark.revision })
              guard.clearMark(agentId)
              goalGuardDiag.resumes += 1
              if (view) log(`[goal-guard] children settled: re-armed goal ${dec.mark.goalId}@${dec.mark.revision}（恢复自动续跑）`)
            } catch (e) {
              // resume 失败 = 保持 disarmed（fail-safe，交人类）；绝不让自动续跑借尸还魂
              guard.clearMark(agentId)
              goalGuardDiag.last = `resume failed: ${String(e)}`
              log(`[goal-guard] resume failed (goal 保持 disarmed，需人类 resume): ${String(e)}`, true)
            }
          }
        } catch (e) {
          goalGuardDiag.last = `idle-decision threw: ${String(e)}`
          log(`[goal-guard] idle-decision failed: ${String(e)}`, true)
        }
      }

      // idle 决策：有 running 子代理 → 等待窗口（armed goal 再 disarm）；全空且
      // mark 匹配且未毒化 → resume（恢复自动续跑）。
      // （agent/status 已弃用：对根会话作用域过滤不可达；决策触发器见上：结算通知 /
      // turn/end / goal/changed。）
      // 等待中设置/goal 变更：有 running 子代理且 goal 被武装 → 立即 disarm，
      // 堵住"设置 goal 后下一个 idle 被注入一轮"的竞态
      on('goal/changed', (...args: unknown[]) => {
        try {
          goalGuardDiag.goalChangeSeen += 1
          const guard = goalGuard
          if (!guard) return
          const raw = args.length > 1 ? args[args.length - 1] : args[0]
          const aid = String((raw as { agent?: { id?: string } } | undefined)?.agent?.id ?? '')
          if (!aid || !guard.has(aid)) return
          void applyIdleDecision(aid)
        } catch (e) {
          log(`[goal-guard] goal/changed handler failed: ${String(e)}`, true)
        }
      })
      // driver 的 fail-safe 信号 → 毒化：禁止自动 resume（不覆盖 harness 熔断）
      on('agent/error', (payload: unknown) => {
        try {
          const guard = goalGuard
          const aid = agentIdOf(payload)
          if (guard && aid && guard.poison(aid, 'agent/error')) log(`[goal-guard] poisoned ${aid} (agent/error) — 不再自动 resume`)
        } catch (e) {
          log(`[goal-guard] agent/error handler failed: ${String(e)}`, true)
        }
      })
      // ── 决策触发器（全部基于已验证可达的通道）──
      // 实测：agent/status 对根 web 会话不可达（只有子代理 idle 到，被作用域过滤），
      // session/event 与 goal/changed 可达。故：
      //   - session/event user/message: subagent-settled（结算通知）→ 即时决策
      //   - session/event turn/end（本会话正常结束）→ 决策兜底
      //   - goal/changed（等待中设置/变更 goal）→ 有 running 子代理则即时 disarm
      on('session/event', (session: unknown, event: unknown) => {
        try {
          const guard = goalGuard
          const ev = event as { type?: string; data?: { reason?: { kind?: string }; source?: { kind?: string } } } | undefined
          const t = String(ev?.type ?? '?')
          if (goalGuardDiag.sessionKinds.length < 30 && !goalGuardDiag.sessionKinds.includes(t)) goalGuardDiag.sessionKinds.push(t)
          goalGuardDiag.sessionEvents += 1
          const sid = String((session as { id?: string } | undefined)?.id ?? '')
          if (!guard || !guard.has(sid)) return
          if (ev?.type === 'user/message' && ev.data?.source?.kind === 'subagent-settled') {
            goalGuardDiag.sessionSettled += 1
            goalGuardDiag.last = `settled-notice ${sid} → decide`
            void applyIdleDecision(sid)
            return
          }
          if (ev?.type === 'turn/end') {
            goalGuardDiag.sessionTurnEnds += 1
            const kind = ev.data?.reason?.kind
            if (kind === 'max-tokens' || kind === 'aborted') {
              if (guard.poison(sid, `turn/end:${kind}`)) log(`[goal-guard] poisoned ${sid} (${kind}) — 不再自动 resume`)
              return
            }
            goalGuardDiag.last = `turn/end kind=${String(kind)} ${sid} → decide`
            void applyIdleDecision(sid)
          }
        } catch (e) {
          log(`[goal-guard] session/event handler failed: ${String(e)}`, true)
        }
      })
      // 会话边界：整段状态作废（新 epoch 不继承等待窗口）
      const dropOwner = (aid: string): void => {
        goalGuard?.reset(aid)
      }
      on('agent/disposed', (payload: unknown) => {
        try {
          const aid = agentIdOf(payload)
          if (aid) dropOwner(aid)
        } catch (e) {
          log(`[goal-guard] agent/disposed handler failed: ${String(e)}`, true)
        }
      })
      on('agent/session-start', (payload: unknown) => {
        try {
          const aid = agentIdOf(payload)
          if (aid) dropOwner(aid)
        } catch (e) {
          log(`[goal-guard] agent/session-start handler failed: ${String(e)}`, true)
        }
      })

      ctx.logger?.info?.('[dsh-oh-my-agent] goal-guard 已启用（派发子代理期间 goal 不注入，结算后自动恢复）')
      return () => {
        for (const d of disposers) {
          try { if (typeof d === 'function') d() } catch { /* ignore */ }
        }
        if (goalGuard === guard) goalGuard = null
        if (goalGuardLog === log) goalGuardLog = null
        if (goalGuardGoals === goalsSvc) goalGuardGoals = null
      }
    }, 'dsh-oh-my-agent: goal-guard (方案B)')
  }

  // 会话级模式切换：skill 注入/调用路径 → pre-step 检测（prometheus 规划态 / atlas 执行态 / ultrawork 退态）
  ctx.effect(() => {
    const anyCtx = ctx as unknown as { on: (ev: string, fn: unknown) => (() => void) | undefined }
    const c = anyCtx.on('agent/pre-step', async (payload: unknown, next: unknown) => {
      // 先让下游（含 dsh-tool-skill 的注入）完成，再读最终 decision
      const decision = await (next as () => Promise<AnyObj>)()
      try {
        const agent = (payload as AnyObj | undefined)?.agent
        if (!agent) return decision
        const intent = sessionModeIntentOf(decision as AnyObj)
        if (!intent) return decision
        const cwd = ((agent as { session?: { header?: { cwd?: string } } }).session)?.header?.cwd
        const ws = wsForConfig(config, cwd)
        const merged = loadLayeredConfig(ws).merged
        const routes: DelegateRoutes = { provider: config.delegateProvider, flash: config.delegateFlashRoute, heavy: config.delegateHeavyRoute }
        const mode: SessionMode = intent.mode
        // start-work 对齐原版：无可执行计划时不切 Atlas 执行态，由技能明确告知用户
        if (mode === 'atlas' && !hasExecutablePlan(ws)) {
          ctx.logger?.info?.('[dsh-oh-my-agent] start-work 注入但无可执行计划——不切换 Atlas 执行态（技能将明确告知）')
          return decision
        }
        const route = mode === 'atlas' ? roleModelRoute('atlas', merged, routes) : mode === 'prometheus' ? prometheusPlanRoute(merged, routes) : undefined
        const r = await setSessionMode(agent, mode, route, defaultsSelection())
        const modeLabel = mode === 'atlas' ? 'atlas 执行态' : mode === 'prometheus' ? 'prometheus 规划态' : 'off（还原默认）'
        if (!r.ok) {
          ctx.logger?.warn?.(`[dsh-oh-my-agent] session mode → ${modeLabel} failed: ${String(r.reason ?? '')}`)
        } else {
          ctx.logger?.info?.(`[dsh-oh-my-agent] session mode → ${modeLabel}（${r.route ? `route=${r.route.provider}/${r.route.model}, ` : ''}${r.source ? `source=${r.source}` : r.route ? 'noop' : ''}）`)
        }
      } catch (e) {
        // 模式切换绝不破坏步骤本身
        ctx.logger?.warn?.(`[dsh-oh-my-agent] session-mode pre-step switch error: ${String(e)}`)
      }
      return decision
    })
    return () => {
      try { if (typeof c === 'function') c() } catch { /* ignore */ }
    }
  }, 'dsh-oh-my-agent: session-mode switch')

  // ultrawork Oracle 验证门：检测未经验证的 <promise> 完成宣称 → 注入强制验证提醒
  ctx.effect(() => {
    const anyCtx = ctx as unknown as { on: (ev: string, fn: unknown) => (() => void) | undefined }
    const g = anyCtx.on('agent/pre-step', async (payload: unknown, next: unknown) => {
      const decision = await (next as () => Promise<AnyObj>)()
      try {
        const agent = (payload as AnyObj | undefined)?.agent
        const session = (agent as { session?: unknown } | undefined)?.session
        if (!session || typeof session !== 'object') return decision
        if (!hasUnverifiedUltraworkClaim(session)) {
          ultraworkGateNotified.delete(session as object)
          return decision
        }
        if (ultraworkGateNotified.get(session as object)) return decision // 同 claim 只提醒一次
        ultraworkGateNotified.set(session as object, true)
        const notice = createUserMessage({
          content: [{ type: 'text', text: ULTRAWORK_GATE_NOTICE }],
          source: { kind: OMO_MESSAGE_KIND, form: 'notice', summary: 'ultrawork 完成宣称未验证——需 Oracle 验证' },
        })
        ctx.logger?.info?.('[dsh-oh-my-agent] ultrawork gate: unverified completion claim detected — notice injected')
        return { ...decision, messages: [...(decision.messages as unknown[]), notice] }
      } catch (e) {
        ctx.logger?.warn?.(`[dsh-oh-my-agent] ultrawork gate error: ${String(e)}`)
        return decision
      }
    })
    return () => {
      try { if (typeof g === 'function') g() } catch { /* ignore */ }
    }
  }, 'dsh-oh-my-agent: ultrawork oracle gate')

  // rules session channel：会话第一步把「常设守则」（alwaysApply 且 applyTo 含
  // 'session'，如 plugin-test-env.mdc 的 [session, tool] 铁律）注入一次。
  // 与 file 通道（edit 按路径注入）互斥：通道门保证 [session, tool] 规则不再进
  // edit 后置注入，只在本通道每会话出现一次（WeakSet 按 session 对象去重，
  // 会话销毁自动回收；同一会话规则中途变更不重复注入）。
  const sessionRulesNotified = new WeakSet<object>()
  ctx.effect(() => {
    const anyCtx = ctx as unknown as { on: (ev: string, fn: unknown) => (() => void) | undefined }
    const g = anyCtx.on('agent/pre-step', async (payload: unknown, next: unknown) => {
      const decision = await (next as () => Promise<AnyObj>)()
      try {
        const agent = (payload as AnyObj | undefined)?.agent as { session?: { header?: { cwd?: string }; meta?: { cwd?: string } } } | undefined
        const session = (agent as { session?: unknown } | undefined)?.session
        if (!session || typeof session !== 'object') return decision
        const cwd = agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd
        if (!cwd) return decision
        const ws = wsForConfig(config, cwd)
        if (!ws) return decision
        try {
          const cfg = hooksConfigFor(ws)
          if (!cfg.rulesInjector || cfg.disabledHooks.includes('rules-injector')) return decision
        } catch {
          return decision
        }
        if (sessionRulesNotified.has(session)) return decision
        const block = sessionRulesBlockFor(ws)
        if (!block || !block.trim()) return decision
        sessionRulesNotified.add(session)
        const notice = createUserMessage({
          content: [{ type: 'text', text: `[OMO HOOK · rules · session] 会话常设守则（每次会话注入一次，请遵守）：\n${block.slice(0, 2500)}` }],
          source: { kind: OMO_MESSAGE_KIND, form: 'notice', summary: 'rules session 守则注入' },
        })
        ctx.logger?.info?.('[dsh-oh-my-agent] rules session channel: standing rules injected once for session')
        return { ...decision, messages: [...(decision.messages as unknown[]), notice] }
      } catch (e) {
        ctx.logger?.warn?.(`[dsh-oh-my-agent] rules session channel error: ${String(e)}`)
        return decision
      }
    })
    return () => {
      try { if (typeof g === 'function') g() } catch { /* ignore */ }
    }
  }, 'dsh-oh-my-agent: rules session channel')

  // main-session system-prompt section (dsh-system-prompt channel).
  // Registered on the plugin's own long-lived fiber so the section persists;
  // the layer follows this plugin's assembly point. When loaded as an AGENT
  // PRESET row (this deployment), the section lands in the preset's standing
  // mount layer and is seen by every session joining that preset; when loaded
  // via the host roster it lands in the global layer covering every preset.
  // Verify with: agentPresets.standingKeyFor(presetId) -> systemPrompt.assemble({scope}).
  const spCtx = ctx as unknown as SysPromptCtx
  if (typeof spCtx.systemPrompt?.section !== 'function') {
    if (config.mainPrompt !== 'off') {
      ctx.logger?.warn?.(`[dsh-oh-my-agent] mainPrompt=${config.mainPrompt} requested but host has no systemPrompt service - skipped`)
    }
  } else {
    const body = config.mainPrompt === 'sisyphus' ? SISYPHUS_SECTION
      : config.mainPrompt === 'custom' ? config.customPromptSection : ''
    if (body.trim()) {
      try {
        // B 方案：orchestration 纪律段按会话模式唯一化——off 才注入 Sisyphus；
        // prometheus 规划态注入 Prometheus 纪律段、atlas 执行态注入 Atlas 段，
        // 三个模式互斥（一份编排纪律只对应一个身份，避免实现权冲突）。
        const text = config.mainPrompt === 'custom'
          ? body
          : (context: { agent?: unknown }) => (context?.agent === undefined ? body : (sessionModeOf(context.agent) === 'off' ? body : ''))
        regOnce(ctx, () => spCtx.systemPrompt!.section({
          name: 'omo:sisyphus-discipline',
          order: 50,
          text,
        }), 'dsh-oh-my-agent: system prompt section')
        ctx.logger?.info?.(`[dsh-oh-my-agent] main-prompt section registered (mode=${config.mainPrompt}, name=omo:sisyphus-discipline, order=50, dynamic-by-session-mode)`)
      } catch (e) {
        ctx.logger?.warn?.(`[dsh-oh-my-agent] main-prompt section registration failed: ${String(e)}`)
      }
    }
  }

  // Prometheus 规划态动态段：仅在 prometheus 模式组装（与 sisyphus 段互斥）
  if (typeof spCtx.systemPrompt?.section === 'function') {
    try {
      regOnce(ctx, () => spCtx.systemPrompt!.section({
        name: 'omo:prometheus-planning',
        order: 50,
        text: (context) => (context?.agent !== undefined && sessionModeOf(context.agent) === 'prometheus') ? PROMETHEUS_SECTION : '',
      }), 'dsh-oh-my-agent: prometheus-planning section')
      ctx.logger?.info?.('[dsh-oh-my-agent] prometheus-planning section registered (name=omo:prometheus-planning, order=50, dynamic)')
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-oh-my-agent] prometheus-planning section registration failed: ${String(e)}`)
    }
  }

  // Atlas 执行态动态段：仅在会话处于 atlas 模式时随请求组装（函数式 text，
  // 与 dsh-plan-mode 的 plan:policy 同型；模式切换下一次请求生效）
  if (typeof spCtx.systemPrompt?.section === 'function') {
    try {
      regOnce(ctx, () => spCtx.systemPrompt!.section({
        name: 'omo:atlas-execution',
        order: 50,
        text: (context) => (context?.agent !== undefined && sessionModeOf(context.agent) === 'atlas') ? ATLAS_SECTION : '',
      }), 'dsh-oh-my-agent: atlas-execution section')
      ctx.logger?.info?.('[dsh-oh-my-agent] atlas-execution section registered (name=omo:atlas-execution, order=50, dynamic)')
    } catch (e) {
      ctx.logger?.warn?.(`[dsh-oh-my-agent] atlas-execution section registration failed: ${String(e)}`)
    }
  }

  ctx.logger?.info?.('[' + PLUGIN_ID + '] 已装配：12 工具 + 4 技能 + webServer api')
}

function json(res: unknown, obj: unknown): void {
  const r = res as { writeHead: (s: number, o: Record<string, string>) => void; end: (b: string) => void }
  r.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  r.end(JSON.stringify(obj))
}

export { SECTIONS }
