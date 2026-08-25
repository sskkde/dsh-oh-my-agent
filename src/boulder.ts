/**
 * Boulder notepad — persistent cross-task memory.
 *
 * Faithful adaptation of oh-my-openagent's boulder-state: a durable, plain
 * JSON + rendered markdown store of accumulated wisdom that survives across
 * tasks and sessions. An agent records learnings/decisions/issues/
 * verifications/problems while working; a later session reads them and avoids
 * re-discovering what is already known.
 */

import fs from 'node:fs'
import path from 'node:path'
import { omoDir, ensureDir, writeState, writeJson, readJson, nowTs, OMO_DIR } from './util.js'

export const SECTIONS = ['learnings', 'decisions', 'issues', 'verifications', 'problems'] as const
export type Section = (typeof SECTIONS)[number]

export interface Note {
  id: number
  ts: string
  content: string
  status?: string
}

export interface PlanProgress {
  planId: string
  name: string
  total: number
  completed: number
  status: 'active' | 'complete'
}

export interface BoulderState {
  version: number
  thread: string
  sections: Record<Section, Note[]>
  createdAt: string
  updatedAt: string
  /** Active ultrawork/start-work plan (the cross-session resume watermark). */
  activePlan?: PlanProgress
}

export const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s)

export function emptyBoulder(thread = ''): BoulderState {
  const sections = {} as Record<Section, Note[]>
  for (const s of SECTIONS) sections[s] = []
  return { version: 1, thread: thread || 'default', sections, createdAt: nowTs(), updatedAt: nowTs() }
}

export function boulderPath(ws: string): string {
  return omoDir(ws, 'boulder.json')
}

export function loadBoulder(ws: string): BoulderState {
  const loaded = readJson<BoulderState>(boulderPath(ws))
  if (loaded && loaded.version === 1 && loaded.sections && loaded.thread) {
    for (const s of SECTIONS) if (!loaded.sections[s]) loaded.sections[s] = []
    return loaded
  }
  return emptyBoulder()
}

export function saveBoulder(ws: string, state: BoulderState): void {
  state.updatedAt = nowTs()
  writeJson(boulderPath(ws), state)
  renderNotepad(ws, state)
}

/** Record the active plan watermark (used by omo_ultrawork / start-work RESUME). */
export function setActivePlan(ws: string, plan: PlanProgress): BoulderState {
  const state = loadBoulder(ws)
  state.activePlan = plan
  saveBoulder(ws, state)
  return state
}

/** Mark plan completion (progress.completed = total, status = complete). */
export function markPlanComplete(ws: string): BoulderState | null {
  const state = loadBoulder(ws)
  if (!state.activePlan) return null
  state.activePlan.completed = state.activePlan.total
  state.activePlan.status = 'complete'
  saveBoulder(ws, state)
  return state
}

/** Advance the completed counter of the active plan. */
export function bumpPlanProgress(ws: string, completed: number): BoulderState | null {
  const state = loadBoulder(ws)
  if (!state.activePlan) return null
  state.activePlan.completed = Math.max(0, Math.min(completed, state.activePlan.total))
  if (state.activePlan.completed >= state.activePlan.total) state.activePlan.status = 'complete'
  saveBoulder(ws, state)
  return state
}

/** Human-friendly notepad.md mirror (one per thread). */
export function renderNotepad(ws: string, state: BoulderState): void {
  const file = omoDir(ws, 'notepad.md')
  const lines: string[] = []
  lines.push(`# Boulder Notepad — thread "${state.thread}"`)
  lines.push(`> Persistent cross-task memory (last updated ${state.updatedAt})`)
  lines.push('')
  if (state.activePlan && state.activePlan.total > 0) {
    lines.push(`## Active plan — ${state.activePlan.name} [${state.activePlan.status}]`)
    lines.push(`> ${state.activePlan.completed}/${state.activePlan.total} tasks done (id ${state.activePlan.planId}); resume in a new session with the start-work skill.`)
    lines.push('')
  }
  for (const s of SECTIONS) {
    const notes = state.sections[s]
    if (notes.length === 0) continue
    lines.push(`## ${s[0].toUpperCase() + s.slice(1)}`)
    for (const n of notes) {
      const status = n.status ? `\`${n.status}\` ` : ''
      lines.push(`- ${status}#${n.id} (${n.ts.slice(0, 10)}): ${n.content.replace(/\n/g, ' ')}`)
    }
    lines.push('')
  }
  if (SECTIONS.every((s) => state.sections[s].length === 0)) {
    lines.push('_No notes yet — record learnings as you work._')
  }
  ensureDir(path.join(ws, OMO_DIR))
  writeState(file, lines.join('\n'))
}

