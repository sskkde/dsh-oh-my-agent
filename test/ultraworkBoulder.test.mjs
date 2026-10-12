/**
 * ultrawork boulder 水位 单测（对编译产物 lib/ultrawork.js 运行）：
 *   node --test test/ultraworkBoulder.test.mjs
 * 覆盖缺陷报告 omo-two-bugs.md BUG-2：
 *   - boulder 不可写时 createUltraPlan 仍必须成功（水位写入是 best-effort，
 *     与同模块 updateUltraPhase / recordWaveProgress 的既有约定一致）
 *   - boulder 可写时水位照常写入（修复不能把功能一起吞掉）
 * 失败注入：把 .omo/boulder.json 建成目录，使原子 rename 必然 EISDIR
 *   （root 下 chmod 555 会被绕过，故不用只读目录）。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUltraPlan, readUltraPlan, updateUltraPhase, recordWaveProgress } from '../lib/ultrawork.js'
import { loadBoulder } from '../lib/boulder.js'

const tempDirs = []

function mkws() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-uw-'))
  tempDirs.push(d)
  return d
}

const waves = [{ name: 'w1', category: 'quick', goal: 'g1', files: [] }]

afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

test('boulder 不可写时 createUltraPlan 不抛错，计划本体照常落盘（BUG-2）', () => {
  const ws = mkws()
  fs.mkdirSync(path.join(ws, '.omo', 'boulder.json'), { recursive: true })

  let plan
  assert.doesNotThrow(() => { plan = createUltraPlan(ws, 'goal', waves, ['v']) }, 'boulder 写入失败不得拖垮建计划')
  assert.equal(plan.phase, 'plan')
  assert.ok(fs.existsSync(path.join(ws, '.omo', 'work', 'latest.json')), 'latest.json 必须落盘')
  assert.ok(fs.existsSync(path.join(ws, '.omo', 'plans', plan.id + '.md')), 'plans/<id>.md 必须落盘')
  assert.equal(readUltraPlan(ws).id, plan.id)

  // 同模块另两处写入本就有保护：修复后行为一致
  assert.doesNotThrow(() => updateUltraPhase(ws, 'waves'))
  assert.doesNotThrow(() => recordWaveProgress(ws, 1))
  assert.equal(loadBoulder(ws).activePlan, undefined, 'boulder 不可写时降级为无水位')
})

test('boulder 可写时仍写入 RESUME 水位（功能未被吞掉）', () => {
  const ws = mkws()
  const plan = createUltraPlan(ws, 'some goal', waves, ['v'])
  const wm = loadBoulder(ws).activePlan
  assert.ok(wm, 'activePlan 水位必须写入')
  assert.equal(wm.planId, plan.id)
  assert.equal(wm.total, 1)
  assert.equal(wm.completed, 0)
  assert.equal(wm.status, 'active')

  recordWaveProgress(ws, 1)
  assert.equal(loadBoulder(ws).activePlan.status, 'complete')
})
