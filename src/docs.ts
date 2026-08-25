/**
 * Docs bridge - OmO's context7 MCP ported as a native tool.
 *
 * context7 serves up-to-date official documentation for libraries. The public
 * API needs no key: GET /api/v1/search?query=... and GET /api/v1/{owner/repo}.
 * This module wraps those two calls with timeouts, size bounds, and an honest
 * degradation note (suggest web_search) when the network fails.
 *
 * Surface: the `omo_docs` tool.
 *   - search : find libraries by keyword -> [{id, title, description, trust}]
 *   - get    : fetch focused docs for one library id (owner/repo) + optional topic
 */

const CTX7_BASE = 'https://context7.com/api/v1'
const TIMEOUT_MS = 15_000

export interface DocsSearchHit {
  id: string
  title: string
  description: string
  trustScore?: number
  totalTokens?: number
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`context7 HTTP ${res.status}`)
  return res.json()
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`context7 HTTP ${res.status}`)
  return res.text()
}

export interface DocsResult {
  ok: boolean
  action: string
  query?: string
  library?: string
  results?: DocsSearchHit[]
  docs?: string
  note: string
}

/** Search libraries by keyword. */
export async function docsSearch(query: string, count = 5): Promise<DocsResult> {
  const q = query.trim()
  if (!q) return { ok: false, action: 'search', query: q, note: 'empty query' }
  try {
    const data = (await fetchJson(`${CTX7_BASE}/search?query=${encodeURIComponent(q)}&count=${Math.min(Math.max(count, 1), 10)}`)) as { results?: Array<Record<string, unknown>> }
    const results = (data.results ?? []).map((r) => ({
      id: String(r.id ?? ''),
      title: String(r.title ?? ''),
      description: String(r.description ?? '').slice(0, 200),
      trustScore: typeof r.trustScore === 'number' ? r.trustScore : undefined,
      totalTokens: typeof r.totalTokens === 'number' ? r.totalTokens : undefined,
    }))
    return { ok: true, action: 'search', query: q, results, note: `${results.length} hits` }
  } catch (e) {
    return { ok: false, action: 'search', query: q, note: `context7 unreachable (${String(e)}); fall back to web_search` }
  }
}

/** Fetch focused docs for one library (owner/repo form) with an optional topic. */
export async function docsGet(library: string, topic: string, tokens: number): Promise<DocsResult> {
  const lib = library.trim().replace(/^\/+/, '')
  if (!/^[\w.-]+\/[\w.-]+/.test(lib)) {
    return { ok: false, action: 'get', library: lib, note: 'library must be owner/repo form (use action=search first)' }
  }
  const tok = Math.min(Math.max(tokens || 4000, 500), 12000)
  const url = `${CTX7_BASE}/${lib}?tokens=${tok}${topic ? `&topic=${encodeURIComponent(topic.trim())}` : ''}`
  try {
    const docs = await fetchText(url)
    return { ok: true, action: 'get', library: lib, docs: docs.slice(0, 60_000), note: `${docs.length} chars${topic ? ` (topic: ${topic.trim()})` : ''}` }
  } catch (e) {
    return { ok: false, action: 'get', library: lib, note: `context7 unreachable (${String(e)}); fall back to web_search` }
  }
}
