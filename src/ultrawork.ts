/**
 * ultrawork — the flagship discipline workflow, ported from oh-my-openagent.
 *
 * In OmO, "ultrawork" is a keyword-triggered protocol injected into the
 * orchestrator's prompt: classify intent → build a plan → delegate in parallel
 * waves by CATEGORY (not by model name) → verify with diagnostics → deliver.
 *
 * DSH mapping: the calling agent does the real subagent delegation with its
 * native subagent tools (subagent_default/deep/plugin...). This module provides
 * the conductor: a durable plan store (`.omo/work/<ts>/plan.md` + plan.json),
 * the phase state machine, the category→tool mapping table, and the playbook
 * text the agent should follow. `omo_ultrawork` advances/reads that state.
 */

import fs from 'node:fs'
import path from 'node:path'
import { omoDir, ensureDir, writeJson, readJson, writeState, nowTs } from './util.js'
import { setActivePlan, bumpPlanProgress, markPlanComplete } from './boulder.js'

export type UltraPhase = 'plan' | 'explore' | 'waves' | 'verify' | 'deliver'

export interface Wave {
  name: string
  /** DSH-flavored category: ultrabrain | deep | quick | visual | writing | unspecified-high | unspecified-low */
  category: string
  goal: string
  files: string[]
  dependsOn?: string[]
  /** Resolved model route for this wave's category (advisory brain selection). */
  model?: { provider: string; model: string; reasoning: string }
}

export interface UltraPlan {
  id: string
  goal: string
  createdAt: string
  phase: UltraPhase
  waves: Wave[]
  verification: string[]
  dir: string
}

/** Map OmO category → the DSH subagent tool / flavor to delegate with. */
export const CATEGORY_TO_DSH: Record<string, string> = {
  ultrabrain: 'subagent_oracle (or subagent_deep) — hardest reasoning',
  deep: 'subagent_deep — deep reasoning',
  quick: 'subagent_default — fast, bounded',
  visual: 'subagent_default with describe_image — visual/engineering review',
  writing: 'subagent_default — prose/docs',
  'unspecified-high': 'subagent_deep',
  'unspecified-low': 'subagent_default',
}

export function readUltraPlan(ws: string): UltraPlan | null {
  return readJson<UltraPlan>(omoDir(ws, 'work', 'latest.json'))
}

export function createUltraPlan(ws: string, goal: string, waves: Wave[], verification: string[]): UltraPlan {
  const id = 'uw-' + Date.now().toString(36)
  const dir = omoDir(ws, 'work', id)
  ensureDir(dir)
  const plan: UltraPlan = { id, goal, createdAt: nowTs(), phase: 'plan', waves, verification, dir }
  writeJson(omoDir(ws, 'work', 'latest.json'), plan)
  renderPlanMarkdown(ws, plan)
  // boulder watermark: the cross-session RESUME pointer (start-work mode)
  setActivePlan(ws, { planId: id, name: slug(goal) || id, total: Math.max(plan.waves.length, 1), completed: 0, status: 'active' })
  // .omo/plans/<name>.md synced copy (Prometheus WritePlan convention)
  try {
    const plansDir = omoDir(ws, 'plans')
    ensureDir(plansDir)
    writeState(joinPlan(plansDir, plan.id + '.md'), headerPlanMarkdown(plan))
  } catch { /* best-effort */ }
  return plan
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').slice(0, 40) || 'plan'
}

function joinPlan(dir: string, name: string): string {
  return path.join(dir, name)
}

function headerPlanMarkdown(plan: UltraPlan): string {
  const lines: string[] = [
    `# Plan ${plan.id} — ${plan.goal}`,
    '',
    `created ${plan.createdAt} · phase ${plan.phase}`,
    '',
  ]
  for (let i = 0; i < plan.waves.length; i++) {
    const w = plan.waves[i]
    lines.push(`- [ ] **${i + 1}. ${w.name}** [${w.category}] — ${w.goal}${w.files.length ? ' (' + w.files.join(', ') + ')' : ''}`)
  }
  lines.push('')
  for (const v of plan.verification) lines.push(`- [ ] verify: ${v}`)
  return lines.join('\n')
}

export function updateUltraPhase(ws: string, phase: UltraPhase): UltraPlan | null {
  const plan = readUltraPlan(ws)
  if (!plan) return null
  plan.phase = phase
  if (phase === 'deliver') { try { markPlanComplete(ws) } catch { /* boulder optional */ } }
  writeJson(omoDir(ws, 'work', 'latest.json'), plan)
  renderPlanMarkdown(ws, plan)
  return plan
}

/** Record how many waves have been completed (for the boulder RESUME progress). */
export function recordWaveProgress(ws: string, completed: number): void {
  try { bumpPlanProgress(ws, completed) } catch { /* optional */ }
}

