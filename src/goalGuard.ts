/**
 * goal-guard（方案 B）—— dsh-omo 进程内 goal 续跑守卫。
 *
 * 背景：DSH `goal-round-driver` 在 agent 回到 idle 且 goal `active + armed` 时
 * 必然排队下一轮 `<goal_round>` 注入（readyToDrive 只查 idle，不知道还有未结算
 * 的后台子代理）。dsh-omo 的委托纪律是"派发 continuable 子代理后结束回合、等
 * 结算通知"——等待窗口内 agent 处于 idle，armed goal 会被反复注入、烧光
 * maxGoalRounds。而模型工具层的 pause/resume 要求直接人类回合，模型自救不了，
 * 故由插件在宿主服务层（无人类门）代为治理。
 *
 *   - 派发 continuable 时：若 goal active+armed → `goals.disarm`（进程内，不产生
 *     耐久事件、不改 phase/revision），并记 mark（goalId/revision/at）。
 *   - 等待窗口（idle 且仍有 running 子代理）：若 goal 被重新武装（如等待中才
 *     设置 goal，或人类手动 resume）→ 再次 disarm。
 *   - 全部结算（idle 且无 running 子代理）：mark 未毒化、goal 仍 `active+disarmed`
 *     且 id/revision 与 mark 一致 → `goals.resume` 重新武装，恢复正常自动续跑。
 *
 * "是否有子代理在跑"的判定用 `ctx.subagents.listDescendants(parentSessionId)`：
 * 只有它给每行补 `activity` 字段——`'running'` = 逻辑记录仍在 ctx.sessions（= 工作
 * 未结束、含 send_message 冷恢复的 epoch2）；`'inactive'` = 已 dispose。
 * `listChildren` **不补** `activity`（其返回类型 `SubagentCatalogEntry` 只有
 * id/createdAt/mode/label），拿它判活恒为 0（2026-10-03 实测故障）。
 * 生命周期边 `subagent/end` 是"驻留期终止"边且经作用域过滤，外部监听器收不到
 * （dsh-subagent 文档明言），故不用事件计数。
 *
 * 毒化（poisoned）：等待窗口内出现 driver 的 fail-safe disarm 信号
 * （agent/error、回合 max-tokens/aborted）后，禁止自动 resume——不覆盖 harness
 * 的熔断决定，留给人类 resume。新一次派发（新窗口）才清除毒化。
 *
 * 本模块为纯状态机，不依赖 harness 类型，可单测。
 */

/** goals 服务的只读视图（够守卫用即可，宽松形状）。 */
export interface GoalViewLike {
  id: string
  revision: number
  phase: string
  activation: string
}

/** dsh-goal 宿主服务的松类型面（compile-time 不依赖 @deepseek-ai/dsh-goal）。 */
export interface GoalsServiceLike {
  get(agent: unknown): GoalViewLike | undefined
  disarm(agent: unknown): GoalViewLike | undefined
  resume(agent: unknown, ref: { id: string; revision: number }): GoalViewLike | undefined
}

/** 我们主动 disarm 的标记：目标 goal 的精确修订。 */
export interface GuardMark {
  goalId: string
  revision: number
  at: number
}

interface GuardState {
  /** 我们 disarm 的 goal 标记；无标记则从不自动 resume。 */
  mark?: GuardMark
  /** 毒化：检测到 driver 故障信号，禁止自动 resume。 */
  poisoned: boolean
}

export type IdleDecision =
  | { kind: 'disarm'; mark: GuardMark }
  | { kind: 'resume'; mark: GuardMark }
  | { kind: 'none' }

export interface GuardSnapshot {
  agent: string
  marked: boolean
  poisoned: boolean
}

const activeArmed = (goal: GoalViewLike | undefined): goal is GoalViewLike =>
  goal !== undefined && goal.phase === 'active' && goal.activation === 'armed'

export class GoalGuard {
  private states = new Map<string, GuardState>()

  private stateFor(agentId: string): GuardState {
    let st = this.states.get(agentId)
    if (!st) {
      st = { poisoned: false }
      this.states.set(agentId, st)
    }
    return st
  }

  /** 该 agent 是否在守卫视野内（派发过 / 等待窗口进行中）。 */
  has(agentId: string): boolean {
    return this.states.has(agentId)
  }

  /**
   * 派发点：goal armed → 返回 disarm 意图（由调用方执行 + recordDisarm 记 mark）。
   * 新窗口：清除上一窗口的毒化（新派发 = 新授权）。
   */
  dispatch(agentId: string, goal: GoalViewLike | undefined): GuardMark | undefined {
    const st = this.stateFor(agentId)
    if (activeArmed(goal)) {
      st.poisoned = false
      const mark: GuardMark = { goalId: goal.id, revision: goal.revision, at: Date.now() }
      return mark
    }
    return undefined
  }

