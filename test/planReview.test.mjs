import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildPlanReviewQuestion, goalFromPlan, interpretPlanReviewAnswer, validatePlanMarkdown } from '../lib/planReview.js'
import { bindProjectionHost, isPlanningActive, persistedSessionModeOf, sessionModeProjectionUnit, setSessionMode, sessionModeOf } from '../lib/sessionModel.js'

test('plan review validation and card contract preserve the approved markdown', () => {
  const plan = '# Ship it\n\nFull content.'
  assert.doesNotThrow(() => validatePlanMarkdown(plan))
  assert.throws(() => validatePlanMarkdown('not a heading'))
  assert.equal(goalFromPlan(plan), 'Ship it')
  assert.deepEqual(buildPlanReviewQuestion(plan).options.map((o) => o.label), ['Approve', 'Keep planning'])
  assert.equal(buildPlanReviewQuestion(plan).detail, plan)
})

test('plan review answer choices distinguish approve, keep, cancelled and unknown', () => {
  assert.equal(interpretPlanReviewAnswer([{ selected: ['Approve'] }]), 'approve')
  assert.equal(interpretPlanReviewAnswer([{ selected: ['Keep planning'], custom: 'revise section' }]), 'keep')
  assert.equal(interpretPlanReviewAnswer([]), 'cancelled')
  assert.equal(interpretPlanReviewAnswer([{ selected: ['Other'] }]), 'unknown')
})

test('session-mode projection replays the persisted event', () => {
  const unit = sessionModeProjectionUnit()
  const state = unit.apply(unit.init(), { type: 'omo/session-mode', data: { mode: 'prometheus' } })
  assert.deepEqual(unit.wire.view(state), { mode: 'prometheus' })
})

test('mode survives session restoration without custom host events and restores the original model', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-session-mode-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const events = []
  let config = { provider: 'default', model: 'original' }
  const session = () => ({
    id: 'session-mode-regression',
    requestHeader: () => ({ config }),
    append(type, data) {
      events.push({ type, data })
      if (type === 'request/header') config = data.header.config
    },
  })
  try {
    const initial = { session: session() }
    await setSessionMode(initial, 'prometheus', { provider: 'plan', model: 'planner' })
    assert.equal(persistedSessionModeOf('session-mode-regression'), 'prometheus')
    assert.equal(persistedSessionModeOf('../session-mode-regression'), null)
    assert.equal(sessionModeOf({ session: session() }), 'prometheus')
    await setSessionMode({ session: session() }, 'atlas', { provider: 'exec', model: 'executor' })
    const restored = { session: session() }
    assert.equal(sessionModeOf(restored), 'atlas')
    await setSessionMode(restored, 'off')
    assert.deepEqual(config, { provider: 'default', model: 'original' })
    bindProjectionHost({ stateOf: () => ({ mode: 'atlas' }) })
    assert.equal(sessionModeOf({ session: session() }), 'off')
    assert.equal(persistedSessionModeOf('session-mode-regression'), 'off')
    assert.ok(events.length > 0)
    assert.ok(events.every((event) => event.type === 'request/header'))
  } finally {
    bindProjectionHost(null)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('durable projection restores the mode for a restored session, and in-process state wins over a stale one', async () => {
  // Restored session: no in-process record, but the durable event is in the log.
  const session = {
    requestHeader: () => undefined,
    append() {},
  }
  const agent = { session }
  const seen = []
  try {
    bindProjectionHost({ stateOf: (target, key) => { seen.push(key); return key === 'omo-session-mode' ? { mode: 'atlas' } : undefined } })
    assert.equal(sessionModeOf(agent), 'atlas')
    assert.equal(isPlanningActive(agent), false)
    assert.ok(seen.length >= 1 && seen.every((key) => key === 'omo-session-mode'), `stateOf keys: ${seen.join(',')}`)
    // Once this process switches mode, the local record must win even though the
    // projection host would still report the pre-restart value.
    await setSessionMode(agent, 'prometheus', { provider: 'plan', model: 'planner' }, { provider: 'default', model: 'model' })
    assert.equal(sessionModeOf(agent), 'prometheus')
    assert.equal(isPlanningActive(agent), true)
  } finally {
    bindProjectionHost(null)
  }
  // Unbound host: falls back to the pre-projection behavior.
  assert.equal(sessionModeOf(agent), 'prometheus')
})

test('projection read failure falls back to the exact legacy WeakMap planning gate', async () => {
  let config = { provider: 'default', model: 'model' }
  const session = {
    requestHeader: () => ({ config }),
    append(type, data) { if (type === 'request/header') config = data.header.config },
  }
  const agent = { session }
  try {
    bindProjectionHost({ stateOf() { throw new Error('projection unavailable') } })
    assert.equal(sessionModeOf(agent), 'off')
    assert.equal(isPlanningActive(agent), false)
  } finally {
    bindProjectionHost(null)
  }
  await setSessionMode(agent, 'prometheus', { provider: 'plan', model: 'planner' }, { provider: 'default', model: 'model' })
  assert.equal(sessionModeOf(agent), 'prometheus')
  assert.equal(isPlanningActive(agent), true)
  await setSessionMode(agent, 'atlas', { provider: 'exec', model: 'executor' }, { provider: 'default', model: 'model' })
  assert.equal(isPlanningActive(agent), false)
  await setSessionMode(agent, 'off', undefined, { provider: 'default', model: 'model' })
  assert.equal(sessionModeOf(agent), 'off')
  assert.equal(isPlanningActive(agent), false)
  assert.equal(isPlanningActive(undefined), false)
})
