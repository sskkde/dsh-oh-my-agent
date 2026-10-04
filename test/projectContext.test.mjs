/**
 * projectContext 有界规则组合 单测（对编译产物 lib/projectContext.js 运行）：
 *   node --test test/projectContext.test.mjs
 * 覆盖（omo-project-documentation 计划 T3 契约）：
 *   - 同一纯组合服务 brief 与 hook：目标规范化、跨目标正文去重并标注适用目标、来源可见
 *   - 预算（默认 2500，含提示头与来源清单）：整条装填不截半句；根超预算显式不完整；
 *     来源清单超预算退化为最小不完整声明 + omo_rules 指引
 *   - files 为空仅给根/常设规则；路径外目标忽略；缺 workspace 返回空块
 *   - 去重指纹覆盖全部适用源（含被预算省略者）：省略源变化 → hash 变化
 *   - buildBrief / composeDelegationPrompt 旧调用兼容 + 可选 context 段
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ruleContextForTargets, RULE_CONTEXT_BUDGET } from '../lib/projectContext.js'
import { buildBrief, findRole } from '../lib/agents.js'
import { composeDelegationPrompt } from '../lib/delegate.js'

let ws = ''
const tempDirs = []

function mkws() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-ctx-test-'))
  tempDirs.push(d)
  return d
}

function put(rel, content) {
  const f = path.join(ws, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content)
}

const rule = (desc, body = `${desc} body`, extra = '') =>
  `---\ndescription: ${desc}\n${extra}---\n${body}\n`

const ROLE = { name: 'librarian', title: '调研员', mission: '检索与提炼', must: ['附来源'], category: 'quick' }

beforeEach(() => { ws = mkws() })
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1

test('同一祖先重复目标：正文去重且标注全部适用目标', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  const pkg = ruleContextForTargets(ws, ['src/a.ts', 'src/b.ts'])
  assert.equal(pkg.complete, true)
  assert.deepEqual(pkg.targets, ['src/a.ts', 'src/b.ts'])
  assert.equal(countOccurrences(pkg.block, 'SRC_RULE_MARK body'), 1, 'body must appear once')
  assert.match(pkg.block, /applies to: src\/a\.ts, src\/b\.ts/)
  assert.match(pkg.block, /source:.*src\/AGENTS\.md/)
  assert.match(pkg.block, /source:.*AGENTS\.md/)
})

test('跨子树目标：局部块按目标分组，不提升为任务全局规则', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  put('lib/AGENTS.md', rule('LIB_RULE_MARK'))
  const pkg = ruleContextForTargets(ws, ['src/a.ts', 'lib/b.ts'])
  assert.match(pkg.block, /applies to: src\/a\.ts/)
  assert.match(pkg.block, /applies to: lib\/b\.ts/)
  // 局部条目只标注自己的目标（根级条目合法地标注全部目标）
  const segFor = (srcFile) => pkg.block.split(/\n### /).find((s) => s.includes(`source: ${srcFile}`)) ?? ''
  const srcSeg = segFor('src/AGENTS.md')
  const libSeg = segFor('lib/AGENTS.md')
  assert.ok(srcSeg.includes('applies to: src/a.ts') && !srcSeg.includes('lib/b.ts'), 'src entry must not claim lib target')
  assert.ok(libSeg.includes('applies to: lib/b.ts') && !libSeg.includes('src/a.ts'), 'lib entry must not claim src target')
  assert.match(pkg.block, /scope: src\//)
})

test('相同正文跨 scope 不合并成错误的 scope/target 对', () => {
  const body = 'SAME_BODY_ACROSS_SCOPES'
  put('a/AGENTS.md', rule('A_RULE', body))
  put('b/AGENTS.md', rule('B_RULE', body))
  const pkg = ruleContextForTargets(ws, ['a/x.ts', 'b/y.ts'])
  const a = pkg.entries.find((e) => e.sources.includes('a/AGENTS.md'))
  const b = pkg.entries.find((e) => e.sources.includes('b/AGENTS.md'))
  assert.ok(a && b)
  assert.equal(a.scopeDir, 'a')
  assert.deepEqual(a.targets, ['a/x.ts'])
  assert.equal(b.scopeDir, 'b')
  assert.deepEqual(b.targets, ['b/y.ts'])
})

test('排序：全局常设在前，祖先规则根到深层', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  put('src/module/AGENTS.md', rule('MODULE_RULE_MARK'))
  const pkg = ruleContextForTargets(ws, ['src/module/a.ts'])
  const iRoot = pkg.block.indexOf('ROOT_RULE_MARK body')
  const iSrc = pkg.block.indexOf('SRC_RULE_MARK body')
  const iMod = pkg.block.indexOf('MODULE_RULE_MARK body')
  assert.ok(iRoot !== -1 && iSrc !== -1 && iMod !== -1)
  assert.ok(iRoot < iSrc && iSrc < iMod, 'global first, then root→deep')
})

test('深于 64 层的父规则仍先于子规则排序', () => {
  const segments = Array.from({ length: 70 }, (_, i) => `p${i}`)
  put(`${segments.slice(0, 69).join('/')}/AGENTS.md`, rule('DEEP_PARENT'))
  put(`${segments.join('/')}/AGENTS.md`, rule('DEEP_CHILD'))
  const pkg = ruleContextForTargets(ws, [`${segments.join('/')}/file.ts`])
  const parent = pkg.block.indexOf('DEEP_PARENT body')
  const child = pkg.block.indexOf('DEEP_CHILD body')
  assert.ok(parent !== -1 && child !== -1)
  assert.ok(parent < child)
})

test('根规则超预算：显式不完整 + 来源 + omo_rules 指引，不截半句冒充完整', () => {
  const big = 'X'.repeat(4000)
  put('AGENTS.md', `---\ndescription: BIG_ROOT\n---\n${big}\n`)
  const pkg = ruleContextForTargets(ws, ['src/a.ts'])
  assert.equal(pkg.complete, false)
  assert.ok(pkg.block.length <= RULE_CONTEXT_BUDGET, `block must fit budget: ${pkg.block.length}`)
  assert.match(pkg.block, /contextIncomplete/)
  assert.match(pkg.block, /AGENTS\.md/)
  assert.match(pkg.block, /omo_rules action=path/)
  assert.ok(!pkg.block.includes(big.slice(0, 200)), 'oversized body must not be partially included')
})

test('多条目部分装下：放不下的整条列入 omitted 来源清单；hash 覆盖被省略源', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK', 'R'.repeat(1800)))
  put('src/AGENTS.md', rule('SRC_RULE_MARK', 'S'.repeat(900)))
  const pkg = ruleContextForTargets(ws, ['src/a.ts'])
  assert.equal(pkg.complete, false)
  assert.ok(pkg.block.length <= RULE_CONTEXT_BUDGET)
  // 被省略的整条以来源列入清单（不列正文，不冒充完整）
  assert.match(pkg.block, /contextIncomplete/)
  assert.match(pkg.block, /- src\/AGENTS\.md（src\/a\.ts）/)
  assert.ok(!pkg.block.includes('SSSS'), 'omitted body must not leak into the block')
  const h1 = pkg.hash
  // 被省略源变化 → hash 变化（被预算省略项也在指纹里）
  put('src/AGENTS.md', rule('SRC_RULE_MARK', 'S'.repeat(901)))
  const pkg2 = ruleContextForTargets(ws, ['src/a.ts'])
  assert.notEqual(pkg2.hash, h1, 'omitted-source change must change the delivery hash')
  // 相同输入 → 相同 hash
  const pkg3 = ruleContextForTargets(ws, ['src/a.ts'])
  assert.equal(pkg3.hash, pkg2.hash)
})

test('上下文 fingerprint 覆盖 metadata、预算与显示字段', () => {
  put('a/AGENTS.md', rule('DESC_A', 'SAME_BODY'))
  const first = ruleContextForTargets(ws, ['a/x.ts'], { budget: 1200, header: 'HEADER_A' })
  put('a/AGENTS.md', rule('A_MUCH_LONGER_DESCRIPTION', 'SAME_BODY'))
  const metadataChanged = ruleContextForTargets(ws, ['a/x.ts'], { budget: 1200, header: 'HEADER_A' })
  assert.notEqual(metadataChanged.hash, first.hash)
  const budgetChanged = ruleContextForTargets(ws, ['a/x.ts'], { budget: 900, header: 'HEADER_A' })
  assert.notEqual(budgetChanged.hash, metadataChanged.hash)
  const headerChanged = ruleContextForTargets(ws, ['a/x.ts'], { budget: 1200, header: 'HEADER_B' })
  assert.notEqual(headerChanged.hash, metadataChanged.hash)
})

test('来源清单也超预算：退化为最小不完整声明（仍不超预算）', () => {
  // 两条深链（每条 30 层 AGENTS，正文都超预算且互不相同）→ 来源路径极长，完整清单装不下
  for (const root of ['a', 'b']) {
    let rel = root
    put(`${rel}/AGENTS.md`, rule(`DEEP_${root}_0`, 'R'.repeat(2400) + `#${root}_0`))
    for (let i = 1; i < 30; i++) {
      rel = `${rel}/x${i}`
      put(`${rel}/AGENTS.md`, rule(`DEEP_${root}_${i}`, 'R'.repeat(2400) + `#${root}_${i}`))
    }
    put(`${rel}/leaf.txt`, 'x')
  }
  const pkg = ruleContextForTargets(ws, ['a/' + Array.from({ length: 29 }, (_, i) => `x${i + 1}`).join('/') + '/leaf.txt',
                                       'b/' + Array.from({ length: 29 }, (_, i) => `x${i + 1}`).join('/') + '/leaf.txt'])
  assert.equal(pkg.complete, false)
  assert.ok(pkg.entries.length >= 60, `deep-chain entries expected, got ${pkg.entries.length}`)
  assert.ok(pkg.block.length <= RULE_CONTEXT_BUDGET, `block must fit budget: ${pkg.block.length}`)
  assert.match(pkg.block, /contextIncomplete/)
  assert.match(pkg.block, /omo_rules action=path/)
  assert.ok(!pkg.block.includes('b/x29/AGENTS.md'), 'overflowing source list must degrade to the minimal notice')
})

test('预算边界：恰好装下的整条必须装入（含提示头计入预算）', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK', 'R'.repeat(100)))
  put('src/AGENTS.md', rule('SRC_RULE_MARK', 'S'.repeat(60)))
  // 计算精确预算：header + entry1 + entry2
  const full = ruleContextForTargets(ws, ['src/a.ts'], { budget: 100000 })
  assert.equal(full.complete, true)
  const needed = full.block.length
  const edge = ruleContextForTargets(ws, ['src/a.ts'], { budget: needed })
  assert.equal(edge.complete, true, 'exact-budget entry must be included whole')
  assert.equal(edge.block.length, needed)
  const tighter = ruleContextForTargets(ws, ['src/a.ts'], { budget: needed - 1 })
  assert.equal(tighter.complete, false, 'one char less must omit the tail entry')
})

test('files 为空：仅根 / 常设规则，不推断目录目标的后代规则', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  put('standing.mdc', rule('STANDING_MARK', 'x', 'alwaysApply: true\n'))
  const pkg = ruleContextForTargets(ws, [])
  assert.deepEqual(pkg.targets, [])
  assert.match(pkg.block, /ROOT_RULE_MARK/)
  assert.match(pkg.block, /STANDING_MARK/)
  assert.ok(!pkg.block.includes('SRC_RULE_MARK'), 'no files → no directory-scoped rules')
})

test('路径外目标被忽略；缺 workspace 返回空块不抛错', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  const pkg = ruleContextForTargets(ws, ['../outside.ts', '/etc/passwd'])
  assert.deepEqual(pkg.targets, [])
  assert.match(pkg.block, /ROOT_RULE_MARK/, 'invalid targets degrade to root/standing')
  const empty = ruleContextForTargets('', ['a.ts'])
  assert.equal(empty.block, '')
  assert.equal(empty.entries.length, 0)
})

test('无任何规则：块为空、hash 稳定', () => {
  const pkg = ruleContextForTargets(ws, ['src/a.ts'])
  assert.equal(pkg.block, '')
  assert.equal(pkg.entries.length, 0)
  const again = ruleContextForTargets(ws, ['src/a.ts'])
  assert.equal(pkg.hash, again.hash)
})

test('buildBrief 旧调用兼容（4 参不出现规则段）；可选 context 追加规则段', () => {
  const base = buildBrief(ROLE, 'do research', ['src/a.ts'], {})
  assert.ok(!base.includes('项目规则与知识入口'), 'legacy call must not add a rules section')
  const withCtx = buildBrief(ROLE, 'do research', ['src/a.ts'], {}, '[OMO RULES] 适用于 src/a.ts\n### R\nbody')
  assert.match(withCtx, /## 项目规则与知识入口/)
  assert.match(withCtx, /不得放宽根级约束/)
  assert.match(withCtx, /### R/)
  assert.ok(withCtx.startsWith(base.slice(0, 50)), 'brief head unchanged')
})

test('composeDelegationPrompt 可选 context 透传进简报', () => {
  const plain = composeDelegationPrompt(ROLE, 'task', [], '', {})
  assert.ok(!plain.includes('项目规则与知识入口'))
  const withCtx = composeDelegationPrompt(ROLE, 'task', [], 'extra note', {}, 'CTXTX')
  assert.match(withCtx, /CTXTX/)
  assert.match(withCtx, /项目规则与知识入口/)
  assert.match(withCtx, /本次补充/)
})

test('findRole 仍可用（agents 模块回归）', () => {
  assert.equal(findRole('librarian')?.name, 'librarian')
})
