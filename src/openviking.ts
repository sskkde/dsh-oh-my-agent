import { randomUUID } from 'node:crypto'
import { parseFrontmatter } from './rules.js'

export interface OpenVikingConfig {
  memoryBackend: 'local' | 'openviking'
  openvikingProjectId: string
  openvikingUserScope: boolean
  openvikingToolPrefix: string
  openvikingWriteWait: boolean
}
export interface OpenVikingExec {
  signal: AbortSignal
  agent?: unknown
  callId?: string
  rootCallId?: string
  token?: unknown
}
export interface ToolFailure { message: string; info?: unknown }
type OpenVikingContentBlock = { type: string; text?: string }
export type OpenVikingResult = {
  isError: false
  value?: { content?: OpenVikingContentBlock[]; structuredContent?: unknown }
  /** Final model-facing projection; post-execute policies may replace it independently of value. */
  content: OpenVikingContentBlock[]
} | {
  isError: true
  error: ToolFailure
  content: OpenVikingContentBlock[]
  value?: never
}
export interface OpenVikingRuntime {
  execute(input: { callId: string; name: string; arguments: Record<string, unknown>; signal: AbortSignal; agent?: unknown; rootCallId?: string; parent?: unknown }): Promise<OpenVikingResult>
}
const OPS = new Set(['read', 'list', 'write', 'edit', 'forget', 'find', 'search'])

/** Adapter-owned fixed errors may be shown verbatim; upstream data never is. */
export class OpenVikingAdapterError extends Error {
  constructor(message: string) { super(message); this.name = 'OpenVikingAdapterError' }
}

export type OpenVikingErrorCategory = 'cancelled' | 'timeout' | 'acl' | 'not_found' | 'conflict' | 'network' | 'protocol' | 'unavailable' | 'unsupported' | 'unknown'
export interface OpenVikingUpstreamFailure { category: OpenVikingErrorCategory; ref: string; message: string }

/** Categorize upstream failures without retaining or returning their source text. */
export function classifyUpstreamError(error: unknown, op: string): OpenVikingUpstreamFailure {
  const errorName = error instanceof Error
    ? error.name
    : typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
  const source = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  let category: OpenVikingErrorCategory = 'unknown'
  if (/AbortError/i.test(errorName) || /AbortError/i.test(source)) category = 'cancelled'
  else if (/timeout|ETIMEDOUT/i.test(source)) category = 'timeout'
  else if (/401|403|forbidden|denied|unauthor/i.test(source)) category = 'acl'
  else if (/404|not found|no such/i.test(source)) category = 'not_found'
  else if (/409|conflict|already exists/i.test(source)) category = 'conflict'
  else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket/i.test(source)) category = 'network'
  else if (/invalid .*result|unknown tool|MCP/i.test(source)) category = 'protocol'
  else if (/unavailable|not configured/i.test(source)) category = 'unavailable'
  else if (/unsupported/i.test(source)) category = 'unsupported'
  const ref = randomUUID().replace(/-/g, '').slice(0, 8)
  const safeOp = OPS.has(op) ? op : 'operation'
  return { category, ref, message: `OpenViking ${safeOp} failed [${category}] (ref ${ref})` }
}

export class OpenVikingUpstreamError extends Error {
  readonly category: OpenVikingErrorCategory
  readonly ref: string
  readonly op: string
  constructor(failure: OpenVikingUpstreamFailure, op: string) {
    super(failure.message)
    this.name = 'OpenVikingUpstreamError'
    this.category = failure.category
    this.ref = failure.ref
    this.op = op
  }
}

export function formatOpenVikingError(error: unknown, op = 'operation'): string {
  if (error instanceof OpenVikingAdapterError || error instanceof OpenVikingUpstreamError) return error.message
  return classifyUpstreamError(error, op).message
}

function upstreamFailure(error: unknown, op: string): OpenVikingUpstreamError {
  return new OpenVikingUpstreamError(classifyUpstreamError(error, op), op)
}
export const OPENVIKING_CAPABILITIES = {
  create: 'write(mode=create)', put: 'write(mode=replace)', upsert: 'write(mode=replace)', read: 'read',
  str_replace: 'edit(unique old_string)', insert: 'read + unique-anchor edit', delete: 'forget', rename: 'unsupported',
  list: 'list(text-line parsing)', search: 'find(text result)', compile: 'list + bounded reads (explicit incomplete marker)',
  journal: 'adapter-local only; not server transaction/Git', status: 'backend/binding/capabilities/reachability',
  reflect: 'unsupported (prevents local writes)', extract: 'unsupported (prevents local writes)', update_description: 'read + write(mode=replace; preserves read_only)',
} as const

