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
import { RulesIndex } from './rules.js'
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
    } else {
      lines.push('_No compiled rules yet — run `omo_rules scan`._')
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
