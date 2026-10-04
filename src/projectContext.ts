/**
 * projectContext — bounded, traceable rule-context composition.
 *
 * One pure composer serves every channel that attaches project rules:
 *   - rules-injector hook (post-execute, successful read / edit)
 *   - delegation briefs (omo_agents brief + delegate_as files targets)
 *
 * Contract (docs/subsystems/rule-loading.md):
 *   - targets are normalized against the workspace trust boundary; out-of-bounds
 *     targets contribute nothing; an empty target list degrades to root/standing
 *     rules only (never descendant inference)
 *   - rule bodies are deduped across targets; every entry carries source,
 *     scope and applicable targets — local blocks stay grouped per target and
 *     are never promoted to task-global rules
 *   - ordering: standing/global rules first, then ancestors root → deep
 *   - budget (default 2500 chars, header + source list included): entries are
 *     included WHOLE or omitted whole — never cut mid-body. Omitted entries
 *     surface a contextIncomplete notice with their sources; if even the source
 *     list does not fit, degrade to a minimal notice + `omo_rules action=path`
 *     guidance instead of pretending completeness
 *   - the delivery fingerprint (hash) covers ALL applicable entries including
 *     omitted ones, so a change in a budget-omitted rule still re-delivers
 */

import { applicableRulesFor, scanRules, resolveTargetWithinWs, type RuleFile, type RuleChannel } from './rules.js'
import { sha256 } from './util.js'

/** Budget in characters (mirrors the existing rules-injector cap; no public config). */
export const RULE_CONTEXT_BUDGET = 2500

export interface RuleContextEntry {
  /** Rule display name (frontmatter description or first heading). */
  name: string
  /** Workspace-relative rule file paths contributing this body (deduped). */
  sources: string[]
  /** Directory scope (subtree only) when the rule is a sub AGENTS.md. */
  scopeDir: string | null
  alwaysApply: boolean
  /** Normalized target paths this entry applies to. */
  targets: string[]
  content: string
}

export interface RuleContextPackage {
  ws: string
  /** Normalized, deduped target paths actually used (order preserved). */
  targets: string[]
  /** All applicable entries (deduped, ordered) — including budget-omitted ones. */
  entries: RuleContextEntry[]
  included: RuleContextEntry[]
  omitted: RuleContextEntry[]
  /** False when any applicable rule did not fit the budget. */
  complete: boolean
  /** The composed prompt block (≤ budget when non-empty; '' when nothing applies). */
  block: string
  /** Delivery fingerprint over ALL applicable entries (omitted included). */
  hash: string
}

export interface RuleContextOptions {
  /** Character budget; defaults to RULE_CONTEXT_BUDGET (no public config). */
  budget?: number
  /** Injection channel for rule filtering (file channel by default). */
  channel?: RuleChannel
  /** Header override; defaults to the standard localized banner. */
  header?: string
}

const FIXED_GUIDANCE = '也可用 omo_rules action=path path=<目标> 查询适用规则，行动前先 read 原文。'
const MIN_INCOMPLETE = '[contextIncomplete] 部分规则超预算未装入——不要当作完整加载；用 omo_rules action=path 查询，行动前先 read 原文。'

/** Render one entry as a complete markdown chunk (header lines + full body). */
function entryText(e: RuleContextEntry): string {
  const lines: string[] = []
  lines.push(`### ${e.name}`)
  lines.push(`> source: ${e.sources.join(', ')}`)
  if (e.scopeDir) lines.push(`> scope: ${e.scopeDir}/（仅目录子树）`)
  if (e.targets.length) lines.push(`> applies to: ${e.targets.join(', ')}`)
  lines.push('')
  lines.push(e.content)
  return lines.join('\n')
}

/**
 * Compose the bounded rule context for a set of targets. Pure with respect to
 * the filesystem state: every call re-resolves rules (no TTL cache), so rule
 * edits are visible on the very next composition.
 */
