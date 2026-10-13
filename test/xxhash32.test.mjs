import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { xxhash32, hashlineChecksum, HASHLINE_CHARSET } from '../lib/xxhash32.js'
import { applyHashlineEdits, describeLines } from '../lib/hashline.js'
import { apply } from '../lib/index.js'

// Reference values were independently checked with upstream libxxhash.so.0 XXH32(seed=0).
const vectors = [
  ['', 0x02cc5d05],
  ['a', 0x550d7456],
  ['abc', 0x32d153ff],
  ['short', 0x50b774c7],
  ['x'.repeat(15), 0x2e3dc0b0],
  ['x'.repeat(16), 0x181a700d],
  ['x'.repeat(17), 0x483f1b5f],
  ['x'.repeat(31), 0x6ba3bb5c],
  ['x'.repeat(32), 0x25cef61d],
  ['x'.repeat(33), 0x314b2587],
  ['this is a much longer line with UTF-8: 中文🙂', 0xc6c883c2],
]

test('xxhash32 matches XXH32 seed-zero vectors across block and UTF-8 boundaries', () => {
  for (const [input, expected] of vectors) assert.equal(xxhash32(input), expected, JSON.stringify(input))
})

test('hashline checksum remains a two-character encoding for long UTF-8 lines', () => {
  for (const [input, expected] of vectors) {
    const h = expected >>> 0
    assert.equal(hashlineChecksum(input), HASHLINE_CHARSET[h & 0xf] + HASHLINE_CHARSET[(h >>> 8) & 0xf])
  }
})

test('registered hashline tools lines → fresh edit → stale rejection', async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'xxhash32-registered-'))
  const registered = new Map()
  const ctx = {
    inject: (_deps, callback) => callback({}),
    effect: (callback) => callback(),
    get: () => undefined,
    tools: { register: (def) => registered.set(def.name, def), guard: () => () => {} },
    skills: { register: () => () => {} },
    webServer: { register: () => () => {} },
    on: () => () => {},
    logger: { info: () => {}, warn: () => {} },
  }
  try {
    apply(ctx, {
      defaultWorkspace: ws, workspaceHints: [], delegateProvider: 'spawn',
      delegateFlashRoute: 'f/x', delegateHeavyRoute: 'h/y', mainPrompt: 'off',
      customPromptSection: '', goalGuardOn: false,
    })
    const file = 'registered.txt'
    fs.writeFileSync(path.join(ws, file), 'a long registered-tool line over sixteen bytes\nstable second line\n')
    const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: ws } } } }
    const lines = await registered.get('omo_hashline_lines').execute({ file }, exec)
    const first = lines.lines[0]
    assert.ok(first.hash)
    const fresh = await registered.get('omo_hashline_edit').execute({
      file, edits: [{ line: first.line, hash: first.hash, op: 'replace', content: 'fresh registered replacement' }],
    }, exec)
    assert.equal(fresh.ok, true)
    const stale = await registered.get('omo_hashline_edit').execute({
      file, edits: [{ line: first.line, hash: first.hash, op: 'replace', content: 'stale must not apply' }],
    }, exec)
    assert.equal(stale.ok, false)
    assert.match(stale.conflicted[0].reason, /^stale hash/)
    assert.match(fs.readFileSync(path.join(ws, file), 'utf8'), /^fresh registered replacement\n/)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})

test('hashline lines → fresh edit succeeds → stale checksum is rejected', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'xxhash32-hashline-'))
  try {
    const file = 'sample.txt'
    fs.writeFileSync(path.join(ws, file), 'a long line that is definitely over sixteen bytes\nsecond stable line\n')
    const lines = describeLines(ws, file)
    assert.equal(lines.lines.length, 2)
    const first = lines.lines[0]
    const fresh = applyHashlineEdits(ws, file, [{ line: first.line, hash: first.hash, op: 'replace', content: 'fresh replacement line' }])
    assert.equal(fresh.ok, true)
    assert.deepEqual(fresh.applied.map(x => x.ok), [true])
    const stale = applyHashlineEdits(ws, file, [{ line: first.line, hash: first.hash, op: 'replace', content: 'must not apply' }])
    assert.equal(stale.ok, false)
    assert.equal(stale.conflicted[0]?.reason?.startsWith('stale hash'), true)
    assert.match(fs.readFileSync(path.join(ws, file), 'utf8'), /^fresh replacement line\n/)
  } finally {
    fs.rmSync(ws, { recursive: true, force: true })
  }
})
