import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { skillRegistrations } from '../lib/skills.js'
import { apply } from '../lib/index.js'
import { withMemoryResponsibility } from '../lib/memory.js'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import {
  openVikingCall, openVikingUri, parseRemoteMemory, remoteMemoryText,
  parseListText, compileRemoteMemories, markCompileIncomplete, OPENVIKING_CAPABILITIES, resolveListedMemory, uniqueBodyAnchor,
  classifyUpstreamError, OpenVikingAdapterError, OpenVikingUpstreamError, formatOpenVikingError, bodyStartOf,
} from '../lib/openviking.js'

const config = (overrides = {}) => ({ memoryBackend: 'openviking', openvikingProjectId: 'proj-1', openvikingUserScope: false, openvikingToolPrefix: 'mcp__openviking__', openvikingWriteWait: false, ...overrides })
const exec = (overrides = {}) => ({ signal: new AbortController().signal, ...overrides })
const success = (text) => ({ isError: false, value: { content: [{ type: 'text', text }] }, content: [{ type: 'text', text }] })
function openVikingTool(execute, projectId = 'project') {
  const registered = new Map()
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} }, guard: () => () => {}, execute },
    skills: { register: () => () => {} }, webServer: { register: () => () => {} },
    systemPrompt: { section: () => () => {} }, inject: (_deps, cb) => cb({}), effect: (cb) => cb(), on: () => () => {}, get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, { defaultWorkspace: process.cwd(), workspaceHints: [], delegateProvider: 'spawn', delegateFlashRoute: 'f/x', delegateHeavyRoute: 'h/y', mainPrompt: 'off', customPromptSection: '', goalGuardOn: false, memoryBackend: 'openviking', openvikingProjectId: 'project', openvikingUserScope: false, openvikingToolPrefix: 'mcp__openviking__', openvikingWriteWait: false })
  return registered.get('omo_memory')
}

test('default local config remains the default and project/user URIs bind deterministically', () => {
  assert.match(skillRegistrations()[0].name, /omo-ultrawork/)
  assert.match(skillRegistrations().find((x) => x.name === 'omo-memory').content, /\.omo\/memory/)
  assert.equal(withMemoryResponsibility('', 'openviking'), '')
  assert.equal(withMemoryResponsibility('  \n  ', 'openviking'), '')
  const memorySkill = skillRegistrations('openviking').find((entry) => entry.name === 'omo-memory')
  for (const action of ['update_description', 'insert', 'journal']) assert.match(memorySkill.content, new RegExp(action))
  for (const action of ['rename', 'reflect', 'extract']) assert.match(memorySkill.content, new RegExp(`${action}.*不支持`))
  assert.match(withMemoryResponsibility('discipline', 'openviking'), /OpenViking/)
  assert.equal(config().memoryBackend, 'openviking')
  assert.equal(openVikingUri(config(), 'notes'), 'viking://~/peers/proj-1/memories/notes.md')
  assert.equal(openVikingUri(config({ openvikingProjectId: '', openvikingUserScope: true }), 'notes'), 'viking://~/memories/notes.md')
  assert.throws(() => openVikingUri(config({ openvikingProjectId: '', openvikingUserScope: false })), /fail-closed/)
  assert.throws(() => openVikingUri(config({ openvikingProjectId: 'bad/id' })), /projectId/)
})