export function openVikingUri(config: OpenVikingConfig, name = ''): string {
  if (!config.openvikingProjectId && !config.openvikingUserScope) throw new OpenVikingAdapterError('OpenViking fail-closed: configure openvikingProjectId or enable openvikingUserScope')
  if (config.openvikingProjectId && (!/^[A-Za-z0-9._-]{1,120}$/.test(config.openvikingProjectId) || config.openvikingProjectId === '.' || config.openvikingProjectId === '..')) throw new OpenVikingAdapterError('OpenViking fail-closed: projectId must match [A-Za-z0-9._-]{1,120}')
  const scope = config.openvikingProjectId
    ? `viking://~/peers/${config.openvikingProjectId}/memories`
    : 'viking://~/memories'
  const safeName = name.replace(/\.md$/, '')
  if (name && !safeName) throw new OpenVikingAdapterError('invalid memory name: normalized name is empty')
  if (safeName && (!/^[A-Za-z0-9._-]{1,60}$/.test(safeName) || safeName === '.' || safeName === '..')) throw new OpenVikingAdapterError('invalid memory name')
  return `${scope}${safeName ? `/${safeName}.md` : '/'}`
}

function textResult(result: OpenVikingResult, op: string): string {
  if (result.isError) throw upstreamFailure(result.error.message, op)
  // `content` is the final model-facing projection: post-execute policies may redact
  // or replace it while preserving `value`, so never recover text from `value`.
  const rawBlocks = result.value?.content
  if (rawBlocks?.some((block) => block.type !== 'text' || typeof block.text !== 'string')) {
    throw new OpenVikingAdapterError('OpenViking returned non-text source content; refusing lossy interpretation')
  }
  const blocks = result.content
  if (!Array.isArray(blocks) || blocks.length === 0) throw new OpenVikingAdapterError('OpenViking returned an unknown result format (expected non-empty final content blocks)')
  if (blocks.some((block) => block.type !== 'text' || typeof block.text !== 'string')) throw new OpenVikingAdapterError('OpenViking returned non-text final content; refusing lossy interpretation')
  const text = blocks.map((block) => block.text!).join('\n')
  if (!text.trim()) throw new OpenVikingAdapterError('OpenViking returned empty text content')
  return text
}

export async function openVikingCall(runtime: OpenVikingRuntime, config: OpenVikingConfig, exec: OpenVikingExec, op: string, args: Record<string, unknown>): Promise<string> {
  if (!OPS.has(op)) throw new OpenVikingAdapterError(`OpenViking adapter refused unsupported operation: ${op}`)
  if (!config.openvikingToolPrefix) throw new OpenVikingAdapterError('OpenViking tool prefix is empty')
  const name = `${config.openvikingToolPrefix}${op}`
  if (exec.signal.aborted) throw upstreamFailure({ name: 'AbortError' }, op)
  let result: OpenVikingResult
  try {
    result = await runtime.execute({ callId: randomUUID(), name, arguments: args, signal: exec.signal, ...(exec.agent === undefined ? {} : { agent: exec.agent }), ...(exec.rootCallId === undefined ? {} : { rootCallId: exec.rootCallId }), ...(exec.token === undefined ? {} : { parent: exec.token }) })
  } catch (error) {
    if (error instanceof OpenVikingAdapterError || error instanceof OpenVikingUpstreamError) throw error
    throw upstreamFailure(exec.signal.aborted ? { name: 'AbortError' } : error, op)
  }
  if (exec.signal.aborted) throw upstreamFailure({ name: 'AbortError' }, op)
  return textResult(result, op)
}

