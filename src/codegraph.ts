/**
 * Codegraph — thin wrapper over the (pre-existing) CodeGraph CLI.
 *
 * OmO ships a `codegraph` CLI (knowledge graph over the codebase) exposed as
 * `codegraph_node` / `codegraph_explore` MCP tools. This module wraps the
 * self-contained install at `~/.omo/codegraph/bin/codegraph` (or PATH) and
 * exposes status / query / node / explore / paths — using the already-built
 * indexes when the workspace is indexed, and reporting honestly when it is not.
 */

import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { runShell } from './cmd.js'

export interface CodegraphResult {
  ok: boolean
  action: string
  backend: string
  note: string
  output: string
  projects?: string[]
}

/** Resolve the codegraph CLI: ~/.omo/codegraph/bin/codegraph, else PATH. */
export function codegraphCli(): string | null {
  const omo = path.join(homedir(), '.omo', 'codegraph', 'bin', 'codegraph')
  if (fs.existsSync(omo)) return omo
  try {
    execFileSync('codegraph', ['--version'], { stdio: 'ignore' })
    return 'codegraph'
  } catch {
    return null
  }
}

/** List indexed projects from the central projects store. */
export function codegraphProjects(): string[] {
  const root = path.join(homedir(), '.omo', 'codegraph', 'projects')
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Run a codegraph command against the given workspace.
 * actions: status | query | node | explore (symbol required for query/node/explore).
 */
export async function runCodegraph(
  ws: string,
  action: string,
  symbol = '',
  opts: { limit?: number } = {},
): Promise<CodegraphResult> {
  const cli = codegraphCli()
  if (!cli) {
    return { ok: false, action, backend: 'none', note: 'codegraph CLI not found (~/.omo/codegraph/bin/codegraph or PATH)', output: '' }
  }
  const limit = opts.limit ?? 3000
  if (action === 'paths') {
    return { ok: true, action, backend: 'codegraph', note: '', output: '', projects: codegraphProjects() }
  }
  const safeSymbol = symbol.replace(/[^A-Za-z0-9_.:\\-]/g, '')
  const cmd =
    action === 'status'
      ? `cd ${shquote(ws)} && ${shquote(cli)} status 2>&1`
      : `cd ${shquote(ws)} && ${shquote(cli)} ${shquote(action)} ${safeSymbol ? shquote(safeSymbol) : ''} 2>&1`
  const r = await runShell(cmd, { cwd: ws, timeoutMs: 30000 })
  const output = (r.ok ? r.stdout : r.stdout || r.stderr).slice(0, limit)
  const joined = (r.stdout + ' ' + r.stderr).slice(0, 400)
  const notIndexed = /not indexed|no index|does not exist|\.codegraph[^ ]*missing/i.test(joined)
  return {
    ok: r.ok || notIndexed,
    action,
    backend: 'codegraph',
    note: notIndexed ? 'workspace not indexed — run `codegraph init` in the project to build the index' : '',
    output,
  }
}

function shquote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`
}