  /** 派发方完成 disarm 后登记 mark（幂等）。 */
  recordDisarm(agentId: string, mark: GuardMark): void {
    this.stateFor(agentId).mark = mark
  }

  /**
   * driver 故障信号（agent/error、max-tokens/aborted 回合结尾）→ 毒化当前窗口，
   * 禁止后续自动 resume。仅在存在 mark 或已毒化时生效（无窗口不关心）。
   */
  poison(agentId: string, reason: string): boolean {
    const st = this.states.get(agentId)
    if (st === undefined) return false
    if (st.mark !== undefined || st.poisoned) {
      st.poisoned = true
      st.mark = undefined
      return true
    }
    return false
  }

  /**
   * idle 决策（回合结束 + children 查询后调用；runningChildren 由调用方经
   * subagents.listDescendants 汇总，见 countRunningChildren）：
   * - runningChildren > 0：等待窗口。goal armed → 返回 disarm（含刷新后的 mark）。
   *   （注意：此处刷新 mark 但不清毒化——毒化只随新派发清除。）
   * - runningChildren === 0：mark 有效、未毒化、goal 与 mark 匹配且 active+disarmed
   *   → resume；否则清 mark 结束窗口（goal 被清/编辑/complete/paused/重新武装
   *   都交人类）。
   */
  decideAtIdle(agentId: string, goal: GoalViewLike | undefined, runningChildren: number): IdleDecision {
    const st = this.states.get(agentId)
    if (st === undefined) return { kind: 'none' }
    if (runningChildren > 0) {
      if (activeArmed(goal)) {
        const mark: GuardMark = { goalId: goal.id, revision: goal.revision, at: Date.now() }
        st.mark = mark
        return { kind: 'disarm', mark }
      }
      return { kind: 'none' }
    }
    if (st.poisoned || st.mark === undefined) return { kind: 'none' }
    const mark = st.mark
    if (goal === undefined) {
      st.mark = undefined
      return { kind: 'none' }
    }
    if (goal.id !== mark.goalId || goal.revision !== mark.revision) {
      // goal 被清/被编辑：不自动 resume（保守，交人类）。
      st.mark = undefined
      return { kind: 'none' }
    }
    if (goal.phase !== 'active' || goal.activation !== 'disarmed') {
      // goal 已 complete/blocked/paused，或已被重新武装（无守卫职责）：结束窗口。
      st.mark = undefined
      return { kind: 'none' }
    }
    return { kind: 'resume', mark }
  }

  /** resume 成功（或放弃自动 resume）后清 mark。 */
  clearMark(agentId: string): void {
    const st = this.states.get(agentId)
    if (st !== undefined) st.mark = undefined
  }

  /** 会话起点/终结：整段状态作废（新 epoch 不继承窗口）。 */
  reset(agentId: string): void {
    this.states.delete(agentId)
  }

  /** 观察：当前有守卫窗口（有 mark）的 agent 数。 */
  guardedCount(): number {
    let n = 0
    for (const st of this.states.values()) {
      if (st.mark !== undefined) n += 1
    }
    return n
  }

  /** 观察：全量快照（供 omo_status / api / 测试）。 */
  snapshot(): GuardSnapshot[] {
    return [...this.states.entries()].map(([agent, st]) => ({
      agent,
      marked: st.mark !== undefined,
      poisoned: st.poisoned,
    }))
  }
}

/** `subagents.listDescendants` 行的宽松形状（只取判活需要的字段）。 */
export interface SubagentRowLike {
  kind?: string
  activity?: string
  depth?: number
}

/**
 * 数「仍在跑的后代子代理」。**只接受 listDescendants 的行**——它按 residency
 * （记录是否 live 于 ctx.sessions）补 `activity`，与原生 `runningDescendants`
 * 同源；`kind:'child' && activity==='running'` 即工作未结束（含 send_message
 * 冷恢复的 epoch2）。diagnostic 行无 activity，自然被排除；所有深度都算（原
 * 生 runningDescendants 亦如此）。空/非数组按 0。
 *
 * 注意：**不要**拿 `listChildren` 的结果喂这里——它的 `SubagentCatalogEntry`
 * 根本没有 `activity` 字段，恒返回 0（2026-10-03 实测故障）。
 */
export function countRunningChildren(rows: readonly SubagentRowLike[] | undefined): number {
  if (!Array.isArray(rows)) return 0
  let n = 0
  for (const row of rows) {
    if (row?.kind !== 'child') continue
    if (row.activity === 'running') n += 1
  }
  return n
}