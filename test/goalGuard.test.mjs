/**
 * goalGuard 纯状态机单测（对编译产物 lib/goalGuard.js 运行）：
 *   node test/goalGuard.test.mjs
 * 覆盖：派发 disarm / 等待窗口重武装 / 全结算 resume / 毒化禁 resume /
 * 修订不匹配不 resume / goal 非 active 清窗口 / runingChildren 判定 / 快照。
 */
import assert from 'node:assert/strict'
import { GoalGuard, countRunningChildren } from '../lib/goalGuard.js'

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

const goal = (over = {}) => ({ id: 'goal-1', revision: 1, phase: 'active', activation: 'armed', ...over })
const noGoal = undefined
const A = 'agent-1'

// ── 1. 派发：armed goal → disarm 意图 + mark；无 goal 不动作 ──
{
  const g = new GoalGuard()
  const mark = g.dispatch(A, goal())
  assert.equal(mark.goalId, 'goal-1')
  assert.equal(mark.revision, 1)
  g.recordDisarm(A, mark)
  assert.equal(g.guardedCount(), 1)
  // 无 goal：只登记视野，不 disarm
  const mark2 = g.dispatch(A, noGoal)
  assert.equal(mark2, undefined)
  assert.equal(g.has(A), true)
  ok('派发：armed goal 返回 disarm 意图；无 goal 仅进守卫视野')
}

// ── 2. 等待窗口（runningChildren>0）idle：goal 被重新武装 → disarm 决策 ──
{
  const g = new GoalGuard()
  g.dispatch(A, noGoal) // 派发时无 goal（等待窗口内才设置）
  const dec = g.decideAtIdle(A, goal(), 1) // 等待中设置的 goal（armed）
  assert.equal(dec.kind, 'disarm')
  assert.equal(dec.mark.goalId, 'goal-1')
  ok('等待窗口 idle：armed goal → 再 disarm（等待中设置场景）')
}

// ── 3. 全结算（runningChildren=0）idle：mark 匹配且 active+disarmed → resume ──
{
  const g = new GoalGuard()
  const mark = g.dispatch(A, goal())
  g.recordDisarm(A, mark)
  const dec = g.decideAtIdle(A, goal({ activation: 'disarmed' }), 0)
  assert.equal(dec.kind, 'resume')
  assert.equal(dec.mark.goalId, 'goal-1')
  g.clearMark(A)
  // 清 mark 后不再 resume
  assert.equal(g.decideAtIdle(A, goal({ activation: 'disarmed' }), 0).kind, 'none')
  ok('全部结算：resume；清 mark 后不再动作')
}

// ── 4. runningChildren>0 时不 resume（即使 goal 已 disarmed）──
{
  const g = new GoalGuard()
  const mark = g.dispatch(A, goal())
  g.recordDisarm(A, mark)
  assert.equal(g.decideAtIdle(A, goal({ activation: 'disarmed' }), 1).kind, 'none')
  assert.equal(g.decideAtIdle(A, goal({ activation: 'disarmed' }), 3).kind, 'none')
  ok('runningChildren>0：绝不 resume')
}

// ── 5. 毒化：driver 故障信号后禁止自动 resume ──
{
  const g = new GoalGuard()
  const mark = g.dispatch(A, goal())
  g.recordDisarm(A, mark)
  assert.equal(g.poison(A, 'agent/error'), true)
  assert.equal(g.decideAtIdle(A, goal({ activation: 'disarmed' }), 0).kind, 'none') // 毒化挡掉
  // 新派发 = 新窗口 = 清毒化
  const mark2 = g.dispatch(A, goal({ revision: 2 }))
  assert.equal(mark2.revision, 2)
  ok('毒化禁 resume；新派发清毒化')
}

