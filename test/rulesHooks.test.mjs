/**
 * 规则渠道接入 单测（对编译产物 lib/hooks.js / lib/index.js / lib/handoff.js 运行）：
 *   node --test test/rulesHooks.test.mjs
 * 覆盖（omo-project-documentation 计划 T4 契约）：
 *   - 成功 read 在后置上下文附局部规则（祖先命中、兄弟隔离）；成功 edit 保留注入行为
 *   - 失败 read/edit 不伪称已交付；hook disabled 不注入；缺 workspace 不猜 cwd
 *   - 会话级交付账本：同块重复静默、规则变更（A→B→A）重投、会话隔离、无 TTL 缓存
 *   - omo_agents brief 经同一 context 组合（buildTools 捕获实际 prompt）：files 局部范围不提升为全局
 *   - handoff 带知识职责导航与「docs/notes 未自动收集」声明，旧参数语义保留
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { omoPostExecute } from '../lib/hooks.js'
import { buildTools, apply } from '../lib/index.js'
import { buildHandoff } from '../lib/handoff.js'
import { ruleContextForTargets } from '../lib/projectContext.js'
import { buildBrief } from '../lib/agents.js'

let ws = ''
const tempDirs = []

function mkws() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-hooktest-'))
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

beforeEach(() => {
  ws = mkws()
  put('AGENTS.md', rule('ROOT_RULE_MARK'))
  put('src/module/AGENTS.md', rule('MODULE_RULE_MARK'))
  put('src/sibling/AGENTS.md', rule('SIBLING_RULE_MARK'))
  put('src/module/sample.txt', 'SAMPLE')
})
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** 构造 post-execute 调用；返回最终 decision。`session` 是被复用的会话对象
 * （交付账本按 session 对象身份隔离——同一会话的多次调用须传同一对象）。 */
async function post(name, fileRel, { error = false, session } = {}) {
  const exec = {
    name,
    arguments: { file_path: fileRel },
    agent: { session: session ?? { header: { cwd: ws } } },
  }
  const decision = await omoPostExecute(exec, { isError: error }, async () => ({ kind: 'accept' }))
  return decision
}

const contextsOf = (decision) => {
  const ctxs = decision?.additionalContexts ?? []
  return ctxs.map((c) => {
    const blocks = Array.isArray(c?.content) ? c.content : []
    return blocks.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
  }).filter(Boolean)
}
const allText = (decision) => contextsOf(decision).join('\n')

test('成功 read：后置上下文附祖先规则，兄弟隔离，来源可见', async () => {
  const decision = await post('read', 'src/module/sample.txt')
  const t = allText(decision)
  assert.match(t, /ROOT_RULE_MARK/, 'root ancestor must be delivered on read')
  assert.match(t, /MODULE_RULE_MARK/, 'module ancestor must be delivered on read')
  assert.ok(!t.includes('SIBLING_RULE_MARK'), 'sibling rules must not leak')
  assert.match(t, /source:.*src\/module\/AGENTS\.md/, 'sources must be visible')
})

test('成功 edit：保留既有注入行为（路径规则包）', async () => {
  const decision = await post('edit', 'src/module/sample.txt')
  const t = allText(decision)
  assert.match(t, /MODULE_RULE_MARK/)
  assert.ok(!t.includes('SIBLING_RULE_MARK'))
})

test('失败 read/edit：不伪称已交付（走恢复路径，无规则包）', async () => {
  const readFail = await post('read', 'src/module/sample.txt', { error: true })
  assert.ok(!allText(readFail).includes('RULE_MARK'), 'failed read must not deliver rules')
  const editFail = await post('edit', 'src/module/sample.txt', { error: true })
  assert.ok(!allText(editFail).includes('MODULE_RULE_MARK'), 'failed edit must not deliver rules')
})

test('hook disabled：read 与 edit 都不注入', async () => {
  put('.omo/omo.jsonc', JSON.stringify({ opencode: { disabled_hooks: ['rules-injector'] } }))
  const read = await post('read', 'src/module/sample.txt')
  assert.ok(!allText(read).includes('[OMO RULES]'), 'disabled rules-injector must not inject on read')
  assert.ok(!allText(read).includes('RULE_MARK'), 'no rule content on read when disabled')
  const edit = await post('edit', 'src/module/sample.txt')
  assert.ok(!allText(edit).includes('[OMO RULES]'), 'disabled rules-injector must not inject on edit')
})

test('缺 workspace：不猜 cwd，不注入不抛错', async () => {
  const exec = { name: 'read', arguments: { file_path: 'src/module/sample.txt' } }
  const decision = await omoPostExecute(exec, { isError: false }, async () => ({ kind: 'accept' }))
  assert.equal(contextsOf(decision).length, 0)
})

