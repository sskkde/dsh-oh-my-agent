/**
 * Model category → fallback-chain resolution — faithful port of OmO's
 * model-core category routing.
 *
 * A category is a semantic intent (ultrabrain/deep/quick/visual/writing/
 * unspecified-high/unspecified-low/artistry). Delegation picks the CATEGORY,
 * never a model name; this module resolves that category to an ordered
 * fallback chain of {provider, model, reasoning} routes.
 *
 * Resolution priority (low → high):
 *   1. built-in default chain (grounded on the models this DSH deployment
 *      actually exposes: deepseek/deepseek-v4-pro + deepseek-v4-flash)
 *   2. omo.jsonc layered config: [opencode].categories.<name>.model
 *      (.models / .fallback_models / .reasoning), plus the shared
 *      [opencode].models short-name map
 *   3. explicit caller overrides (model / provider / reasoning args)
 *
 * Reasoning levels are normalized (off|minimal|low|medium|high|xhigh|max|auto).
 *
 * Honest boundary: this is the *routing decision* the orchestrator uses to
 * pick the brain for a wave. DSH's actual wire-up for a live session follows
 * agent-default-model; the resolved route is advisory guidance embedded into
 * delegation briefs (and config can override defaults).
 */

export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto'

export const REASONING_LEVELS: ReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']

export const CATEGORIES = [
  'ultrabrain', 'deep', 'visual', 'writing',
  'quick', 'unspecified-high', 'unspecified-low', 'artistry',
] as const
export type Category = (typeof CATEGORIES)[number]

export const isCategory = (s: string): s is Category => (CATEGORIES as readonly string[]).includes(s)

export interface RouteOption {
  provider: string
  model: string
  reasoning: ReasoningLevel
  note?: string
}

/** Normalize an arbitrary reasoning hint to a known level. */
export function normalizeReasoning(v: unknown): ReasoningLevel {
  if (typeof v === 'string') {
    const low = v.toLowerCase()
    if ((REASONING_LEVELS as readonly string[]).includes(low)) return low as ReasoningLevel
    if (low === 'none') return 'off'
    if (low === 'zero') return 'off'
    if (low === 'ultra' || low === 'extreme') return 'max'
    if (low.startsWith('no') || low.startsWith('non')) return 'off'
  }
  if (typeof v === 'number') {
    if (v <= 0) return 'off'
    if (v < 0.25) return 'low'
    if (v < 0.5) return 'medium'
    if (v < 0.75) return 'high'
    if (v < 1) return 'xhigh'
    return 'max'
  }
  return 'medium'
}

/** Real models exposed by this deployment's deepseek route. */
const PRO = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: 'high' } as const
const PRO_X = { provider: 'deepseek', model: 'deepseek-v4-pro', reasoning: 'xhigh' } as const
const FLASH = { provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: 'low' } as const
const FLASH_M = { provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: 'medium' } as const

/** Built-in category → fallback chain (OmO semantics mapped onto this deploy's models). */
export const DEFAULT_CHAINS: Record<Category, RouteOption[]> = {
  ultrabrain: [PRO_X, PRO, { provider: 'deepseek', model: 'deepseek-v4-flash', reasoning: 'max' }],
  deep: [PRO, PRO_X, FLASH_M],
  visual: [FLASH_M, FLASH], // no dedicated vision route here — honest note
  writing: [FLASH_M, FLASH],
  quick: [FLASH, FLASH_M],
  'unspecified-high': [PRO, FLASH_M],
  'unspecified-low': [FLASH],
  artistry: [FLASH_M, PRO],
}

/** Per-category role hint for the catalog / playbooks. */
export const CATEGORY_ROLES: Record<Category, string> = {
  ultrabrain: '最难推理/架构决策（深推理，最高 effort）',
  deep: '深度推理/复杂调试（重脑力）',
  visual: '视觉/前端工程（无专用视觉路由，用默认）',
  writing: '文档/文案（轻量）',
  quick: '快速/bounded 任务（低延迟）',
  'unspecified-high': '不确定但偏重',
  'unspecified-low': '不确定但轻量',
  artistry: '创意/审美',
}

export interface ResolveInput {
  category: string
  model?: string      // explicit override: 'deepseek-v4-pro' or 'provider/model'
  provider?: string
  reasoning?: unknown
  mergedConfig?: Record<string, unknown>
}

export interface RouteDecision {
  ok: boolean
  category: Category | null
  chosen: RouteOption | null
  chain: RouteOption[]
  source: string
  note: string
  catalog: Array<{ category: Category; role: string; default: RouteOption; fallbackCount: number }>
}

/** Parse a model spec value (string 'm' | 'provider/m' | {provider,model,reasoning}). */
function parseModelSpec(v: unknown): RouteOption | null {
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return null
    const parts = s.split('/')
    if (parts.length === 2) return { provider: parts[0].trim(), model: parts[1].trim(), reasoning: 'medium' }
    return { provider: 'deepseek', model: s, reasoning: 'medium' }
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    const model = typeof o.model === 'string' ? o.model.trim() : ''
    if (!model) return null
    return {
      provider: typeof o.provider === 'string' ? o.provider.trim() : 'deepseek',
      model,
      reasoning: normalizeReasoning(o.reasoning),
    }
  }
  return null
}