// ── 6. 修订/目标不匹配：不自动 resume（被编辑/被替换）──
{
  const g = new GoalGuard()
  const mark = g.dispatch(A, goal({ revision: 1 }))
  g.recordDisarm(A, mark)
  // revision 变了（human 编辑过）→ none
  assert.equal(g.decideAtIdle(A, goal({ revision: 2, activation: 'disarmed' }), 0).kind, 'none')
  // goal 没了 → none；mark 被清
  const g2 = new GoalGuard()
  g2.recordDisarm(A, g2.dispatch(A, goal()))
  assert.equal(g2.decideAtIdle(A, noGoal, 0).kind, 'none')
  assert.equal(g2.guardedCount(), 0)
  ok('修订不匹配 / goal 已清：不自动 resume（保守交人类）')
}

// ── 7. 挂起=0 且 goal 非 active（complete/paused）或已重新武装 → 清 mark 结束窗口 ──
{
  const g = new GoalGuard()
  g.recordDisarm(A, g.dispatch(A, goal()))
  assert.equal(g.decideAtIdle(A, goal({ phase: 'complete', activation: 'disarmed' }), 0).kind, 'none')
  assert.equal(g.guardedCount(), 0)
  const g2 = new GoalGuard()
  g2.recordDisarm(A, g2.dispatch(A, goal()))
  assert.equal(g2.decideAtIdle(A, goal({ phase: 'paused', activation: 'disarmed' }), 0).kind, 'none')
  assert.equal(g2.guardedCount(), 0)
  const g3 = new GoalGuard()
  g3.recordDisarm(A, g3.dispatch(A, goal()))
  assert.equal(g3.decideAtIdle(A, goal(), 0).kind, 'none') // 已被重新武装
  assert.equal(g3.guardedCount(), 0)
  ok('goal 非 active / 重新武装：清 mark 结束窗口')
}

// ── 8. 全链路演练：派发→等待中设 goal→再 disarm→结算→resume ──
{
  const g = new GoalGuard()
  // 派发（无 goal）→ 等待
  assert.equal(g.dispatch(A, noGoal), undefined)
  // 等待中 human 设置 goal（armed）→ idle 决策 disarm（pre-step 竞态由 harness 自愈）
  let dec = g.decideAtIdle(A, goal(), 1)
  assert.equal(dec.kind, 'disarm')
  g.recordDisarm(A, dec.mark)
  // 结算 → runningChildren=0 → resume
  dec = g.decideAtIdle(A, goal({ activation: 'disarmed' }), 0)
  assert.equal(dec.kind, 'resume')
  g.clearMark(A)
  ok('全链路：派发→等待中设 goal→disarm→结算→resume')
}

// ── 9. snapshot / guardedCount / reset ──
{
  const g = new GoalGuard()
  g.recordDisarm(A, g.dispatch(A, goal()))
  const snap = g.snapshot()
  assert.equal(snap.length, 1)
  assert.deepEqual(snap[0], { agent: A, marked: true, poisoned: false })
  assert.equal(g.guardedCount(), 1)
  g.reset(A)
  assert.equal(g.guardedCount(), 0)
  assert.equal(g.has(A), false)
  ok('snapshot / guardedCount / reset / has')
}

// ── 10. countRunningChildren：只认 listDescendants 行（kind:'child' + activity）──
{
  const rows = [
    { kind: 'child', depth: 1, activity: 'running' },
    { kind: 'child', depth: 1, activity: 'inactive' },
    { kind: 'child', depth: 2, activity: 'running' },
    { kind: 'diagnostic', depth: 1, reason: 'unavailable' },
  ]
  assert.equal(countRunningChildren(rows), 2) // 两个 running child（含深度 2，与原生 runningDescendants 同源）
  // 关键回归：listChildren 的 catalog 行没有 activity 字段 → 恒 0（修复前故障）
  assert.equal(countRunningChildren([{ id: 'c1', mode: 'continuable', label: 'x' }]), 0)
  // 空 / 非数组 / 缺字段 → 0（不误判）
  assert.equal(countRunningChildren([]), 0)
  assert.equal(countRunningChildren(undefined), 0)
  assert.equal(countRunningChildren(null), 0)
  assert.equal(countRunningChildren([{ kind: 'child' }]), 0)
  ok('countRunningChildren：listDescendants 行按 running 计数；catalog 行恒 0')
}

console.log(`\ngoalGuard.test.mjs: ${passed} passed`)