test('交付账本：同块重复静默；规则变更立即重投（A→B）；会话隔离', async () => {
  const s1 = { header: { cwd: ws } }
  const first = await post('read', 'src/module/sample.txt', { session: s1 })
  assert.match(allText(first), /MODULE_RULE_MARK/)
  const repeat = await post('read', 'src/module/sample.txt', { session: s1 })
  assert.ok(!allText(repeat).includes('MODULE_RULE_MARK'), 'identical block must be suppressed')
  // 规则变更 → 下一次 read 立即反映（无 TTL 缓存）
  put('src/module/AGENTS.md', rule('MODULE_RULE_V2'))
  const changed = await post('read', 'src/module/sample.txt', { session: s1 })
  assert.match(allText(changed), /MODULE_RULE_V2/, 'rule change must be visible immediately')
  // A→B→A：改回旧内容也是变化 → 必须重新投递（而非静默吞掉）
  put('src/module/AGENTS.md', rule('MODULE_RULE_MARK'))
  const back = await post('read', 'src/module/sample.txt', { session: s1 })
  assert.ok(!allText(back).includes('MODULE_RULE_V2'), 'stale content must not return')
  assert.match(allText(back), /MODULE_RULE_MARK/, 'A→B→A fallback must be re-delivered')
  // 会话隔离：另一会话第一次读仍应拿到
  const s2 = { header: { cwd: ws } }
  const other = await post('read', 'src/module/sample.txt', { session: s2 })
  assert.match(allText(other), /MODULE_RULE_MARK/, 'sessions must not suppress each other')
})

test('omo_agents brief 经同一 context 组合：files 局部范围不提升为全局', async () => {
  const config = {
    defaultWorkspace: '', workspaceHints: [], delegateProvider: 'spawn',
    delegateFlashRoute: 'f/x', delegateHeavyRoute: 'h/y', mainPrompt: 'off',
    customPromptSection: '', goalGuardOn: true,
  }
  const tools = buildTools(config)
  const agentsTool = tools.find((t) => t.name === 'omo_agents')
  assert.ok(agentsTool, 'omo_agents must be registered')
  const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: ws } } } }
  const out = await agentsTool.execute(
    { action: 'brief', role: 'librarian', task: '检查 sample 与其祖先规则，只读复述', files: ['src/module/sample.txt'] },
    exec,
  )
  assert.equal(out.ok, true)
  const brief = String(out.brief)
  assert.match(brief, /## 项目规则与知识入口/, 'brief must carry the composed rules section')
  assert.match(brief, /MODULE_RULE_MARK/, 'files-scoped ancestors must be included')
  assert.match(brief, /applies to: src\/module\/sample\.txt/, 'local rules must be labeled with their target')
  assert.match(brief, /不得放宽根级约束/, 'brief must declare locals never loosen root constraints')
  assert.ok(!brief.includes('SIBLING_RULE_MARK'), 'sibling rules must not leak into the brief')
})