/** Read the per-category config override from the merged omo.jsonc. */
export function configForCategory(merged: Record<string, unknown>, category: string): {
  chosen: RouteOption | null
  fallbacks: RouteOption[]
  reasoning: ReasoningLevel | null
} {
  const oc = ((merged.opencode ?? merged['[opencode]']) ?? {}) as Record<string, unknown>
  const cats = oc.categories ?? {}
  const models = oc.models ?? {}
  const c = (isPlain(cats) ? cats[category] : undefined) as Record<string, unknown> | undefined
  const chosen: RouteOption | null = c ? parseModelSpec(c.model ?? c.models) : null
  let fallbacks: RouteOption[] = []
  if (c && Array.isArray(c.fallback_models)) fallbacks = (c.fallback_models as unknown[]).map(parseModelSpec).filter((x): x is RouteOption => x !== null)
  let reasoning: ReasoningLevel | null = null
  if (c && c.reasoning !== undefined) reasoning = normalizeReasoning(c.reasoning)
  if (!chosen && isPlain(models)) {
    // shared model map: short name in [opencode].models — category config may reference a name
    if (typeof c?.model === 'string' && isPlain(models) && isPlain((models as Record<string, unknown>)[c.model])) {
      const m = parseModelSpec((models as Record<string, unknown>)[c.model])
      if (m) { m.provider = m.provider || 'deepseek'; return { chosen: m, fallbacks, reasoning } }
    }
  }
  return { chosen, fallbacks, reasoning }
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function catalogOf(merged: Record<string, unknown>, overrides?: { model?: string; reasoning?: unknown }): RouteDecision['catalog'] {
  return CATEGORIES.map((cat) => {
    const cfg = configForCategory(merged, cat)
    const chosen = resolveOne(merged, cat, overrides)
    return {
      category: cat,
      role: CATEGORY_ROLES[cat],
      default: chosen,
      fallbackCount: cfg.fallbacks.length || DEFAULT_CHAINS[cat].length - 1,
    }
  })
}

function resolveOne(
  merged: Record<string, unknown>,
  cat: Category,
  overrides?: { model?: string; provider?: string; reasoning?: unknown },
): RouteOption {
  const cfg = configForCategory(merged, cat)
  const chain = [cfg.chosen, ...cfg.fallbacks].filter((x): x is RouteOption => x !== null)
  let defaultChain = DEFAULT_CHAINS[cat]
  // explicit override > config > builtin
  if (overrides?.model) {
    const m = parseModelSpec(overrides.model)
    if (m) return { ...m, provider: overrides.provider || m.provider, reasoning: overrides.reasoning !== undefined ? normalizeReasoning(overrides.reasoning) : (cfg.reasoning ?? m.reasoning) }
  }
  let chosen: RouteOption | null = null
  if (chain.length > 0) chosen = chain[0]
  else chosen = defaultChain[0]
  chosen = { ...chosen }
  if (cfg.reasoning) chosen.reasoning = cfg.reasoning
  else if (overrides?.reasoning !== undefined) chosen.reasoning = normalizeReasoning(overrides.reasoning)
  if (overrides?.provider) chosen.provider = overrides.provider
  return chosen
}

/**
 * Resolve a category to its routing decision with a full fallback chain and
 * source trace. `merged` is the layered omo.jsonc merge (see omoconfig.ts).
 */
export function resolveCategory(input: ResolveInput): RouteDecision {
  const merged = input.mergedConfig ?? {}
  const note: string[] = []
  if (input.reasoning !== undefined && typeof input.reasoning === 'string' && !(REASONING_LEVELS as readonly string[]).includes(input.reasoning.toLowerCase())) {
    note.push(`reasoning "${input.reasoning}" normalized to a supported level`)
  }
  if (!isCategory(input.category)) {
    return {
      ok: false,
      category: null,
      chosen: null,
      chain: [],
      source: 'none',
      note: `unknown category "${input.category}" — valid: ${CATEGORIES.join(', ')}`,
      catalog: catalogOf(merged, { model: input.model, reasoning: input.reasoning }),
    }
  }
  const cfg = configForCategory(merged, input.category)
  let source = 'builtin-default'
  if (input.model) source = 'explicit'
  else if (cfg.chosen || cfg.fallbacks.length) source = 'config'
  const chosen = resolveOne(merged, input.category, { model: input.model, provider: input.provider, reasoning: input.reasoning })
  const chain = [chosen, ...DEFAULT_CHAINS[input.category].filter((r) => !(r.provider === chosen.provider && r.model === chosen.model))]
  note.push('DSH 会话实发路由跟随 agent-default-model；此路线为委托选脑决策（可经 omo.jsonc [opencode].categories 覆盖）')
  return {
    ok: true,
    category: input.category,
    chosen,
    chain: chain.slice(0, 5),
    source,
    note: note.join('; '),
    catalog: catalogOf(merged, { model: input.model, reasoning: input.reasoning }),
  }
}

/** Short display for a route option. */
export function routeLabel(r: RouteOption): string {
  return `${r.provider}/${r.model} (${r.reasoning})`
}