test('mainPrompt=off registers no Sisyphus section despite external memory responsibility', async () => {
  const sections = []
  const registered = new Map()
  let mcpCalls = 0
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} }, guard: () => () => {}, execute: async () => { mcpCalls++; return success('---\ndescription: protected\nread_only: true\n---\n\nsecret') } },
    skills: { register: () => () => {} },
    webServer: { register: () => () => {} },
    systemPrompt: { section: (entry) => { sections.push(entry); return () => {} } },
    inject: (_deps, cb) => cb({}), effect: (cb) => cb(), on: () => () => {}, get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, { defaultWorkspace: process.cwd(), workspaceHints: [], delegateProvider: 'spawn', delegateFlashRoute: 'f/x', delegateHeavyRoute: 'h/y', mainPrompt: 'off', customPromptSection: '', goalGuardOn: false, memoryBackend: 'openviking', openvikingProjectId: 'project', openvikingUserScope: false, openvikingToolPrefix: 'mcp__openviking__', openvikingWriteWait: false })
  assert.equal(sections.some((entry) => entry.name === 'omo:sisyphus-discipline'), false)
  const memoryTool = registered.get('omo_memory')
  assert.ok(memoryTool)
  const unsupported = await memoryTool.execute({ action: 'rename', name: 'old', new_name: 'new' }, exec())
  assert.equal(unsupported.ok, false)
  assert.match(unsupported.message, /unsupported/i)
  assert.equal(mcpCalls, 0)
  const blocked = await memoryTool.execute({ action: 'delete', name: 'protected' }, exec())
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /read_only/)
  assert.equal(mcpCalls, 1)
})

test('missing OpenViking binding fails closed without writing a local memory body', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-openviking-closed-'))
  const registered = new Map()
  const ctx = {
    tools: { register: (d) => { registered.set(d.name, d); return () => {} }, guard: () => () => {}, execute: async () => { throw new Error('must not execute') } },
    skills: { register: () => () => {} }, webServer: { register: () => () => {} },
    inject: (_deps, cb) => cb({}), effect: (cb) => cb(), on: () => () => {}, get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
  }
  try {
    apply(ctx, { defaultWorkspace: ws, workspaceHints: [], delegateProvider: 'spawn', delegateFlashRoute: 'f/x', delegateHeavyRoute: 'h/y', mainPrompt: 'off', customPromptSection: '', goalGuardOn: false, memoryBackend: 'openviking', openvikingProjectId: '', openvikingUserScope: false, openvikingToolPrefix: 'mcp__openviking__', openvikingWriteWait: false })
    const result = await registered.get('omo_memory').execute({ action: 'create', name: 'protected', content: 'secret body', description: 'test' }, exec())
    assert.equal(result.ok, false)
    assert.match(result.message, /fail-closed/)
    assert.equal(fs.existsSync(path.join(ws, '.omo', 'memory', 'protected.md')), false)
  } finally { fs.rmSync(ws, { recursive: true, force: true }) }
})

test('bridge uses MCP names/arguments and forwards call context', async () => {
  let got
  const runtime = { execute: async (args) => { got = args; return success('plain text') } }
  const agent = { id: 'a' }, parent = { tool: 'outer' }, signal = new AbortController().signal
  assert.equal(await openVikingCall(runtime, config(), { signal, agent, callId: 'call-1', rootCallId: 'root-1', parent }, 'read', { uris: ['viking://x'] }), 'plain text')
  assert.equal(got.name, 'mcp__openviking__read')
  assert.deepEqual(got.arguments, { uris: ['viking://x'] })
  assert.notEqual(got.callId, 'call-1'); assert.equal(got.rootCallId, 'root-1'); assert.equal(got.agent, agent); assert.equal(got.signal, signal); assert.equal(got.parent, undefined)
  const firstCallId = got.callId
  await openVikingCall(runtime, config(), { signal, rootCallId: 'root-1', token: parent }, 'read', {})
  assert.notEqual(got.callId, firstCallId); assert.equal(got.rootCallId, 'root-1'); assert.equal(got.parent, parent)
  await assert.rejects(openVikingCall(runtime, config(), exec(), 'delegate_as', {}), /unsupported operation/)
})