test('实际 delegate_as execute 将组合规则上下文放入派发 request.prompt', async () => {
  const captured = []
  const registered = new Map()
  const disposers = []
  const subagents = {
    startContinuable: async ({ request }) => { captured.push(request); return { childId: 'mock-child' } },
    start: async () => { throw new Error('foreground path was not requested') },
  }
  const ctx = {
    inject: (_deps, callback) => callback({}),
    effect: (callback) => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    get: (name) => name === 'subagents' ? subagents : undefined,
    tools: { register: (definition) => registered.set(definition.name, definition), guard: () => () => {} },
    skills: { register: () => () => {} },
    on: () => () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, {
    defaultWorkspace: ws, workspaceHints: [], delegateProvider: 'spawn',
    delegateFlashRoute: 'f/x', delegateHeavyRoute: 'h/y', mainPrompt: 'off',
    customPromptSection: '', goalGuardOn: false,
  })
  try {
    const tool = registered.get('delegate_as')
    assert.ok(tool)
    const out = await tool.execute(
      { role: 'librarian', task: 'check local rules', files: ['src/module/sample.txt'], extras: '', run_in_background: true },
      { signal: new AbortController().signal, agent: { id: 'parent', session: { header: { cwd: ws } } } },
    )
    assert.equal(out.ok, true)
    assert.equal(captured.length, 1)
    const prompt = captured[0].prompt[0].text
    assert.match(prompt, /MODULE_RULE_MARK/)
    assert.match(prompt, /applies to: src\/module\/sample\.txt/)
    assert.ok(!prompt.includes('SIBLING_RULE_MARK'))
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
})

test('metadata-only 规则变更导致 hook 重新投递', async () => {
  const s = { header: { cwd: ws } }
  const first = await post('read', 'src/module/sample.txt', { session: s })
  assert.match(allText(first), /MODULE_RULE_MARK/)
  const repeat = await post('read', 'src/module/sample.txt', { session: s })
  assert.equal(allText(repeat), '')
  put('src/module/AGENTS.md', rule('A_CHANGED_DESCRIPTION_LONGER', 'MODULE_RULE_MARK body'))
  const changed = await post('read', 'src/module/sample.txt', { session: s })
  assert.match(allText(changed), /A_CHANGED_DESCRIPTION_LONGER/)
})

test('预算省略的规则变化仍由 hook 指纹触发重投', async () => {
  put('AGENTS.md', rule('LARGE_ROOT', 'R'.repeat(1800)))
  put('src/module/AGENTS.md', rule('OMITTED_LOCAL', 'S'.repeat(900)))
  const s = { header: { cwd: ws } }
  const first = await post('read', 'src/module/sample.txt', { session: s })
  assert.match(allText(first), /contextIncomplete/)
  assert.match(allText(first), /src\/module\/AGENTS\.md/)
  put('src/module/AGENTS.md', rule('OMITTED_LOCAL', 'S'.repeat(901)))
  const changed = await post('read', 'src/module/sample.txt', { session: s })
  assert.match(allText(changed), /contextIncomplete/)
})

test('10 分钟后相同规则可重投（时钟控制）', async () => {
  const originalNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  try {
    const s = { header: { cwd: ws } }
    assert.match(allText(await post('read', 'src/module/sample.txt', { session: s })), /MODULE_RULE_MARK/)
    assert.equal(allText(await post('read', 'src/module/sample.txt', { session: s })), '')
    now += 10 * 60_000
    assert.match(allText(await post('read', 'src/module/sample.txt', { session: s })), /MODULE_RULE_MARK/)
  } finally {
    Date.now = originalNow
  }
})

test('handoff：根 AGENTS 无 compiled snapshot 时给正文并标明不完整', () => {
  put('AGENTS.md', rule('HANDOFF_ROOT_RULE', 'ROOT_RULE_BODY'))
  const md = buildHandoff(ws, {
    includeRules: true, includeBoulder: false, includePlan: false,
  })
  assert.match(md, /HANDOFF_ROOT_RULE/)
  assert.match(md, /ROOT_RULE_BODY/)
  assert.match(md, /不完整快照/)
})

test('handoff：知识职责导航 + 未自动收集声明 + 旧参数语义保留', () => {
  const md = buildHandoff(ws, {
    goal: 'QA 目标',
    nextSteps: ['只读校验 fixture'],
    includeRules: true,
    includeBoulder: false,
    includePlan: false,
  })
  assert.match(md, /Workspace.*omo-hooktest/, 'workspace path must be stated')
  assert.match(md, /知识职责|Knowledge map/, 'knowledge responsibility map must be present')
  assert.match(md, /AGENTS/, 'map must mention AGENTS as rules layer')
  assert.match(md, /docs/, 'map must mention docs as current-facts layer')
  assert.match(md, /\.agent-notes/, 'map must mention notes as rationale layer')
  assert.match(md, /不会自动收集|未自动收集|not auto-collected/i, 'must declare docs/notes are not auto-collected')
  assert.match(md, /QA 目标/, 'goal semantics preserved')
  assert.match(md, /只读校验 fixture/, 'next steps preserved')
  assert.ok(!md.includes('Boulder memory'), 'includeBoulder=false honored')
  // 无规则时 includeRules 的旧语义（提示可运行 scan）保持
  const empty = buildHandoff(mkws(), { includeRules: true, includeBoulder: false, includePlan: false })
  assert.ok(empty.includes('No compiled rules yet') || empty.includes('omo_rules scan'), 'legacy no-rules hint preserved')
})

test('诚实清单：write / omo_hashline_edit / bash 不触发规则注入', async () => {
  const s = { header: { cwd: ws } }
  for (const tool of ['write', 'omo_hashline_edit', 'bash']) {
    const decision = await post(tool, 'src/module/sample.txt', { session: s })
    assert.ok(!allText(decision).includes('[OMO RULES]'), `${tool} must not trigger rules injection`)
  }
})

test('brief 上下文与 hook 上下文同源：同一组合函数输出一致', async () => {
  const pkg = ruleContextForTargets(ws, ['src/module/sample.txt'])
  const brief = buildBrief(
    { name: 'librarian', title: 't', mission: 'm', must: [], category: 'quick' },
    'task', ['src/module/sample.txt'], {}, pkg.block,
  )
  assert.match(brief, /ROOT_RULE_MARK/)
  const decision = await post('read', 'src/module/sample.txt', { session: { header: { cwd: ws } } })
  assert.match(allText(decision), /ROOT_RULE_MARK/)
})
