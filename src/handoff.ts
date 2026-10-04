/**
 * handoff — produce a context summary for a fresh session to continue.
 *
 * Faithful adaptation of oh-my-openagent's `/handoff` command: gather the
 * workspace state (compiled rules, boulder notepad, monitors, plan) into one
 * self-contained markdown block a new session can be seeded with.
 */

import path from 'node:path'
import fs from 'node:fs'
import { boulderSummary, type Section } from './boulder.js'
import { omoDir, readJson } from './util.js'
import { RulesIndex, scanRules, compileRules } from './rules.js'
import type { UltraPlan } from './ultrawork.js'

export interface HandoffInput {
  goal?: string
  nextSteps?: string[]
  includeBoulder: boolean
  includePlan: boolean
  includeRules: boolean
  conversation?: string
}

export function buildHandoff(ws: string, input: HandoffInput): string {
  const lines: string[] = []
  lines.push('# Handoff — session continuation context')
  lines.push('')
  lines.push(`- **Workspace:** ${ws}`)
  lines.push(`- **Generated:** ${new Date().toISOString()}`)
  lines.push('')

  // Knowledge responsibility map (docs/project-knowledge.md): one authoritative
  // body per knowledge kind. This handoff never auto-collects docs/notes prose
  // — the receiver reads them on demand via the AGENTS navigation.
  lines.push('## Knowledge map（知识职责——每类知识一个权威正文）')
  lines.push('- 行动规则：`AGENTS.md` / 规则文件（根级=常设；子目录 AGENTS 只适用其目录子树）。')
  lines.push('- 现行事实：`docs/`（architecture / subsystems / cookbook，按需建）。')
  lines.push('- 决策因果：`.agent-notes/notes/<topic>.md`（`learnings.md` 是短索引）。')
  lines.push('- 任务工件：`.omo/` 按类别保留批准计划、人工记忆、任务状态与验收证据；compiled rules / 索引是可重建派生物，不得整体当作可删缓存。')
  lines.push('')
  lines.push('> **声明**：本交接**不会自动收集** docs/ 与 notes 的正文——按 AGENTS 里的导航按需 `read`。')
  lines.push('')

  if (input.goal) {
    lines.push('## Goal')
    lines.push(`> ${input.goal}`)
    lines.push('')
  }

  if (input.conversation) {
    lines.push('## Conversation summary')
    lines.push(`> ${input.conversation}`)
    lines.push('')
  }

  if (input.includeRules) {
    lines.push('## Rules (compiled)')
    const idxPath = omoDir(ws, 'rules', 'index.json')
    const idx = readJson<RulesIndex>(idxPath)
    const compiledPath = omoDir(ws, 'rules', 'compiled.md')
    if (idx && fs.existsSync(compiledPath)) {
      const body = fs.readFileSync(compiledPath, 'utf8').slice(0, 2000)
      lines.push(body || '_no compiled rules_')
      lines.push('')
      lines.push('> 以上为编译块快照（截断至 2000 字符），不保证完整；完整适用规则用 `omo_rules action=path path=<目标>` 查询。')
    } else {
      const rootRules = scanRules(ws).filter((r) =>
        !r.scopeDir && ['AGENTS.md', 'CLAUDE.md'].includes(r.relPath),
      )
      if (rootRules.length) {
        lines.push(compileRules(rootRules))
        lines.push('')
        lines.push('> **不完整快照**：没有 compiled rules；以上仅为当前根级 AGENTS/CLAUDE 导航与正文。完整适用规则用 `omo_rules action=path path=<目标>` 查询。')
      } else {
        lines.push('_No compiled rules or root AGENTS.md/CLAUDE.md found — run `omo_rules scan`._')
      }
    }
    lines.push('')
  }

  if (input.includeBoulder) {
    const { markdown } = boulderSummary(ws)
    lines.push('## Boulder memory')
    lines.push(markdown || '_empty_')
    lines.push('')
  }

  if (input.includePlan) {
    const plan = readJson<UltraPlan>(omoDir(ws, 'work', 'latest.json'))
    if (plan) {
      lines.push('## Active ultrawork plan')
      lines.push(`- id=${plan.id} phase=${plan.phase}`)
      lines.push(`- goal: ${plan.goal}`)
      lines.push(`- waves: ${(plan.waves ?? []).map((w) => w.name).join(', ') || '(none)'}`)
      lines.push('')
    } else {
      lines.push('## Active ultrawork plan') // placeholder kept off
      lines.pop()
    }
  }

  if (input.nextSteps?.length) {
    lines.push('## Suggested next steps')
    for (const s of input.nextSteps) lines.push(`- ${s}`)
    lines.push('')
  }

  lines.push('---')
  lines.push('_Continue working on the above. Update boulder with new learnings._')
  return lines.join('\n')
}
