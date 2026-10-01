/**
 * dsh-oh-my-agent — client half (OmO 控制台卡片).
 *
 * Registers a self-contained console card as a tab in the `settings.plugins.tab`
 * settings slot. The card polls the host API (/dsh-oh-my-agent/api/*) and
 * shows plugin health: registered tools, compiled rules, boulder memory,
 * background monitors — with refresh / scan-rules / append-note actions.
 *
 * Deliberately dependency-light: no settings form machinery, plain
 * createElement (no JSX), and every failure degrades to a quiet placeholder.
 */

import { createElement, useEffect, useRef, useState } from 'react'

/** Local React type surface; react stays an external at runtime. */
type ClientContext = {
  effect: (fn: () => () => void, tag?: string) => () => void
  remote: {
    commands: { execute: (sessionId: string, command: string, args: unknown[]) => Promise<unknown> }
  }
  slots: {
    inject: (slot: string, fn: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
}

export const inject = ['slots']

/** Host status payload (mirrors src/index.ts apiStatus). */
interface OmOStatus {
  plugin?: string
  workspace?: string
  tools?: string[]
  ts?: string
  rules?: { total?: number; alwaysApply?: number; files?: string[] }
  boulder?: { counts?: Record<string, number>; thread?: string }
  monitors?: Array<{ id: string; command: string; running: boolean; exitCode: number | null }>
  sections?: string[]
}

/** Host model-routes payload (mirrors src/index.ts apiModelRoutes). */
interface ModelRoutesView {
  ok?: boolean
  ts?: string
  roles?: Array<{
    name: string
    title: string
    category: string
    channel: string
    tier: string
    readOnly: boolean
    resolution: { provider: string; model: string; source: string }
  }>
  categories?: Array<{ name: string; role: string; chosen: string; source: string; fallbackCount: number }>
  available?: string[]
  providers?: Array<{ provider: string; credentialEnv?: string; count: number; models: string[] }>
  providerFailures?: string[]
  roleOverrides?: Record<string, { value: string | null; file: string }>
  categoryOverrides?: Record<string, { value: string | null; file: string }>
  files?: Array<{ scope: string; path: string; existed: boolean }>
}

/** Tiny fetch wrapper with a timeout. */
function apiGet(path: string, timeoutMs = 8000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    fetch(path, { signal: ctrl.signal })
      .then((r) => {
        if (!r.ok) throw new Error(path + ' -> HTTP ' + r.status)
        return r.json()
      })
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer))
  })
}

function apiPost(path: string, body: unknown): Promise<unknown> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())
}

const SECONDS = 12

