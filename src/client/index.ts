/**
 * dsh-oh-my-agent — client half (OmO 控制台卡片).
 *
 * Registers a self-contained console card into the `settings.plugin.item`
 * settings slot. The card polls the host API (/dsh-oh-my-agent/api/*) and
 * shows plugin health: registered tools, compiled rules, boulder memory,
 * background monitors — with refresh / scan-rules / append-note actions.
 *
 * Deliberately dependency-light: no settings form machinery, plain
 * createElement (no JSX), and every failure degrades to a quiet placeholder.
 */

import { createElement, useEffect, useState } from 'react'

/** Local React type surface; react stays an external at runtime. */
type ClientContext = {
  effect: (fn: () => () => void, tag?: string) => () => void
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

/** Mount the console card. */
export function apply(ctx: ClientContext): void {
  if (!ctx.slots) return
  ctx.effect(() => {
    const disposer = ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'dsh-oh-my-agent',
      order: 120,
      inject: () => ({}),
    }, OmOConsoleCard))
    if (typeof disposer === 'function') return () => (disposer as () => void)()
    return () => {}
  }, 'dsh-oh-my-agent: console card')
}
