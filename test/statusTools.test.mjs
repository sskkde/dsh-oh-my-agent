/**
 * 状态面工具清单 单测（对编译产物 lib/index.js 运行）：
 *   node --test test/statusTools.test.mjs
 * 覆盖缺陷报告 omo-two-bugs.md BUG-1 / BUG-1b：
 *   - omo_status 的 tools 必须是「本次实际注册」的清单，禁用工具不得出现
 *   - 禁用 ≥3 个工具时（旧实现的 `length - 2` 数量启发式会失效）不得回退全量
 *   - client 状态面板数据源 /dsh-oh-my-agent/api/status 与工具清单一致
 * 约定：loadUserConfig() 只读 $HOME/.omo/omo.jsonc，故用临时 HOME 注入禁用配置，
 *       不触碰真实用户配置。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, buildTools } from '../lib/index.js'

const tempDirs = []
/** 全量工具数（22 个 omo_* + delegate_as）——按源码 buildTools() 现算，避免文档口径漂移。 */
const TOTAL = buildTools({}).length
let ws = ''
let prevHome = ''

function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

beforeEach(() => {
  prevHome = process.env.HOME ?? ''
  ws = mktmp('omo-status-ws-')
})

afterEach(() => {
  if (prevHome) process.env.HOME = prevHome
  else delete process.env.HOME
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** 把 HOME 指向临时目录，并写入用户层禁用清单。 */
function useHome(disabledTools) {
  const home = mktmp('omo-status-home-')
  fs.mkdirSync(path.join(home, '.omo'), { recursive: true })
  fs.writeFileSync(path.join(home, '.omo', 'omo.jsonc'), JSON.stringify({ opencode: { disabled_tools: disabledTools } }))
  process.env.HOME = home
}

/** 最小 ctx：捕获注册的工具与 HTTP 路由（照 test/rulesHooks.test.mjs 的桩扩一路由）。 */
function mount() {
  const registered = new Map()
  const routes = []
  const disposers = []
  const ctx = {
    inject: (_deps, callback) => callback({}),
    effect: (callback) => { const d = callback(); if (typeof d === 'function') disposers.push(d) },
    get: () => undefined,
    tools: { register: (def) => registered.set(def.name, def), guard: () => () => {} },
    skills: { register: () => () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    on: () => () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, {
    defaultWorkspace: ws, workspaceHints: [], delegateProvider: 'spawn',
    delegateFlashRoute: 'f/x', delegateHeavyRoute: 'h/y', mainPrompt: 'off',
    customPromptSection: '', goalGuardOn: false,
  })
  return { registered, routes, disposers }
}

/** 经 omo_status 工具取回工具清单。 */
async function toolsViaTool(registered) {
  const def = registered.get('omo_status')
  assert.ok(def, 'omo_status 必须已注册')
  const out = await def.execute({}, { signal: new AbortController().signal, agent: { session: { header: { cwd: ws } } } })
  return out.tools
}

/** 经 /dsh-oh-my-agent/api/status 路由取回 payload（客户端面板数据源）。 */
function statusViaHttp(routes) {
  const route = routes.find((r) => r.path === '/dsh-oh-my-agent/api/status')
  assert.ok(route, 'status 路由必须已注册')
  let body = ''
  route.handler({ url: '/' }, { writeHead: () => {}, end: (b) => { body = b } })
  return JSON.parse(body)
}

test('omo_status 的 tools 等于实际注册清单，禁用的 3 项不出现（BUG-1 + BUG-1b）', async () => {
  const disabled = ['omo_note', 'omo_memory', 'omo_docs']
  useHome(disabled)
  const { registered, routes } = mount()

  const actual = [...registered.keys()]
  for (const n of disabled) assert.ok(!actual.includes(n), `${n} 被禁用后不得注册`)

  // 旧实现的数量启发式阈值 = total - 2；禁用 3 项后 total-3 < total-2，必然踩中回退分支
  assert.equal(actual.length, TOTAL - disabled.length, `禁用 ${disabled.length} 项后应注册 ${TOTAL - disabled.length} 项`)

  const viaTool = await toolsViaTool(registered)
  assert.deepEqual(viaTool, actual, 'omo_status.tools 必须是实际注册清单（顺序一致）')
  for (const n of disabled) assert.ok(!viaTool.includes(n), `omo_status 不得再报出被禁用的 ${n}`)

  const viaHttp = statusViaHttp(routes)
  assert.deepEqual(viaHttp.tools, actual, '状态面板数据源必须与实际注册清单一致')
})

test('未禁用时 omo_status 报出全量已注册工具', async () => {
  useHome([])
  const { registered } = mount()
  const actual = [...registered.keys()]
  assert.equal(actual.length, TOTAL, `默认注册 ${TOTAL} 项`)
  assert.deepEqual(await toolsViaTool(registered), actual)
})