/** The OmO console card rendered in the plugin-configuration section. */
export function OmOConsoleCard(_props: Record<string, unknown>): unknown {
  const [status, setStatus] = useState<OmOStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [noteSection, setNoteSection] = useState('learnings')
  const [noteMsg, setNoteMsg] = useState('')
  const [modelRoutes, setModelRoutes] = useState<ModelRoutesView | null>(null)
  const [routeEdits, setRouteEdits] = useState<Record<string, string>>({})
  const [catEdits, setCatEdits] = useState<Record<string, string>>({})
  const [routeScope, setRouteScope] = useState<'user' | 'workspace'>('user')
  const [routeBusy, setRouteBusy] = useState(false)
  const [routeMsg, setRouteMsg] = useState('')
  const [routeError, setRouteError] = useState('')
  /** 用户已动手编辑过（轮询刷新 metadata 时不得覆盖正在输入的 edits）。
   * 用 ref 存——轮询闭包捕获的是初始 render 的 state，ref 保证读到最新值。 */
  const [editsDirty, setEditsDirty] = useState(false)
  const editsDirtyRef = useRef(false)
  const markDirty = (): void => { editsDirtyRef.current = true; setEditsDirty(true) }

  const refresh = (): void => {
    setBusy(true)
    apiGet('/dsh-oh-my-agent/api/status')
      .then((s) => setStatus(s as OmOStatus))
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false))
  }
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, SECONDS * 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onScan = (): void => {
    setBusy(true)
    apiGet('/dsh-oh-my-agent/api/scan')
      .then(() => refresh())
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false))
  }

  const onAppend = (): void => {
    if (!noteText.trim()) return
    setBusy(true)
    apiPost('/dsh-oh-my-agent/api/note', { section: noteSection, content: noteText })
      .then((r) => {
        setNoteMsg(String((r as { message?: string })?.message ?? 'saved'))
        setNoteText('')
        refresh()
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false))
  }

  /** 模型路由视图：可选「仅刷新 metadata（available/providers/settings）」不动编辑态。 */
  const applyRoutesView = (v: ModelRoutesView, resetEdits: boolean): void => {
    setModelRoutes(v)
    if (!resetEdits && editsDirtyRef.current) return
    const ro: Record<string, string> = {}
    for (const [k, o] of Object.entries(v.roleOverrides ?? {})) ro[k] = o?.value ?? ''
    const co: Record<string, string> = {}
    for (const [k, o] of Object.entries(v.categoryOverrides ?? {})) co[k] = o?.value ?? ''
    setRouteEdits(ro)
    setCatEdits(co)
  }

  const loadRoutes = (resetEdits = true): void => {
    apiGet('/dsh-oh-my-agent/api/modelroutes')
      .then((r) => applyRoutesView(r as ModelRoutesView, resetEdits))
      .catch((e) => setRouteError(String((e as Error)?.message ?? e)))
  }
  useEffect(() => {
    loadRoutes()
    const timer = setInterval(() => loadRoutes(false), 15000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSaveRoutes = (): void => {
    setRouteBusy(true)
    setRouteError('')
    apiPost('/dsh-oh-my-agent/api/modelroutes', { scope: routeScope, roles: routeEdits, categories: catEdits })
      .then((r) => {
        const rr = r as { ok?: boolean; message?: string }
        setRouteMsg(String(rr.message ?? (rr.ok ? '已保存' : '保存失败')))
        if (!rr.ok) setRouteError(String(rr.message ?? '保存失败'))
        editsDirtyRef.current = false
        setEditsDirty(false)
        loadRoutes(true)
      })
      .catch((e) => setRouteError(String((e as Error)?.message ?? e)))
      .finally(() => setRouteBusy(false))
  }

  const tools = status?.tools ?? []
  const rules = status?.rules ?? {}
  const counts = status?.boulder?.counts ?? {}
  const monitors = status?.monitors ?? []

  return createElement(
    'div',
    { style: { padding: '14px 16px', fontFamily: 'var(--dsw-font-family, inherit)' } },
    createElement('h3', { style: { margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: 'var(--dsw-alias-label-primary)' } },
      'OmO 控制台'),
    createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 10 } },
      `${status?.plugin ?? 'dsh-oh-my-agent'} — oh-my-openagent 核心功能复刻${status?.ts ? '  更新于 ' + status.ts : ''}`),

    error
      ? createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', margin: '6px 0' } }, '接口错误: ' + error)
      : null,

    createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
      `工作区: ${status?.workspace ?? '—'}`),

    // rule stats
    createElement('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 } },
      createElement('div', { style: label }, `rules: ${String(rules.total ?? 0)} 条（alwaysApply ${String(rules.alwaysApply ?? 0)}）`),
      createElement('div', { style: label }, `boulder: ${JSON.stringify(counts)}`),
      createElement('div', { style: label }, `monitors: ${String(monitors.length)}`)),

    // tools list
    createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 } },
      'tools: ' + tools.join(', ')),

    // rules files (recent)
    (status?.rules?.files?.length ?? 0) > 0
      ? createElement('details', { style: { marginBottom: 8 } },
          createElement('summary', { style: { fontSize: 12, cursor: 'pointer' } }, '已扫描规则文件'),
          createElement('div', { style: { fontSize: 11, padding: '6px 0 0 8px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'pre-wrap' } },
            (status?.rules?.files ?? []).slice(0, 15).join('\n')))
      : null,

    // monitors
    monitors.length
      ? createElement('details', { style: { marginBottom: 8 } },
          createElement('summary', { style: { fontSize: 12, cursor: 'pointer' } }, '后台监控'),
          createElement('div', { style: { fontSize: 11, padding: '6px 0 0 8px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'pre-wrap' } },
            monitors.map((m) => `${m.id} ${m.running ? '运行中' : 'exit ' + String(m.exitCode)}  $ ${m.command.slice(0, 60)}`).join('\n')))
      : null,

    // actions
    createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 } },
      createElement('button', { onClick: refresh, disabled: busy, style: btnSecondary }, busy ? '…' : '刷新'),
      createElement('button', { onClick: onScan, disabled: busy, style: btnSecondary }, '扫描规则重编译')),

    // ── 子代理模型设置 ──
    createElement('div', { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--dsw-alias-border-l2)' } },
      createElement('div', { style: { fontSize: 13, fontWeight: 700, color: 'var(--dsw-alias-label-primary)', marginBottom: 2 } }, '子代理模型路由'),
      createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 8 } },
        '设置页写入独立覆盖层（优先级最高），手写的 ~/.omo/omo.jsonc 保持不变'),
      // 作用域 + 托管层状态
      createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 } },
        createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '写入作用域:'),
        createElement(
          'select',
          {
            value: routeScope,
            onChange: (e: { target: { value: string } }) => { setRouteScope(e.target.value === 'workspace' ? 'workspace' : 'user'); loadRoutes() },
            style: select,
          },
          createElement('option', { value: 'user' }, '用户层 ~/.omo/model-routes.jsonc'),
          createElement('option', { value: 'workspace' }, '工作区 .omo/model-routes.jsonc'),
        ),
        createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
          (modelRoutes?.files ?? []).map((f) => (f.scope === 'user' ? '用户层' : '工作区') + (f.existed ? '：已存在' : '：未创建')).join(' · '))),
      // 候选模型说明：动态取自已注册 provider 的模型目录（配 provider 变化自动同步）
      createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 6 } },
        `候选模型动态取自已配置 provider 目录：${(modelRoutes?.providers ?? []).map((p) => `${p.provider}×${p.count}`).join(' · ') || '无'}${(modelRoutes?.providerFailures?.length ?? 0) ? '（部分 provider 查询失败: ' + modelRoutes!.providerFailures!.join('; ') + '）' : ''}`),
      // 候选模型 datalist
      createElement('datalist', { id: 'omo-route-suggest' },
        (modelRoutes?.available ?? []).map((s) => createElement('option', { key: s, value: s }))),
      // 角色路由行
      createElement('div', { style: { marginBottom: 6 } },
        createElement('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 } }, '角色路由（delegate_roles）'),
        (modelRoutes?.roles ?? []).map((r) => {
          const resolved = r.resolution?.provider ? `${r.resolution.provider}/${r.resolution.model}` : '—'
          return createElement('div', { key: r.name, style: routeRow },
            createElement('div', { style: { flex: 1, minWidth: 110 } },
              createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, r.title),
              createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
                `${r.name} · ${r.resolution?.source ?? ''}`)),
            createElement('span', { style: label }, r.category),
            createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', flex: 1, minWidth: 110 } },
              `${resolved}${r.readOnly ? '（只读）' : ''}`),
            createElement('input', {
              list: 'omo-route-suggest',
              value: routeEdits[r.name] ?? '',
              placeholder: '自动（默认路由）',
              onChange: (e: { target: { value: string } }) => { markDirty(); setRouteEdits({ ...routeEdits, [r.name]: e.target.value }) },
              style: routeInput,
            }),
            createElement('button', { onClick: () => { markDirty(); setRouteEdits({ ...routeEdits, [r.name]: '' }) }, style: btnSecondary }, '清除'))
        })),
      // 分类决策层 <details>
      createElement('details', { style: { marginBottom: 8 } },
        createElement('summary', { style: { fontSize: 12, cursor: 'pointer' } }, '分类决策层（categories，收起）'),
        createElement('div', { style: { marginTop: 4 } },
          (modelRoutes?.categories ?? []).map((c) =>
            createElement('div', { key: c.name, style: routeRow },
              createElement('div', { style: { flex: 1, minWidth: 110 } },
                createElement('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } }, c.name),
                createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, c.role)),
              createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', flex: 1, minWidth: 110 } },
                `${c.chosen || '—'} · ${c.source}`),
              createElement('input', {
                list: 'omo-route-suggest',
                value: catEdits[c.name] ?? '',
                placeholder: '自动（默认路由）',
                onChange: (e: { target: { value: string } }) => { markDirty(); setCatEdits({ ...catEdits, [c.name]: e.target.value }) },
                style: routeInput,
              }),
              createElement('button', { onClick: () => { markDirty(); setCatEdits({ ...catEdits, [c.name]: '' }) }, style: btnSecondary }, '清除'))))),
      // 保存
      createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        createElement('button', { onClick: onSaveRoutes, disabled: routeBusy, style: btnPrimary }, routeBusy ? '保存中…' : '保存覆盖'),
        routeMsg ? createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-success-primary)' } }, routeMsg) : null,
        routeError ? createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)' } }, '保存失败: ' + routeError) : null)),

    // append note
    createElement('div', { style: { display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap' } },
      createElement(
        'select',
        { value: noteSection, onChange: (e: { target: { value: string } }) => setNoteSection(e.target.value), style: select },
        (status?.sections ?? ['learnings', 'decisions', 'issues', 'verifications', 'problems']).map((s: string) => createElement('option', { key: s, value: s }, s)),
      ),
      createElement(
        'input',
        { value: noteText, onChange: (e: { target: { value: string } }) => setNoteText(e.target.value), placeholder: '记录一条 boulder 经验…', style: input },
      ),
      createElement('button', { onClick: onAppend, disabled: busy || !noteText.trim(), style: btnPrimary }, '追加'),
    ),
    noteMsg ? createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-state-success-primary)', marginTop: 4 } }, noteMsg) : null,
  )
}

