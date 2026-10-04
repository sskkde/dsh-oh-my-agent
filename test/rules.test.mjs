/**
 * rules 祖先发现 / 路径边界 / 通道隔离 单测（对编译产物 lib/rules.js 运行）：
 *   node --test test/rules.test.mjs
 * 覆盖（omo-project-documentation 计划 T2 契约）：
 *   - 祖先 AGENTS 逐级命中（根 → src → src/module），来源在结果与编译块中可见
 *   - 兄弟目录 / 父工作区规则不进入；子 alwaysApply 与空 globs 不越过目录子树
 *   - session 通道不含局部 AGENTS（局部 session-only 不升级成全局）
 *   - 路径边界：../ 上跳、前缀碰撞（src2 ≠ src）、绝对外部路径、外指 symlink、
 *     外指 symlink 的 AGENTS.md 不读取
 *   - 缺失文件按实际父目录解析；目录目标含自身 AGENTS、不推断未知后代
 *   - 深于 walkFiles 10 层的祖先不遗漏；根 AGENTS/CLAUDE 与 mdc/规则目录既有行为不变
 *   - 子 CLAUDE.md 不加载；规则变更下一次解析立即生效
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { rulesForPath, sessionRules, scanRules, compileRules, loadRule } from '../lib/rules.js'

let ws = ''
const tempDirs = []

function mkws() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-rules-test-'))
  tempDirs.push(d)
  return d
}

/** 在 ws 内写文件（自动建父目录）。 */
function put(rel, content) {
  const f = path.join(ws, rel)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, content)
}

/** 带描述 frontmatter 的规则文件体。 */
const rule = (desc, body = `${desc} body`, extra = '') =>
  `---\ndescription: ${desc}\n${extra}---\n${body}\n`

beforeEach(() => { ws = mkws() })
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const names = (rules) => rules.map((r) => r.name)
const rels = (rules) => rules.map((r) => r.relPath)

test('多层祖先命中：根 → src → src/module 逐级进入，根在前，来源可见', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  put('src/module/AGENTS.md', rule('MODULE_RULE_MARK'))
  const { rules } = rulesForPath(ws, 'src/module/a.ts', 'file')
  const n = names(rules)
  assert.ok(n.includes('ROOT_RULE_MARK'), `root missing: ${n}`)
  assert.ok(n.includes('SRC_RULE_MARK'), `src missing: ${n}`)
  assert.ok(n.includes('MODULE_RULE_MARK'), `module missing: ${n}`)
  assert.ok(n.indexOf('ROOT_RULE_MARK') < n.indexOf('SRC_RULE_MARK'), 'root must come before src')
  assert.ok(n.indexOf('SRC_RULE_MARK') < n.indexOf('MODULE_RULE_MARK'), 'src must come before module')
  // 结果携带来源
  const src = rules.find((r) => r.name === 'SRC_RULE_MARK')
  assert.equal(src.relPath, 'src/AGENTS.md')
  assert.ok(path.isAbsolute(src.file))
  // 编译块显示来源
  const block = compileRules(rules)
  assert.match(block, /source:.*src\/AGENTS\.md/)
  assert.match(block, /MODULE_RULE_MARK/)
})

test('兄弟目录隔离：sibling AGENTS 不适用于目标路径', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/module/AGENTS.md', rule('MODULE_RULE_MARK'))
  put('src/sibling/AGENTS.md', rule('SIBLING_RULE_MARK'))
  put('sibling2/AGENTS.md', rule('SIBLING2_RULE_MARK'))
  const { rules } = rulesForPath(ws, 'src/module/a.ts', 'file')
  const n = names(rules)
  assert.ok(!n.includes('SIBLING_RULE_MARK'), `sibling leaked: ${n}`)
  assert.ok(!n.includes('SIBLING2_RULE_MARK'), `sibling2 leaked: ${n}`)
})