test('real Cordis Context + ToolRuntime register/execute applies ToolGuard through public path', async () => {
  const ctx = new Context()
  ctx.systemPrompt = { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 }
  const runtime = new ToolRuntime(ctx, { mode: 'native' })
  let executed = 0
  runtime.register({
    name: 'mcp__openviking__read',
    description: 'fake MCP read',
    parameters: { type: 'object', properties: { uris: { type: 'array', items: { type: 'string' } } }, required: ['uris'] },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.content[0].text }] },
    execute: async () => { executed++; return { content: [{ type: 'text', text: 'runtime-ok' }] } },
  })
  const guardOff = runtime.guard((call) => call.name === 'mcp__openviking__read' ? 'test guard denied MCP call' : undefined)
  const denied = await openVikingCall(runtime, config(), exec(), 'read', { uris: ['viking://x/a.md'] })
    .then(() => 'unexpected-success', (e) => e.message)
  assert.match(denied, /\[acl\]/)
  assert.doesNotMatch(denied, /test guard denied MCP call/)
  assert.equal(executed, 0)
  guardOff()
  const allowed = await openVikingCall(runtime, config(), exec(), 'read', { uris: ['viking://x/a.md'] })
  assert.equal(allowed, 'runtime-ok')
  assert.equal(executed, 1)
})

test('bridge surfaces ToolFailure message, cancellation and non-text blocks as failures', async () => {
  const failed = { execute: async () => ({ isError: true, error: { message: 'ACL denied' }, content: [] }) }
  await assert.rejects(openVikingCall(failed, config(), exec(), 'read', { uris: [] }), (error) => {
    assert.match(error.message, /OpenViking read failed \[acl\] \(ref [a-f0-9]{8}\)/)
    assert.doesNotMatch(error.message, /ACL denied/)
    return true
  })
  const ctl = new AbortController(); ctl.abort()
  await assert.rejects(openVikingCall({ execute: async () => success('never') }, config(), { signal: ctl.signal }, 'read', {}), /cancelled/)
  const image = { execute: async () => ({ isError: false, value: { content: [{ type: 'image' }] }, content: [] }) }
  await assert.rejects(openVikingCall(image, config(), exec(), 'read', {}), /non-text source content/)
})

test('frontmatter read/write preserves description and read_only', () => {
  const before = remoteMemoryText('decision record', true, 'alpha\nbeta')
  assert.deepEqual(parseRemoteMemory('memo', before), { name: 'memo', description: 'decision record', readOnly: true, body: 'alpha\nbeta' })
  assert.equal(remoteMemoryText(parseRemoteMemory('memo', before).description, true, 'updated'), '---\ndescription: "decision record"\nread_only: "true"\n---\n\nupdated\n')
  let value = remoteMemoryText('quote " and slash \\', false, 'body')
  for (let i = 0; i < 5; i++) value = remoteMemoryText(parseRemoteMemory('memo', value).description, false, 'body')
  assert.equal(parseRemoteMemory('memo', value).description, 'quote " and slash \\')
})

test('list parsing, bounded helper surface, and explicit unsupported capabilities', () => {
  assert.deepEqual(parseListText('viking://x/a.md\nnot-a-file\nfoo/b.md\n'), ['viking://x/a.md', 'foo/b.md'])
  assert.deepEqual(parseListText('a.md\nb.md', 1), ['a.md'])
  assert.match(OPENVIKING_CAPABILITIES.rename, /unsupported/)
  assert.match(OPENVIKING_CAPABILITIES.journal, /adapter-local/)
  assert.match(OPENVIKING_CAPABILITIES.compile, /bounded/)
  const compiled = compileRemoteMemories([{ name: 'a', description: 'd', readOnly: false, body: '1234567890' }, { name: 'b', description: 'd', readOnly: true, body: '1234567890' }], 60)
  assert.equal(compiled.incomplete, true)
  assert.match(compiled.block, /INCOMPLETE/)
  assert.deepEqual(compiled.files, [])
  const capped = markCompileIncomplete({ block: 'x'.repeat(200), files: [], incomplete: false }, 80)
  assert.equal(capped.block.length <= 80, true)
  assert.match(capped.block, /INCOMPLETE/)
})