const label: Record<string, string | number> = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-interactive-bg-hover)',
  padding: '2px 8px',
  borderRadius: 999,
}

const btnBase: Record<string, string | number> = {
  fontSize: 12,
  cursor: 'pointer',
  borderRadius: 8,
  padding: '5px 12px',
}

const btnSecondary: Record<string, string | number> = {
  ...btnBase,
  color: 'var(--dsw-alias-label-primary)',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'transparent',
}

const btnPrimary: Record<string, string | number> = {
  ...btnBase,
  color: 'var(--dsw-alias-label-primary-foreground)',
  border: 'none',
  background: 'var(--dsw-alias-button-info-fill)',
}

const input: Record<string, string | number> = {
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-specific-input-major)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: 12,
  flex: 1,
  minWidth: 140,
}

const select: Record<string, string | number> = {
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-specific-input-major)',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '6px 8px',
  fontSize: 12,
}

const routeRow: Record<string, string | number> = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  flexWrap: 'wrap',
  padding: '4px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

const routeInput: Record<string, string | number> = {
  ...input,
  flex: '0 1 220px',
  minWidth: 150,
  padding: '4px 8px',
}

type SessionMode = 'off' | 'prometheus' | 'atlas'
type ModeSelectProps = {
  sessionId?: string
  select?: (mode: 'off' | 'plan' | 'exec') => Promise<unknown>
  useProjection?: (key: string) => unknown
}