export function ruleContextForTargets(
  ws: string,
  targets: readonly string[],
  opts: RuleContextOptions = {},
): RuleContextPackage {
  const empty: RuleContextPackage = { ws, targets: [], entries: [], included: [], omitted: [], complete: true, block: '', hash: sha256('') }
  if (!ws) return empty
  const budget = Math.max(64, Math.floor(opts.budget ?? RULE_CONTEXT_BUDGET))
  const channel: RuleChannel = opts.channel ?? 'file'

  // Normalize targets against the trust boundary; skip out-of-bounds ones.
  const rels: string[] = []
  for (const t of targets) {
    const r = resolveTargetWithinWs(ws, t)
    if (!r) continue
    if (!rels.includes(r.rel)) rels.push(r.rel)
  }
  // No usable target (none given / all invalid) → root + standing rules only.
  const effective = rels.length > 0 ? rels : ['']

  const all = scanRules(ws)
  const union = new Map<string, RuleFile>()
  const targetsByFile = new Map<string, string[]>()
  for (const rel of effective) {
    const { rules } = applicableRulesFor(ws, all, rel, channel)
    for (const r of rules) {
      union.set(r.file, r)
      const list = targetsByFile.get(r.file) ?? []
      if (!list.includes(rel)) list.push(rel)
      targetsByFile.set(r.file, list)
    }
  }

  // Order: unscoped (global/standing/glob) rules first, then directory-scoped
  // ancestors root → deep; layer priority breaks ties inside each group.
  const depthOf = (r: RuleFile): number => r.scopeDir ? r.scopeDir.split('/').filter(Boolean).length : 0
  const sorted = [...union.values()].sort((a, b) =>
    ((a.scopeDir ? 1 : 0) - (b.scopeDir ? 1 : 0)) || (depthOf(a) - depthOf(b)) || (a.priority - b.priority),
  )

  // Keep each source/scope/target association intact. A rule matched across
  // several requested targets is already unioned by file above; collapsing
  // distinct files by body would falsely widen local scopes and target labels.
  const entries: RuleContextEntry[] = []
  const entryByFile = new Map<string, RuleContextEntry>()
  for (const r of sorted) {
    const e: RuleContextEntry = {
      name: r.name,
      sources: [r.relPath],
      scopeDir: r.scopeDir,
      alwaysApply: r.alwaysApply,
      targets: [],
      content: r.content,
    }
    entries.push(e)
    entryByFile.set(r.file, e)
  }
  for (const [file, list] of targetsByFile) {
    const e = entryByFile.get(file)
    if (!e) continue
    for (const rel of list) if (!e.targets.includes(rel)) e.targets.push(rel)
  }

  if (entries.length === 0) return { ...empty, targets: rels, hash: hashOf([], { ws, targets: rels, budget, header: opts.header ?? `[OMO RULES] ${rels.length > 0 ? `适用于 ${rels.join(', ')}` : '项目常设规则'}（遵守；局部要求不得放宽根级约束）`, channel }) }

  // Budgeted composition: whole entries in, whole entries out. `used` tracks
  // the exact joined length so far (a separator precedes every appended line).
  const header = opts.header ??
    `[OMO RULES] ${rels.length > 0 ? `适用于 ${rels.join(', ')}` : '项目常设规则'}（遵守；局部要求不得放宽根级约束）`
  let used = header.length
  const lines: string[] = [header]
  const included: RuleContextEntry[] = []
  let omitted: RuleContextEntry[] = []
  for (const e of entries) {
    const t = entryText(e)
    if (used + 1 + t.length <= budget) {
      lines.push(t)
      used += 1 + t.length
      included.push(e)
    } else {
      omitted.push(e)
    }
  }

  // Incomplete states are always explicit; never cut a body to fake completeness.
  if (omitted.length > 0) {
    const noticeFor = (list: RuleContextEntry[]): string => {
      const items = list.map((e) => `- ${e.sources.join(', ')}${e.targets.length ? `（${e.targets.join(', ')}）` : ''}`)
      return `[contextIncomplete] 已达 ${budget} 字符预算，以下 ${list.length} 条规则未装入，行动前先 read 原文：\n${items.join('\n')}\n${FIXED_GUIDANCE}`
    }
    // Degrade gracefully: full list → minimal notice (no list), dropping whole
    // included entries only if even the minimal notice cannot fit.
    let notice = noticeFor(omitted)
    while (used + 1 + notice.length > budget && included.length > 0) {
      const last = included.pop()!
      lines.pop()
      used -= 1 + entryText(last).length
      omitted = [last, ...omitted]
      notice = noticeFor(omitted)
    }
    if (used + 1 + notice.length <= budget) {
      lines.push(notice)
      used += 1 + notice.length
    } else if (used + 1 + MIN_INCOMPLETE.length <= budget) {
      lines.push(MIN_INCOMPLETE)
      used += 1 + MIN_INCOMPLETE.length
    } else {
      // Budget nearly exhausted by the header itself: fall back to a minimal
      // block that still states the incompleteness honestly.
      const fallback = `${header.slice(0, Math.max(0, budget - MIN_INCOMPLETE.length - 2))}\n${MIN_INCOMPLETE}`.slice(0, budget)
      return { ws, targets: rels, entries, included: [], omitted: entries, complete: false, block: fallback, hash: hashOf(entries, { ws, targets: rels, budget, header, channel }) }
    }
  }

  const block = lines.join('\n')
  return {
    ws,
    targets: rels,
    entries,
    included,
    omitted,
    complete: omitted.length === 0,
    block,
    hash: hashOf(entries, { ws, targets: rels, budget, header, channel }),
  }
}

/** Delivery fingerprint: complete entry semantics plus composition/display inputs. */
function hashOf(
  entries: RuleContextEntry[],
  composition: { ws: string; targets: string[]; budget: number; header: string; channel: RuleChannel },
): string {
  return sha256(JSON.stringify({
    ...composition,
    entries: entries.map((e) => ({
      name: e.name,
      sources: e.sources,
      scopeDir: e.scopeDir,
      alwaysApply: e.alwaysApply,
      targets: e.targets,
      content: e.content,
    })),
  }))
}
