/**
 * Dynamic SKILL.md loader - OmO's custom-skill surface ported to DSH.
 *
 * OmO users drop `.opencode/skills/<name>/SKILL.md` (and we also honor the
 * plugin's own `.omo/` convention) to extend the agent with new skills at
 * runtime. DSH's `ctx.skills.register()` accepts runtime skills and is
 * idempotent (same-name registrations are ignored), so this module scans the
 * SKILL.md files, parses a light frontmatter (name? / description [required] /
 * whenToUse?), and registers each as a runtime skill.
 *
 * Surface: the `omo_skills` tool (scan = discover + register; list = what the
 * plugin registered this process).
 */

import fs from 'node:fs'
import path from 'node:path'

export interface DynSkill {
  name: string
  description: string
  whenToUse?: string
  file: string
  content: string
  status: 'registered' | 'skipped' | 'invalid'
  reason?: string
}

/** Light frontmatter parse: leading `---` fence, `key: value` lines. */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } | null {
  if (!raw.startsWith('---')) return null
  const nl = raw.indexOf('\n')
  if (nl < 0) return null
  const close = raw.indexOf('\n---', nl)
  if (close < 0) return null
  const fm: Record<string, string> = {}
  for (const line of raw.slice(nl + 1, close).split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (m) fm[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  const body = raw.slice(close + 4).replace(/^\n+/, '')
  return { fm, body }
}

/** Scan one workspace's OmO-convention skill directories. */
export function scanSkillFiles(ws: string): DynSkill[] {
  const roots = [path.join(ws, '.opencode', 'skills'), path.join(ws, '.omo', 'skills')]
  const out: DynSkill[] = []
  for (const root of roots) {
    let dirs: string[] = []
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      continue
    }
    for (const dir of dirs) {
      const file = path.join(root, dir, 'SKILL.md')
      let raw = ''
      try {
        raw = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const parsed = parseFrontmatter(raw)
      const name = (parsed?.fm.name ?? dir).trim()
      const description = (parsed?.fm.description ?? '').trim()
      const whenToUse = (parsed?.fm.whenToUse ?? parsed?.fm.when_to_use ?? '').trim()
      const content = parsed ? parsed.body : raw
      const entry: DynSkill = {
        name,
        description,
        whenToUse: whenToUse || undefined,
        file: path.relative(ws, file),
        content,
        status: 'invalid',
      }
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        entry.reason = `invalid skill name "${name}" (A-Za-z0-9._- only)`
      } else if (!description) {
        entry.reason = 'frontmatter description is required'
      } else {
        entry.status = 'registered'
      }
      out.push(entry)
    }
  }
  return out
}

/** Names registered by this loader this process (for list + skip-on-rescan). */
const registeredNames = new Set<string>()

/**
 * Scan + register. `register` is `ctx.skills.register` (idempotent on
 * same names; DSH ignores duplicates with a warning).
 */
export function registerSkills(
  ws: string,
  register: (d: { name: string; description: string; whenToUse?: string; invocation?: { modelInvocable: boolean; userInvocable: boolean }; source: string; content: string }) => unknown,
): DynSkill[] {
  const found = scanSkillFiles(ws)
  for (const s of found) {
    if (s.status !== 'registered') continue
    if (registeredNames.has(s.name)) {
      s.status = 'skipped'
      s.reason = 'already registered this process'
      continue
    }
    register({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'runtime',
      content: s.content,
    })
    registeredNames.add(s.name)
  }
  return found
}

/** What this loader registered this process. */
export function listRegistered(): string[] {
  return [...registeredNames]
}