/** Compact composer mode selector; unavailable projection means read-only fallback. */
export function ModeSelect(props: ModeSelectProps): unknown {
  const [writeError, setWriteError] = useState('')
  const projectionHook = props.useProjection
  let projection: { mode?: SessionMode } | undefined
  let projectionFailed = !projectionHook
  if (projectionHook) {
    try {
      projection = projectionHook('omo-session-mode') as { mode?: SessionMode } | undefined
    } catch {
      projectionFailed = true
    }
  }
  const mode = projection?.mode
  const knownMode = mode === 'off' || mode === 'prometheus' || mode === 'atlas'
  if (projectionFailed || !knownMode) {
    return createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }, title: '会话模式投影不可用' }, '会话模式不可用')
  }

  const onChange = (event: { target: { value: string } }): void => {
    const selected = event.target.value
    if (!props.sessionId || !props.select || (selected !== 'off' && selected !== 'plan' && selected !== 'exec')) return
    setWriteError('')
    void Promise.resolve().then(() => props.select!(selected)).catch((error: unknown) => {
      setWriteError(String((error as Error)?.message ?? error))
    })
  }

  const selectedMode = mode === 'prometheus' ? 'plan' : mode === 'atlas' ? 'exec' : 'off'
  return createElement('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 5 } },
    createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, '会话模式'),
    createElement('select', { value: selectedMode, onChange, disabled: !props.sessionId || !props.select, style: select, title: writeError || undefined }, 
      createElement('option', { value: 'off' }, 'off'),
      createElement('option', { value: 'plan' }, '计划态'),
      createElement('option', { value: 'exec' }, '执行态')),
    writeError ? createElement('span', { role: 'status', style: { fontSize: 10, color: 'var(--dsw-alias-state-error-primary)' } }, '切换失败') : null)
}

/** Mount the console card and composer mode selector. */
export function apply(ctx: ClientContext): void {
  if (!ctx.slots) return
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    const consoleDisposer = ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'dsh-oh-my-agent',
      order: 120,
      label: () => 'OmO 控制台',
      inject: () => ({}),
    }, OmOConsoleCard))
    if (typeof consoleDisposer === 'function') disposers.push(consoleDisposer as () => void)

    const modeDisposer = ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
      name: 'conversation.input.left',
      id: 'dsh-oh-my-agent:mode',
      order: 10,
      inject: (sessionId: string) => ({
        sessionId,
        select: (mode: 'off' | 'plan' | 'exec') => ctx.remote.commands.execute(sessionId, '/omo-mode ' + mode, []),
      }),
    }, ModeSelect))
    if (typeof modeDisposer === 'function') disposers.push(modeDisposer as () => void)
    if (disposers.length) return () => { for (const dispose of disposers) dispose() }
    return () => {}
  }, 'dsh-oh-my-agent: console card')
}