test('父工作区规则不上溯进入（workspace 即信任边界）', () => {
  const parent = mkws()
  fs.writeFileSync(path.join(parent, 'AGENTS.md'), rule('PARENT_RULE_MARK'))
  ws = path.join(parent, 'ws')
  fs.mkdirSync(ws, { recursive: true })
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  const { rules } = rulesForPath(ws, 'a.ts', 'file')
  assert.ok(!names(rules).includes('PARENT_RULE_MARK'))
})

test('子 alwaysApply / 空 globs 不越过目录子树', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/sibling/AGENTS.md', rule('LEAKY_ALWAYS', 'x', 'alwaysApply: true\n'))
  put('src/sibling2/AGENTS.md', rule('LEAKY_EMPTY_GLOBS'))
  const { rules } = rulesForPath(ws, 'src/module/a.ts', 'file')
  const n = names(rules)
  assert.ok(!n.includes('LEAKY_ALWAYS'), `alwaysApply leaked: ${n}`)
  assert.ok(!n.includes('LEAKY_EMPTY_GLOBS'), `empty-globs leaked: ${n}`)
})

test('session 通道不含局部 AGENTS（局部 session-only 不升级成全局）', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  put('src/sibling/AGENTS.md', rule('LOCAL_SESSION_ONLY', 'x', 'alwaysApply: true\napplyTo: [session]\n'))
  const s = sessionRules(ws)
  const n = names(s)
  assert.ok(n.includes('ROOT_RULE_MARK'), `root standing missing: ${n}`)
  assert.ok(!n.includes('SRC_RULE_MARK'), `local AGENTS in session: ${n}`)
  assert.ok(!n.includes('LOCAL_SESSION_ONLY'), `local session-only escalated: ${n}`)
})

test('file 通道受 applyTo 门约束：子 AGENTS 默认仅 file，声明 session-only 的子 AGENTS 不进 file', () => {
  put('src/AGENTS.md', rule('SRC_DEFAULT_FILE'))
  put('src/sibling/AGENTS.md', rule('SRC_SESSION_ONLY', 'x', 'applyTo: [session]\n'))
  const { rules } = rulesForPath(ws, 'src/a.ts', 'file')
  const n = names(rules)
  assert.ok(n.includes('SRC_DEFAULT_FILE'), 'sub AGENTS default applyTo must include file')
  assert.ok(!n.includes('SRC_SESSION_ONLY'), 'session-only sub AGENTS must not fire on file channel')
})

test('mdc / 规则目录既有行为不变（globs、alwaysApply、通道门）', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('other.mdc', rule('MDC_GLOB', 'x', 'globs: ["src/**"]\n'))
  put('standing.mdc', rule('MDC_STANDING', 'x', 'alwaysApply: true\n'))
  put('session-only.mdc', rule('MDC_SESSION', 'x', 'alwaysApply: true\napplyTo: [session]\n'))
  put('rules/dir-rule.md', rule('DIR_RULE', 'x', 'globs: ["**/*.ts"]\n'))
  const fileHit = rulesForPath(ws, 'src/a.ts', 'file')
  const n = names(fileHit.rules)
  assert.ok(n.includes('MDC_GLOB'), 'globs-matched mdc must fire on file channel')
  assert.ok(n.includes('MDC_STANDING'), 'alwaysApply mdc must fire')
  assert.ok(n.includes('DIR_RULE'), 'rules-dir file must fire')
  assert.ok(!n.includes('MDC_SESSION'), 'session-only mdc must not fire on file channel')
  const topHit = rulesForPath(ws, 'top.md', 'file')
  assert.ok(!names(topHit.rules).includes('MDC_GLOB'), 'globs must not match outside src/**')
  assert.ok(!names(topHit.rules).includes('DIR_RULE'), 'dir rule globs must not match .md')
})