test('final projected content is consumed and non-text source blocks fail closed', async () => {
  const runtime = { execute: async () => ({ isError: false, value: { content: [{ type: 'text', text: 'original secret' }] }, content: [{ type: 'text', text: 'redacted projection' }] }) }
  assert.equal(await openVikingCall(runtime, config(), exec(), 'read', {}), 'redacted projection')
  const mixed = { execute: async () => ({ isError: false, value: { content: [{ type: 'image' }] }, content: [{ type: 'text', text: 'sanitized' }] }) }
  await assert.rejects(openVikingCall(mixed, config(), exec(), 'read', {}), /non-text source content/)
})

test('anchors validate full serialized document; nested list URIs preserve their path', () => {
  const raw = remoteMemoryText('unique description anchor', false, 'body anchor')
  assert.throws(() => uniqueBodyAnchor(raw, 'unique description anchor'), /frontmatter/)
  assert.throws(() => uniqueBodyAnchor('---\ndescription: d\n---\nrepeat repeat', 'repeat'), /unique/)
  assert.equal(uniqueBodyAnchor(raw, 'body anchor'), 0)
  assert.deepEqual(resolveListedMemory('viking://~/peers/p/memories/', 'nested/deep/item.md'), {
    uri: 'viking://~/peers/p/memories/nested/deep/item.md', name: 'nested/deep/item',
  })
})

test('body anchor offsets match frontmatter and parsed body leading-newline normalization', () => {
  const withHeaderBlank = '---\n\ndescription: alpha\n---\n\nbody\n'
  assert.equal(bodyStartOf(withHeaderBlank), withHeaderBlank.indexOf('body'))
  assert.throws(() => uniqueBodyAnchor(withHeaderBlank, 'alpha'), /frontmatter/)
  assert.equal(uniqueBodyAnchor(withHeaderBlank, 'body'), 0)
  const noBodyBlank = '---\ndescription: d\n---\nbody'
  assert.equal(uniqueBodyAnchor(noBodyBlank, 'body'), 0)
  const plain = 'prefix\n\nold'
  assert.equal(uniqueBodyAnchor(plain, 'old'), plain.indexOf('old'))
  assert.equal(bodyStartOf('\nold'), 1)
  assert.equal(bodyStartOf('\n\nold'), 1)
  assert.equal(bodyStartOf('old'), 0)
  assert.equal(uniqueBodyAnchor('\nold', 'old'), 0)
  assert.equal(uniqueBodyAnchor('\n\nold', 'old'), 1)
  const unclosed = '---\ndescription: d\nold'
  assert.equal(bodyStartOf(unclosed), 0)
  assert.equal(uniqueBodyAnchor(unclosed, 'old'), unclosed.indexOf('old'))
})

