/**
 * nested-delegation-guard 单测（对编译产物 lib/hooks.js + lib/delegate.js 运行）：
 *   node test/delegationGuard.test.mjs
 * 覆盖：派发工具面匹配 / 子代理会话判定（origin、delegationDepth）/ 主会话放行 /
 * hooks 配置开关 / buildSubagentRequest 的 toolFilter 合并（只读禁写 + denyTools 去重）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nestedDelegationGuard, isDelegationTool } from '../lib/hooks.js'
import { buildSubagentRequest } from '../lib/delegate.js'

let passed = 0
const ok = (name) => { passed += 1; console.log(`  ✓ ${name}`) }

/** 临时工作区（可带 .omo/omo.jsonc），隔离本机用户层配置的干扰只到"近层覆盖"为止。 */
const tempDirs = []
function tempWs(config) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-guard-test-'))
  tempDirs.push(ws)
  if (config !== undefined) {
    fs.mkdirSync(path.join(ws, '.omo'), { recursive: true })
    fs.writeFileSync(path.join(ws, '.omo', 'omo.jsonc'), JSON.stringify(config))
  }
  return ws
}

/** 构造 guard 入参：name + 会话 header（cwd=ws；origin/delegationDepth 可选）。 */
const exec = (ws, name, header = {}) => ({ name, agent: { session: { header: { cwd: ws, ...header } } } })

// ── 1. 派发工具面：delegate_as + 宿主具名通道 subagent / subagent_*；其他工具不误伤 ──
{
  assert.equal(isDelegationTool('delegate_as'), true)
  assert.equal(isDelegationTool('subagent'), true)
  for (const ch of ['subagent_default', 'subagent_deep', 'subagent_librarian', 'subagent_review', 'subagent_oracle']) {
    assert.equal(isDelegationTool(ch), true)
  }
  assert.equal(isDelegationTool('subagents'), false) // 无下划线前缀不算
  for (const t of ['write', 'edit', 'omo_agents', 'send_message', 'list_agents', 'omo_hashline_edit']) {
    assert.equal(isDelegationTool(t), false)
  }
  ok('派发工具面：delegate_as / subagent / subagent_* 命中，其余不误伤')
}

// ── 2. 主会话（无 origin/depth）调用派发工具：放行 ──
{
  const ws = tempWs(undefined)
  assert.equal(nestedDelegationGuard(exec(ws, 'delegate_as')), undefined)
  assert.equal(nestedDelegationGuard(exec(ws, 'subagent_deep', { origin: 'main' })), undefined)
  assert.equal(nestedDelegationGuard(exec(ws, 'subagent_deep', { delegationDepth: 0 })), undefined)
  ok('主会话：delegate_as / subagent_* 放行')
}

// ── 3. 子代理会话（origin=subagent）调用派发工具：拒绝 ──
{
  const ws = tempWs(undefined)
  const denied = nestedDelegationGuard(exec(ws, 'delegate_as', { origin: 'subagent' }))
  assert.equal(typeof denied, 'string')
  assert.match(denied, /nested-delegation-guard/)
  assert.match(denied, /编排者/)
  assert.equal(typeof nestedDelegationGuard(exec(ws, 'subagent_deep', { origin: 'subagent' })), 'string')
  assert.equal(typeof nestedDelegationGuard(exec(ws, 'subagent', { origin: 'subagent' })), 'string')
  ok('子代理（origin=subagent）：派发工具一律拒绝，消息含替代路径')
}

// ── 4. 深度判定：delegationDepth>0 拒绝（无 origin 也可）；无 header 会话放行 ──
{
  const ws = tempWs(undefined)
  assert.equal(typeof nestedDelegationGuard(exec(ws, 'delegate_as', { delegationDepth: 1 })), 'string')
  assert.equal(typeof nestedDelegationGuard(exec(ws, 'delegate_as', { delegationDepth: 3 })), 'string')
  assert.equal(nestedDelegationGuard(exec(ws, 'delegate_as', { delegationDepth: 0 })), undefined)
  // 无 agent/session（防御式）：绝不误拦
  assert.equal(nestedDelegationGuard({ name: 'delegate_as' }), undefined)
  ok('delegationDepth>0 拒绝；depth=0 / 无 header 放行')
}

// ── 5. 子代理会话的非派发工具：放行（守卫只管派发面）──
{
  const ws = tempWs(undefined)
  for (const t of ['write', 'edit', 'read', 'omo_agents', 'send_message', 'list_agents']) {
    assert.equal(nestedDelegationGuard(exec(ws, t, { origin: 'subagent', delegationDepth: 1 })), undefined)
  }
  ok('子代理会话：非派发工具不受守卫影响')
}

// ── 6. 开关：hooks.nested_delegation_guard=false 或 disabled_hooks 关闭后放行 ──
{
  const wsOff = tempWs({ opencode: { hooks: { nested_delegation_guard: false } } })
  assert.equal(nestedDelegationGuard(exec(wsOff, 'delegate_as', { origin: 'subagent' })), undefined)
  const wsDisabled = tempWs({ opencode: { disabled_hooks: ['nested-delegation-guard'] } })
  assert.equal(nestedDelegationGuard(exec(wsDisabled, 'delegate_as', { origin: 'subagent' })), undefined)
  ok('omo.jsonc hooks.nested_delegation_guard=false / disabled_hooks 可关闭')
}

// ── 7. buildSubagentRequest：只读禁写与 denyTools 合并、去重、空过滤器不携带 ──
{
  const role = { name: 'librarian', title: '调研员', mission: 'm', must: [], category: 'quick' }
  const specRO = { id: 'librarian', nativeTool: 'x', tier: 'flash', readOnly: true }
  const specRW = { id: 'default', nativeTool: 'x', tier: 'flash', readOnly: false }
  const base = { prompt: 'p', label: 'l', parent: {}, routes: { provider: 'spawn', flash: 'f', heavy: 'h' } }

  // 只读 + denyTools → 合并
  const ro = buildSubagentRequest({ ...base, role, spec: specRO, denyTools: ['delegate_as'] })
  assert.deepEqual(ro.toolFilter, { deny: ['write', 'edit', 'delegate_as'] })
  // 非只读 + denyTools → 仅 denyTools
  const rw = buildSubagentRequest({ ...base, role, spec: specRW, denyTools: ['delegate_as'] })
  assert.deepEqual(rw.toolFilter, { deny: ['delegate_as'] })
  // 非 only + 无 denyTools → 不携带 toolFilter（空过滤器会被宿主响亮拒绝）
  const plain = buildSubagentRequest({ ...base, role, spec: specRW })
  assert.equal('toolFilter' in plain, false)
  // 只读无 denyTools → 维持原行为
  const roOnly = buildSubagentRequest({ ...base, role, spec: specRO })
  assert.deepEqual(roOnly.toolFilter, { deny: ['write', 'edit'] })
  // 去重
  const dup = buildSubagentRequest({ ...base, role, spec: specRW, denyTools: ['delegate_as', 'delegate_as'] })
  assert.deepEqual(dup.toolFilter, { deny: ['delegate_as'] })
  ok('buildSubagentRequest：toolFilter 合并/去重/空过滤器不携带')
}

for (const d of tempDirs) fs.rmSync(d, { recursive: true, force: true })
console.log(`\ndelegationGuard.test.mjs: ${passed} passed`)