test('合法点前缀目录 ..evil 保持子规则作用域且不进入兄弟/session/空目标', () => {
  put('..evil/AGENTS.md', rule('DOT_PREFIX_RULE', 'x', 'alwaysApply: true\n'))
  put('..evil-sibling/AGENTS.md', rule('DOT_PREFIX_SIBLING'))
  const local = loadRule(ws, path.join(ws, '..evil', 'AGENTS.md'))
  assert.equal(local?.scopeDir, '..evil')
  assert.deepEqual(local?.applyTo, ['file'])
  assert.ok(!names(sessionRules(ws)).includes('DOT_PREFIX_RULE'))
  assert.ok(!names(rulesForPath(ws, '..evil-sibling/a.ts', 'file').rules).includes('DOT_PREFIX_RULE'))
  assert.ok(!names(rulesForPath(ws, '', 'file').rules).includes('DOT_PREFIX_RULE'))
})

test('路径边界：src2 前缀碰撞不算 src 内', () => {
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  put('src2/keep.txt', 'x')
  const { rules } = rulesForPath(ws, 'src2/a.ts', 'file')
  assert.ok(!names(rules).includes('SRC_RULE_MARK'), 'src2 must not match src scope')
})

test('路径边界：../ 上跳与绝对外部路径返回空（不加载伪祖先）', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  for (const target of ['../evil.ts', '/etc/passwd', path.join(os.tmpdir(), 'omo-outside-x', 'a.ts')]) {
    const r = rulesForPath(ws, target, 'file')
    assert.equal(r.rules.length, 0, `target ${target} must match nothing, got ${names(r.rules)}`)
  }
})

test('路径边界：外指 symlink 目录不加载（不读外部规则）', () => {
  const outside = mkws()
  fs.writeFileSync(path.join(outside, 'AGENTS.md'), rule('OUTSIDE_RULE_MARK'))
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  fs.symlinkSync(outside, path.join(ws, 'link'))
  const r = rulesForPath(ws, path.join('link', 'a.ts'), 'file')
  assert.equal(r.rules.length, 0, `symlink escape must match nothing, got ${names(r.rules)}`)
})

test('路径边界：外指 symlink 的 AGENTS.md 不读取外部内容', () => {
  const outside = mkws()
  fs.writeFileSync(path.join(outside, 'AGENTS.md'), rule('OUTSIDE_RULE_MARK'))
  put('src/keep.txt', 'x')
  // ws/src/AGENTS.md 是指向外部文件的 symlink
  fs.symlinkSync(path.join(outside, 'AGENTS.md'), path.join(ws, 'src', 'AGENTS.md'))
  const { rules } = rulesForPath(ws, 'src/a.ts', 'file')
  assert.ok(!names(rules).includes('OUTSIDE_RULE_MARK'), 'external symlinked AGENTS content must not load')
})

test('缺失文件按实际父目录解析祖先链', () => {
  put('src/module/AGENTS.md', rule('MODULE_RULE_MARK'))
  const { rules } = rulesForPath(ws, 'src/module/ghost.ts', 'file')
  assert.ok(names(rules).includes('MODULE_RULE_MARK'))
})

test('目录目标：含自身 AGENTS，不推断未知后代', () => {
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  put('src/module/AGENTS.md', rule('MODULE_RULE_MARK'))
  put('src/module/sample.txt', 'SAMPLE')
  const dirSelf = rulesForPath(ws, 'src/module', 'file')
  assert.ok(names(dirSelf.rules).includes('MODULE_RULE_MARK'), 'dir target must include its own AGENTS')
  const dirParent = rulesForPath(ws, 'src', 'file')
  const n = names(dirParent.rules)
  assert.ok(n.includes('SRC_RULE_MARK'), 'dir target must include its own level')
  assert.ok(!n.includes('MODULE_RULE_MARK'), `dir target must not infer descendant rules: ${n}`)
})

test('深于 walkFiles 10 层的祖先不遗漏', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  const deepRel = Array.from({ length: 13 }, (_, i) => `l${i + 1}`).join('/')
  put(`${deepRel}/AGENTS.md`, rule('DEEP_RULE_MARK'))
  const { rules } = rulesForPath(ws, `${deepRel}/a.ts`, 'file')
  const n = names(rules)
  assert.ok(n.includes('ROOT_RULE_MARK'))
  assert.ok(n.includes('DEEP_RULE_MARK'), `deep ancestor missed (walk cap): ${n}`)
})