function renderPlanMarkdown(ws: string, plan: UltraPlan): void {
  const file = path.join(plan.dir, 'plan.md')
  const lines: string[] = [
    `# Ultrawork Plan — ${plan.id}`,
    '',
    `**Goal:** ${plan.goal}`,
    `**Created:** ${plan.createdAt}  **Phase:** ${plan.phase}`,
    '',
    '## Waves',
    ...plan.waves.map((w, i) => {
      const deps = w.dependsOn?.length ? `  (depends on: ${w.dependsOn.join(', ')})` : ''
      return `- ${i + 1}. **${w.name}** [${w.category}] → ${CATEGORY_TO_DSH[w.category] ?? w.category}${deps}\n  task: ${w.goal}\n  files: ${w.files.join(', ') || '(scan codebase)'}${w.model ? '\n  model: ' + w.model.provider + '/' + w.model.model + ' (' + w.model.reasoning + ')' : ''}`
    }),
    '',
    '## Verification',
    ...plan.verification.map((v) => `- ${v}`),
    '',
  ]
  writeState(file, lines.join('\n'))
}

/** The protocol content block rendered for the current phase. */
export function ultraworkPhaseText(ws: string): { phase: UltraPhase; markdown: string; plan: UltraPlan | null } {
  const plan = readUltraPlan(ws)
  if (!plan) {
    return {
      phase: 'plan',
      markdown: [
        '# ultrawork — Phase 0: Plan',
        '',
        'No active ultrawork plan. Create one, then follow the protocol:',
        '',
        '1. **Explore the codebase** (read/grep/glob the workspace).',
        '2. **Write waves** — split independent work into parallel waves, each with a name, a category, a task, and touched files.',
        '3. **Verify** — list the diagnostics to run before declaring done.',
        '4. Call `omo_ultrawork` again (or have the model execute the playbook) to move into `waves`.',
        '',
        'Use the `omo-ultrawork` skill for the full protocol.',
      ].join('\n'),
      plan: null,
    }
  }
  const blocks: Record<UltraPhase, string[]> = {
    plan: [
      `# ultrawork — Phase: Plan (${plan.id})`,
      '',
      `**Goal:** ${plan.goal}`,
      '',
      'Plan is stored at `.omo/work/plan.md`. Next: **explore** the codebase to ground the waves.',
      '',
    ],
    explore: [
      `# ultrawork — Phase: Explore`,
      '',
      `**Goal:** ${plan.goal}`,
      '',
      'Before implementing, ground yourself:',
      '- Read the relevant entry points with the `read`/`glob`/`grep` tools.',
      '- Note conventions discovered; log them to boulder (`omo_note`) so later waves reuse them.',
      '- Confirm each wave target file exists or will be created.',
      '',
      'Then advance to `waves` and start delegating.',
    ],
    waves: [
      `# ultrawork — Phase: Waves (parallel delegation)`,
      '',
      `**Goal:** ${plan.goal}`,
      '',
      'Delegate each wave with a native subagent tool per its category:',
      ...plan.waves.map((w, i) => `- Wave ${i + 1} **${w.name}** (${w.category}) → use ${CATEGORY_TO_DSH[w.category] ?? w.category}.${w.model ? ' Brain: ' + w.model.provider + '/' + w.model.model + ' (' + w.model.reasoning + ').' : ''} Task: ${w.goal}${w.files.length ? ` Files: ${w.files.join(', ')}` : ''}.`),
      '',
      '- Independent waves: run them **in parallel** (fire all subagent calls in one message).',
      '- Dependent waves (dependsOn): run only after their dependencies report back.',
      '- Each subagent brief must include STOP WHEN / EVIDENCE / MUST NOT DO (delegation protocol).',
      '- Collect results, fix integration issues, then advance to `verify`.',
    ],
    verify: [
      `# ultrawork — Phase: Verify`,
      '',
      `**Goal:** ${plan.goal}`,
      '',
      'Run the verification steps before delivery:',
      ...plan.verification.map((v) => `- ${v}`),
      '',
      '- Fix failures from the verification run, then re-run.',
      '- Run `omo_comment_check` to catch leftover TODO/FIXME markers.',
      '- Record a checkpoint via `omo_note checkpoint` when green.',
      '- Then advance to `deliver`.',
    ],
    deliver: [
      `# ultrawork — Phase: Deliver`,
      '',
      `**Goal:** ${plan.goal}`,
      '',
      '- Summarize what changed (files + behavior).',
      '- Record learnings to boulder (`omo_note`).',
      '- Produce a `omo_handoff` so a fresh session can continue.',
      '- Report completion to the user with evidence.',
      '',
      'Mark the plan complete in `.omo/work/latest.json` (phase=deliver) and stop.',
    ],
  }
  return { phase: plan.phase, markdown: blocks[plan.phase].join('\n'), plan }
}