export interface NoteResult {
  section: Section
  count: number
  notes: Note[]
  message: string
}

export function listNotes(ws: string, section: Section): NoteResult {
  const state = loadBoulder(ws)
  const notes = state.sections[section]
  return { section, count: notes.length, notes: [...notes].reverse().slice(0, 20), message: '' }
}

export function appendNote(ws: string, section: Section, content: string, status?: string): NoteResult {
  const state = loadBoulder(ws)
  const notes = state.sections[section]
  const id = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1
  notes.push(status !== undefined ? { id, ts: nowTs(), content, status } : { id, ts: nowTs(), content })
  saveBoulder(ws, state)
  return { section, count: notes.length, notes: notes.slice(-5).reverse(), message: `#${id} appended to ${section}` }
}

export function updateNote(ws: string, section: Section, id: number, status?: string, content?: string): NoteResult {
  const state = loadBoulder(ws)
  const notes = state.sections[section]
  const note = notes.find((n) => n.id === id)
  if (!note) return { section, count: notes.length, notes: notes.slice(-3).reverse(), message: `note #${id} not found in ${section}` }
  if (status !== undefined) note.status = status
  if (content !== undefined && content.trim()) note.content = content
  note.ts = nowTs()
  saveBoulder(ws, state)
  return { section, count: notes.length, notes: notes.slice(-3).reverse(), message: `#${id} updated` }
}

export function newThreadBoulder(ws: string, title = ''): NoteResult {
  const state = emptyBoulder(title || ('thread-' + Date.now().toString(36)))
  saveBoulder(ws, state)
  return { section: 'learnings', count: 0, notes: [], message: `new boulder thread "${state.thread}"` }
}

export function checkpointBoulder(ws: string): { file: string; message: string } {
  const state = loadBoulder(ws)
  const out = omoDir(ws, 'checkpoints', 'checkpoint-' + Date.now().toString(36) + '.md')
  ensureDir(path.dirname(out))
  const body: string[] = []
  body.push(`# Checkpoint — thread "${state.thread}" @ ${state.updatedAt}`)
  body.push('')
  for (const s of SECTIONS) {
    const notes = state.sections[s]
    if (!notes.length) continue
    body.push(`## ${s[0].toUpperCase() + s.slice(1)}`)
    for (const n of notes) body.push(`- #${n.id} ${n.content.replace(/\n/g, ' ')}`)
    body.push('')
  }
  writeState(out, body.join('\n'))
  return { file: out, message: `checkpoint written: ${out}` }
}

/** Summarize the boulder for a prompt injection (e.g. handoff / status). */
export function boulderSummary(ws: string): { markdown: string; counts: Record<Section, number> } {
  const state = loadBoulder(ws)
  const counts = {} as Record<Section, number>
  for (const s of SECTIONS) counts[s] = state.sections[s].length
  const lines: string[] = [`Boulder "${state.thread}" (updated ${state.updatedAt})`]
  if (state.activePlan) lines.push(`- activePlan: ${state.activePlan.name} ${state.activePlan.completed}/${state.activePlan.total} [${state.activePlan.status}]`)
  for (const s of SECTIONS) {
    const notes = state.sections[s].slice(-3)
    if (notes.length) {
      lines.push(`- ${s}: ${notes.map((n) => `#${n.id} ${n.content.slice(0, 60)}`).join(' | ')}`)
    }
  }
  return { markdown: lines.join('\n'), counts }
}
