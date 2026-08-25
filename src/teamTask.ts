/**
 * TeamMode shared task table — the file-backed collaboration queue every agent
 * can read/write (port of oh-my-openagent's shared task table).
 */

import { omoDir, readJson, writeJson } from './util.js'

export interface TaskRow {
  id: string
  title: string
  assignee: string
  status: 'backlog' | 'todo' | 'running' | 'done' | 'failed' | 'cancelled' | string
  ts: string
  summary: string
}

export function teamStorePath(ws: string): string {
  return omoDir(ws, 'team', 'tasks.json')
}

export function loadTasks(ws: string): TaskRow[] {
  return readJson<TaskRow[]>(teamStorePath(ws)) ?? []
}

export function saveTasks(ws: string, tasks: TaskRow[]): void {
  writeJson(teamStorePath(ws), tasks)
}