test('100 层以上祖先完整收集且父规则按真实深度先于子规则', () => {
  const segments = Array.from({ length: 100 }, (_, i) => `d${i}`)
  put(`${segments.join('/')}/AGENTS.md`, rule('DEEPEST_RULE'))
  put(`${segments.slice(0, 99).join('/')}/AGENTS.md`, rule('PARENT_99_RULE'))
  put(`${segments.slice(0, 20).join('/')}/AGENTS.md`, rule('MID_20_RULE'))
  put(`${segments.join('/')}/a.ts`, 'x')
  const { rules } = rulesForPath(ws, `${segments.join('/')}/a.ts`, 'file')
  const n = names(rules)
  for (const marker of ['MID_20_RULE', 'PARENT_99_RULE', 'DEEPEST_RULE']) {
    assert.ok(n.includes(marker), `ancestor missing: ${marker}`)
  }
  assert.ok(n.indexOf('MID_20_RULE') < n.indexOf('PARENT_99_RULE'))
  assert.ok(n.indexOf('PARENT_99_RULE') < n.indexOf('DEEPEST_RULE'))
})

test('根 only 项目无回归：file 与 session 通道仍只有根规则', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('CLAUDE.md', rule('ROOT_CLAUDE_MARK'))
  const { rules } = rulesForPath(ws, 'src/a.ts', 'file')
  assert.deepEqual(names(rules).sort(), ['ROOT_CLAUDE_MARK', 'ROOT_RULE_MARK'])
  assert.deepEqual(names(sessionRules(ws)).sort(), ['ROOT_CLAUDE_MARK', 'ROOT_RULE_MARK'])
})

test('根 CLAUDE 与 mdc 外指 symlink 均不读取', () => {
  const outside = mkws()
  fs.writeFileSync(path.join(outside, 'CLAUDE.md'), rule('OUTSIDE_CLAUDE_MARK'))
  fs.writeFileSync(path.join(outside, 'external.mdc'), rule('OUTSIDE_MDC_MARK'))
  fs.symlinkSync(path.join(outside, 'CLAUDE.md'), path.join(ws, 'CLAUDE.md'))
  fs.symlinkSync(path.join(outside, 'external.mdc'), path.join(ws, 'external.mdc'))
  const found = scanRules(ws)
  assert.ok(!found.some((r) => r.name === 'OUTSIDE_CLAUDE_MARK'))
  assert.ok(!found.some((r) => r.name === 'OUTSIDE_MDC_MARK'))
})

test('子 CLAUDE.md 不加载（不扩展）', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/CLAUDE.md', rule('SUB_CLAUDE_MARK'))
  assert.ok(!rels(scanRules(ws)).includes('src/CLAUDE.md'))
  const { rules } = rulesForPath(ws, 'src/a.ts', 'file')
  assert.ok(!names(rules).includes('SUB_CLAUDE_MARK'))
})

test('规则变更下一次解析立即生效（无 TTL 缓存）', () => {
  put('src/AGENTS.md', rule('SRC_RULE_V1'))
  const first = rulesForPath(ws, 'src/a.ts', 'file')
  assert.ok(names(first.rules).includes('SRC_RULE_V1'))
  put('src/AGENTS.md', rule('SRC_RULE_V2'))
  const second = rulesForPath(ws, 'src/a.ts', 'file')
  const n = names(second.rules)
  assert.ok(n.includes('SRC_RULE_V2'), 'new content must be visible on next resolve')
  assert.ok(!n.includes('SRC_RULE_V1'), 'stale content must not persist')
})

test('空规则正文仍被过滤；scanRules 覆盖子 AGENTS', () => {
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/AGENTS.md', rule('SRC_RULE_MARK'))
  put('src/empty.mdc', rule('EMPTY_BODY', '   '))
  const all = rels(scanRules(ws))
  assert.ok(all.includes('src/AGENTS.md'), 'scanRules must list sub AGENTS')
  const { rules } = rulesForPath(ws, 'src/a.ts', 'file')
  assert.ok(!names(rules).includes('EMPTY_BODY'), 'empty body must never fire')
})