test('action mapping and frontmatter conflict protection preserve remote headers', async () => {
  const calls = []
  let existing = remoteMemoryText('keep "quoted" \\ path', false, 'old body')
  const tool = openVikingTool(async (call) => {
    calls.push(call)
    if (call.name.endsWith('__list')) return success('note.md')
    if (call.name.endsWith('__read')) return success(existing)
    if (call.name.endsWith('__write')) { if (call.arguments.uri.endsWith('/note.md')) existing = call.arguments.content; return success('written') }
    throw new Error(`unexpected ${call.name}`)
  })
  const created = await tool.execute({ action: 'create', name: 'new-note', description: 'quoted " and \\', content: 'new body' }, exec())
  assert.equal(created.ok, true)
  assert.equal(calls.at(-1).name, 'mcp__openviking__write')
  assert.equal(calls.at(-1).arguments.mode, 'create')
  assert.match(calls.at(-1).arguments.content, /description: "quoted \\\" and \\\\\"/)
  calls.length = 0
  const put = await tool.execute({ action: 'put', name: 'note', content: 'replacement' }, exec())
  assert.equal(put.ok, true)
  assert.equal(calls.find((call) => call.name.endsWith('__write')).arguments.mode, 'replace')
  assert.equal(parseRemoteMemory('note', existing).description, 'keep "quoted" \\ path')
  existing = remoteMemoryText('protected', true, 'locked')
  calls.length = 0
  const denied = await tool.execute({ action: 'put', name: 'note', content: 'overwrite', description: 'changed' }, exec())
  assert.equal(denied.ok, false)
  assert.match(denied.message, /read_only/)
  assert.equal(calls.some((call) => call.name.endsWith('__write')), false)
})

test('str_replace and insert reach edit with body-only anchors and matching returned bodies', async () => {
  let raw = remoteMemoryText('description', false, 'old')
  const edits = []
  const tool = openVikingTool(async (call) => {
    if (call.name.endsWith('__read')) return success(raw)
    if (call.name.endsWith('__edit')) { edits.push(call.arguments); return success('edited') }
    throw new Error(`unexpected ${call.name}`)
  })
  const replaced = await tool.execute({ action: 'str_replace', name: 'memo', old_text: 'old', new_text: 'new' }, exec())
  assert.equal(edits[0].old_string, 'old')
  assert.equal(edits[0].new_string, 'new')
  assert.equal(replaced.memory.body, edits[0].new_string)
  raw = remoteMemoryText('description', false, 'anchor')
  const inserted = await tool.execute({ action: 'insert', name: 'memo', old_text: 'anchor', content: 'new' }, exec())
  assert.equal(edits[1].old_string, 'anchor')
  assert.equal(edits[1].new_string, 'new\nanchor')
  assert.equal(inserted.memory.body, edits[1].new_string)
})

test('edit reconstruction invariant matches parsed body and journal across frontmatter boundaries', async () => {
  let raw = ''
  const edits = []
  const tool = openVikingTool(async (call) => {
    if (call.name.endsWith('__read')) return success(raw)
    if (call.name.endsWith('__edit')) { edits.push(call.arguments); return success('edited') }
    throw new Error(`unexpected ${call.name}`)
  })
  const digest = (text) => createHash('sha256').update(text).digest('hex')
  const rawCases = ['\nold', '\n\nold', remoteMemoryText('description', false, 'old'), 'prefix old suffix']
  for (const candidate of rawCases) {
    raw = candidate
    const parsed = parseRemoteMemory('memo', raw)
    const replaced = await tool.execute({ action: 'str_replace', name: 'memo', old_text: 'old', new_text: 'NEW' }, exec())
    const expectedReplacement = parsed.body.replace('old', 'NEW')
    const replaceEdit = edits.at(-1)
    assert.equal(replaceEdit.old_string, 'old')
    assert.equal(parsed.body.replace(replaceEdit.old_string, replaceEdit.new_string), expectedReplacement)
    assert.equal(replaced.memory.body, expectedReplacement)
    let journal = await tool.execute({ action: 'journal' }, exec())
    assert.equal(journal.journal[0].op, 'str_replace')
    assert.equal(journal.journal[0].beforeHash, digest(parsed.body))
    assert.equal(journal.journal[0].afterHash, digest(expectedReplacement))

    const inserted = await tool.execute({ action: 'insert', name: 'memo', old_text: 'old', content: 'INSERT' }, exec())
    const insertEdit = edits.at(-1)
    const expectedInsertion = parsed.body.replace('old', insertEdit.new_string)
    assert.equal(insertEdit.old_string, 'old')
    assert.equal(insertEdit.new_string, 'INSERT\nold')
    assert.equal(inserted.memory.body, expectedInsertion)
    journal = await tool.execute({ action: 'journal' }, exec())
    assert.equal(journal.journal[0].op, 'insert')
    assert.equal(journal.journal[0].beforeHash, digest(parsed.body))
    assert.equal(journal.journal[0].afterHash, digest(expectedInsertion))
  }
})

test('search binds target_uri and put never writes after list/read failures', async () => {
  const seen = []
  const tool = openVikingTool(async (call) => {
    seen.push(call)
    if (call.name.endsWith('__find')) return success('scoped hit')
    if (call.name.endsWith('__list')) return success('')
    if (call.name.endsWith('__read')) return { isError: true, error: { message: 'ACL denied' }, content: [] }
    return success('unexpected write')
  })
  const searched = await tool.execute({ action: 'search', query: 'needle' }, exec())
  assert.equal(searched.resultText, 'scoped hit')
  assert.equal(seen[0].name, 'mcp__openviking__find')
  assert.equal(seen[0].arguments.target_uri, 'viking://~/peers/project/memories/')
  const put = await tool.execute({ action: 'put', name: 'memo', content: 'body', description: 'd' }, exec())
  assert.equal(put.ok, false)
  assert.equal(seen.some((call) => call.name.endsWith('__write')), false)
})

test('put list-hit followed by ACL read failure returns classified error and never writes', async () => {
  const calls = []
  const tool = openVikingTool(async (call) => {
    calls.push(call)
    if (call.name.endsWith('__list')) return success('memo.md')
    if (call.name.endsWith('__read')) throw new Error('403 ACL denied key: SECRET123 internal.host:8080')
    if (call.name.endsWith('__write')) return success('must not write')
    throw new Error('unexpected operation')
  })
  const result = await tool.execute({ action: 'put', name: 'memo', content: 'replacement', description: 'desc' }, exec())
  assert.equal(result.ok, false)
  assert.match(result.message, /OpenViking read failed \[acl\] \(ref [a-f0-9]{8}\)/)
  assert.doesNotMatch(result.message, /403|ACL denied|SECRET123|internal\.host/)
  assert.equal(calls.some((call) => call.name.endsWith('__write')), false)
})

test('normalized empty names fail before remote calls; missing ToolRuntime never writes', async () => {
  let calls = 0
  const tool = openVikingTool(async () => { calls++; return success('') })
  for (const action of ['read', 'create', 'put', 'delete', 'str_replace', 'insert', 'update_description']) {
    const result = await tool.execute({ action, name: '.md', content: 'x', description: 'd' }, exec())
    assert.equal(result.ok, false, action)
    assert.match(result.message, /empty after normalization/, action)
  }
  assert.equal(calls, 0)
  const noRuntimeTool = openVikingTool(undefined)
  const denied = await noRuntimeTool.execute({ action: 'put', name: 'memo', content: 'x', description: 'd' }, exec())
  assert.equal(denied.ok, false)
  assert.match(denied.message, /host tools.execute is missing/)
})

test('nested list and compile read the identical list-returned URI without flattening', async () => {
  const calls = []
  const tool = openVikingTool(async (call) => {
    calls.push(call)
    if (call.name.endsWith('__list')) return success('nested/deep/item.md')
    if (call.name.endsWith('__read')) return success(remoteMemoryText('nested description', false, 'nested body'))
    throw new Error(`unexpected ${call.name}`)
  })
  const listed = await tool.execute({ action: 'list' }, exec())
  const listedUri = listed.files[0].uri
  assert.equal(listed.files[0].name, 'nested/deep/item')
  assert.equal(listed.files[0].description, null)
  assert.equal(listed.files[0].readOnly, null)
  calls.length = 0
  const compiled = await tool.execute({ action: 'compile' }, exec())
  assert.deepEqual(calls.filter((call) => call.name.endsWith('__read')).map((call) => call.arguments.uris[0]), [listedUri])
  assert.deepEqual(compiled.files, ['nested/deep/item'])
  assert.equal(compiled.hash, createHash('sha256').update(compiled.block).digest('hex'))
  assert.equal(compiled.cached, false)
})

test('upstream failures use fixed category/ref templates and never echo source secrets', async () => {
  const hostile = '403 token=SECRET123; key: SECRET123; {"api_key":"SECRET123"}; {\'api_key\': \'SECRET123\'}; Authorization: Basic dXNlcjpzZWNyZXQ=; internal.host:8080 [2001:db8::1]:443 nakedOpaqueToken987 sk-0123456789abcdef ovk_0123456789abcdef'
  const failure = classifyUpstreamError(new Error(hostile), 'read')
  assert.equal(failure.category, 'acl')
  assert.match(failure.message, /^OpenViking read failed \[acl\] \(ref [a-f0-9]{8}\)$/)
  assert.doesNotMatch(failure.message, /SECRET123|dXNlcjpzZWNyZXQ=|internal\.host|2001:db8::1|nakedOpaqueToken987|sk-0123456789abcdef|ovk_0123456789abcdef/)
  for (const [source, category] of [['ETIMEDOUT', 'timeout'], ['404 not found', 'not_found'], ['409 already exists', 'conflict'], ['ECONNREFUSED internal.host:8080', 'network'], ['MCP invalid response result', 'protocol'], ['service unavailable', 'unavailable'], ['unsupported operation', 'unsupported'], ['unclassified opaque SECRET123', 'unknown'], ['AbortError', 'cancelled']]) {
    assert.equal(classifyUpstreamError(new Error(source), 'read').category, category, source)
  }

  const toolFailure = { execute: async () => ({ isError: true, error: { message: hostile }, content: [] }) }
  await assert.rejects(openVikingCall(toolFailure, config(), exec(), 'read', {}), (error) => {
    assert.match(error.message, /OpenViking read failed \[acl\] \(ref [a-f0-9]{8}\)/)
    assert.doesNotMatch(error.message, /SECRET123|Basic|internal\.host|2001:db8::1/)
    return true
  })
  const thrown = { execute: async () => { throw new Error(hostile) } }
  await assert.rejects(openVikingCall(thrown, config(), exec(), 'read', {}), (error) => {
    assert.match(error.message, /OpenViking read failed \[acl\]/)
    assert.doesNotMatch(error.message, /SECRET123|Basic|internal\.host|2001:db8::1/)
    return true
  })
  const own = new OpenVikingAdapterError('invalid memory name')
  assert.equal(formatOpenVikingError(own), 'invalid memory name')
  assert.throws(() => openVikingUri(config(), '.md'), (error) => error instanceof OpenVikingAdapterError && error.message === 'invalid memory name: normalized name is empty')
  assert.equal(new OpenVikingUpstreamError(failure, 'read').message, failure.message)
})

test('status surfaces expose fixed errors only and API status has no upstream source text', async () => {
  const hostile = '403 token=SECRET123; key: SECRET123; {"api_key":"SECRET123"}; {\'api_key\': \'SECRET123\'}; Authorization: Basic dXNlcjpzZWNyZXQ=; internal.host:8080 [2001:db8::1]:443 nakedOpaqueToken987 sk-0123456789abcdef ovk_0123456789abcdef'
  const definitions = new Map(), routes = new Map()
  const ctx = {
    tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {} }, guard: () => () => {}, execute: async () => { throw new Error(hostile) } },
    skills: { register: () => () => {} },
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
    systemPrompt: { section: () => () => {} },
    inject: (_deps, cb) => cb({}), effect: (cb) => cb(), on: () => () => {}, get: () => undefined,
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx, { defaultWorkspace: process.cwd(), workspaceHints: [], delegateProvider: 'spawn', delegateFlashRoute: 'f/x', delegateHeavyRoute: 'h/y', mainPrompt: 'off', customPromptSection: '', goalGuardOn: false, memoryBackend: 'openviking', openvikingProjectId: 'project', openvikingUserScope: false, openvikingToolPrefix: 'mcp__openviking__', openvikingWriteWait: false })
  const status = await definitions.get('omo_status').execute({}, exec())
  const statusText = JSON.stringify(status)
  assert.match(statusText, /OpenViking list failed \[acl\] \(ref [a-f0-9]{8}\)/)
  assert.doesNotMatch(statusText, /SECRET123|dXNlcjpzZWNyZXQ=|internal\.host|2001:db8::1|nakedOpaqueToken987|sk-0123456789abcdef|ovk_0123456789abcdef/)
  let apiBody = ''
  routes.get('/dsh-oh-my-agent/api/status').handler({ url: '/dsh-oh-my-agent/api/status' }, { writeHead: () => {}, end: (body) => { apiBody = body } })
  assert.doesNotMatch(apiBody, /SECRET123|dXNlcjpzZWNyZXQ=|internal\.host/)
})