export function parseRemoteMemory(name: string, raw: string) {
  const { meta, body } = parseFrontmatter(raw)
  const description = typeof meta.description === 'string'
    ? meta.description.replace(/\\(["\\])/g, '$1').trim()
    : ''
  return { name, description, readOnly: String(meta.read_only ?? 'false') === 'true', body: body.replace(/^\n/, '').replace(/\n$/, '') }
}

export function remoteMemoryText(description: string, readOnly: boolean, body: string): string {
  if (!description.trim()) throw new OpenVikingAdapterError('memory contract: description must be non-empty')
  const safeDescription = description.trim().replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `---\ndescription: "${safeDescription}"\n${readOnly ? 'read_only: "true"\n' : ''}---\n\n${body.trimEnd()}\n`
}

export function parseListText(text: string, maxItems = 500): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith('.md')).slice(0, Math.max(0, maxItems))
}

/** Resolve a list-returned URI/path without flattening nested memories or escaping scope. */
export function resolveListedMemory(binding: string, listed: string): { uri: string; name: string } {
  const uri = listed.startsWith('viking://') ? listed : `${binding}${listed.replace(/^\/+/, '')}`
  if (!uri.startsWith(binding)) throw new OpenVikingAdapterError('OpenViking list returned an item outside the bound memory scope')
  const relative = uri.slice(binding.length)
  const parts = relative.split('/')
  if (!relative.endsWith('.md') || parts.some((part) => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new OpenVikingAdapterError('OpenViking list returned an invalid memory path')
  }
  const leaf = parts.at(-1)!.replace(/\.md$/, '')
  if (!leaf || leaf === '.' || leaf === '..') throw new OpenVikingAdapterError('OpenViking list returned an invalid memory name')
  return { uri, name: relative.replace(/\.md$/, '') }
}

/** Match parseFrontmatter + parseRemoteMemory leading-newline normalization exactly. */
export function bodyStartOf(raw: string): number {
  const noFrontmatter = (): number => (raw.startsWith('\n') ? 1 : 0)
  if (!raw.startsWith('---')) return noFrontmatter()
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return noFrontmatter()
  let start = end + 4
  const { body } = parseFrontmatter(raw)
  if (raw[start] === '\n') {
    start += 1 // parseFrontmatter removes exactly one leading newline
    if (body.startsWith('\n')) start += 1 // parseRemoteMemory removes one additional leading newline
  }
  return start
}

/** Require one match in the complete serialized document, and require it after frontmatter. */
export function uniqueBodyAnchor(fullText: string, anchor: string): number {
  if (!anchor) throw new OpenVikingAdapterError('memory edit requires a non-empty anchor')
  const bodyStart = bodyStartOf(fullText)
  const first = fullText.indexOf(anchor)
  if (first < 0) throw new OpenVikingAdapterError('memory edit anchor was not found')
  if (first < bodyStart) throw new OpenVikingAdapterError('memory edit anchor is in frontmatter')
  if (fullText.indexOf(anchor, first + anchor.length) >= 0) throw new OpenVikingAdapterError('memory edit anchor must be unique')
  return first - bodyStart
}

export function markCompileIncomplete(result: { block: string; files: string[]; incomplete: boolean }, maxChars: number): { block: string; files: string[]; incomplete: boolean } {
  const max = Math.max(0, maxChars)
  const marker = '[INCOMPLETE: listing limit; additional memories omitted]'
  if (result.block.includes('[INCOMPLETE:')) return { ...result, incomplete: true }
  if (max <= marker.length) return { ...result, block: marker.slice(0, max), incomplete: true }
  return { ...result, block: `${result.block.slice(0, max - marker.length)}${marker}`, incomplete: true }
}

export function compileRemoteMemories(entries: Array<{ name: string; description: string; readOnly: boolean; body: string }>, maxChars = 12000): { block: string; files: string[]; incomplete: boolean } {
  let block = '## OpenViking memories (remote; bounded snapshot)\n'
  const marker = '[INCOMPLETE: truncated at max_chars; additional memories omitted]'
  const files: string[] = []
  const max = Math.max(0, maxChars)
  if (block.length + marker.length > max) return { block: marker.slice(0, max), files, incomplete: true }
  for (const entry of entries) {
    const section = `\n### ${entry.name}\n> ${entry.description}${entry.readOnly ? ' [read_only]' : ''}\n\n${entry.body}\n`
    if (block.length + section.length + marker.length > max) return { block: block + marker, files, incomplete: true }
    block += section
    files.push(entry.name)
  }
  return { block, files, incomplete: false }
}
