/**
 * Background command monitor — tail a long-running command by running it in the
 * background and streaming its output into `.omo/monitor/<id>.log`.
 *
 * Faithful adaptation of oh-my-openagent's `monitor` feature: launch a
 * non-interactive command, then query its output tail with wrapped markers
 * (`[OMO MONITOR OUTPUT]`), and stop it when done.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { omoDir, ensureDir, writeJson, readJson, nowTs, isWithin } from './util.js'

export interface MonitorEntry {
  id: string
  command: string
  workdir: string
  startedAt: string
  running: boolean
  exitCode: number | null
  logFile: string
  pid?: number
}

export interface MonitorHandle {
  entry: MonitorEntry
  stop: () => void
}

interface MonitorStore {
  monitors: MonitorEntry[]
}

/** Cross-instance liveness probe: signal 0 tests process existence. */
function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class MonitorRegistry {
  private ws: string
  private running = new Map<string, { child: ReturnType<typeof spawn>; entry: MonitorEntry }>()

  constructor(ws: string) {
    this.ws = ws
    ensureDir(path.join(ws, '.omo', 'monitor'))
  }

  private storeFile(): string {
    return omoDir(this.ws, 'monitors.json')
  }

  private readStore(): MonitorStore {
    return readJson<MonitorStore>(this.storeFile()) ?? { monitors: [] }
  }

  private writeStore(store: MonitorStore): void {
    writeJson(this.storeFile(), store)
  }

  list(): MonitorEntry[] {
    const store = this.readStore()
    for (const m of store.monitors) {
      // live when this instance tracks the child OR the recorded pid still exists
      // (fresh instances - e.g. hooks - have an empty in-memory map)
      const live = this.running.has(m.id) || (m.running && pidAlive(m.pid))
      if (m.running !== live) m.running = live
    }
    return store.monitors
  }

  start(command: string, workdir: string, signal?: AbortSignal): MonitorEntry {
    const id = 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
    const dir = path.resolve(workdir || this.ws)
    const logFile = omoDir(this.ws, 'monitor', id + '.log')
    ensureDir(path.dirname(logFile))
    const entry: MonitorEntry = {
      id,
      command,
      workdir: dir,
      startedAt: nowTs(),
      running: true,
      exitCode: null,
      logFile,
    }
    const child = spawn('bash', ['-lc', command], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    entry.pid = child.pid
    const stream = fs.createWriteStream(logFile, { flags: 'a' })
    stream.write(`[${nowTs()}] $ ${command}\n`)
    child.stdout.on('data', (d) => stream.write(d))
    child.stderr.on('data', (d) => stream.write(d))
    this.running.set(id, { child, entry })
    const onAbort = (): void => { child.kill('SIGTERM') }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('close', (code) => {
      entry.exitCode = code
      entry.running = false
      stream.end(`[${nowTs()}] exit=${String(code)}\n`)
      this.running.delete(id)
      const store = this.readStore()
      const i = store.monitors.findIndex((m) => m.id === id)
      if (i >= 0) store.monitors[i] = entry
      this.writeStore(store)
    })
    const store = this.readStore()
    store.monitors.unshift(entry)
    this.writeStore(store)
    return entry
  }

  output(id: string, tail = 30): { entry: MonitorEntry | null; output: string } {
    const store = this.readStore()
    const entry = store.monitors.find((m) => m.id === id) ?? null
    if (!entry) return { entry: null, output: '' }
    let lines: string[]
    try {
      lines = fs.readFileSync(entry.logFile, 'utf8').split('\n')
    } catch {
      lines = []
    }
    const selected = lines.slice(-Math.max(1, tail))
    // OMO envelope marker for untrusted command output
    const output =
      '<<<[OMO MONITOR OUTPUT] id=' + id + ' running=' + String(entry.running) + '>>>\n' +
      selected.join('\n').slice(0, 4000) +
      '\n<<<[/OMO MONITOR OUTPUT]>>>'
    return { entry, output }
  }

  stop(id: string): MonitorEntry | null {
    const live = this.running.get(id)
    const store = this.readStore()
    const entry = store.monitors.find((m) => m.id === id) ?? null
    if (!entry) return null
    if (live) {
      live.child.kill('SIGTERM')
      // record stop state immediately even if close lags
      entry.running = false
    } else {
      entry.running = false
    }
    this.writeStore(store)
    return entry
  }

  /** Dispose all live child processes (called on plugin stop). */
  dispose(): void {
    for (const { child } of this.running.values()) {
      try {
        child.kill('SIGKILL')
      } catch { /* ignore */ }
    }
    this.running.clear()
  }
}
