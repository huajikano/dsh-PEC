import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { GatewayState } from '../lib/state.js'

// GatewayState reads its store from DSH_HOME - point it at a scratch dir so
// tests never touch (or depend on) the real paired devices.
function withScratchHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pec-pairing-test-'))
  process.env.DSH_HOME = dir
  return dir
}

test('setup', () => {
  withScratchHome()
})

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'

test.beforeEach(() => {
  withScratchHome()
})

test('re-pairing with the same user agent retires the old record', () => {
  const state = new GatewayState({ warn() {}, info() {} })
  const first = state.pair('', 'My Phone', { userAgent: UA, allowFirstPair: true })
  assert.equal(state.devices().length, 1)
  const oldToken = first.token

  state.rotateCode()
  const code = state.pairCode().value
  const second = state.pair(code, 'My Phone', { userAgent: UA })

  assert.equal(state.devices().length, 1, 'old same-UA record replaced')
  assert.equal(second.deviceName, 'My Phone', 'no (2) suffix accumulation')
  assert.equal(state.authenticate(oldToken), null, 'old token retired')
  assert.ok(state.authenticate(second.token), 'new token works')
})

test('re-pairing with a recovery code works anywhere and rotates the code', () => {
  const state = new GatewayState({ warn() {}, info() {} })
  state.pair('', 'Init', { userAgent: UA, allowFirstPair: true })
  const { code: recovery } = state.generateRecovery()
  assert.ok(state.hasRecovery())

  const paired = state.pair('', 'Emergency phone', { userAgent: UA + ' x', recoveryCode: recovery })
  assert.equal(paired.ok, true, 'recovery code pairs without the pairing code')
  assert.equal(paired.recoveryCode.length, 19, 'a fresh one-use recovery code is returned')

  // The old recovery code no longer works; the fresh one does.
  assert.equal(state.recoveryMatches(recovery), false)
  assert.ok(state.recoveryMatches(paired.recoveryCode))
})

test('recovery pairing retires same-UA records and requires no pairing code', () => {
  const state = new GatewayState({ warn() {}, info() {} })
  state.pair('', 'Init', { userAgent: UA, allowFirstPair: true })
  const { code: recovery } = state.generateRecovery()

  // No pairing code passed at all - the recovery code alone authorizes.
  const paired = state.pair('', 'Re-paired', { userAgent: UA, recoveryCode: recovery })
  assert.equal(paired.ok, true)
  assert.equal(state.devices().length, 1, 'same-UA ghost replaced')
})

test('a wrong recovery code is rejected and falls back to pairing-code rules', () => {
  const state = new GatewayState({ warn() {}, info() {} })
  state.pair('', 'Init', { userAgent: UA, allowFirstPair: true })
  state.generateRecovery()
  state.rotateCode()
  // Not first pair any more, recovery code wrong, no pairing code -> rejected.
  const paired = state.pair('', 'Intruder', { userAgent: 'Other', recoveryCode: '0000-0000-0000-0000' })
  assert.equal(paired.ok, false)
  assert.equal(paired.reason, 'code-invalid')
})

test('different user agents coexist as separate devices', () => {
  const state = new GatewayState({ warn() {}, info() {} })
  state.pair('', 'A', { userAgent: UA, allowFirstPair: true })
  state.rotateCode()
  const code = state.pairCode().value
  state.pair(code, 'B', { userAgent: 'Other/1.0' })
  assert.equal(state.devices().length, 2)
})

test('empty user agent legacy records are never cleaned', () => {
  const state = new GatewayState({ warn() {}, info() {} })
  state.pair('', 'legacy', { userAgent: '', allowFirstPair: true })
  state.rotateCode()
  const code = state.pairCode().value
  state.pair(code, 'new', { userAgent: UA })
  assert.equal(state.devices().length, 2, 'empty-UA record kept')
})

test('multiple same-UA records are all retired at once', () => {
  const state = new GatewayState({ warn() {}, info() {} })
  state.data.devices.push(
    { id: 'a', name: 'P1', tokenHash: 'h1', userAgent: UA, createdAt: 1, lastSeenAt: 1, seenPersistedAt: 1 },
    { id: 'b', name: 'P2', tokenHash: 'h2', userAgent: UA, createdAt: 2, lastSeenAt: 2, seenPersistedAt: 2 },
  )
  state.rotateCode()
  const code = state.pairCode().value
  state.pair(code, 'fresh', { userAgent: UA })
  assert.equal(state.devices().length, 1)
})

test('uniqueName dedupes against remaining records only', () => {
  const state = new GatewayState({ warn() {}, info() {} })
  state.pair('', 'Phone X', { userAgent: 'UA-1', allowFirstPair: true })
  state.rotateCode()
  state.rotateCode()
  const code = state.pairCode().value
  const second = state.pair(code, 'Phone X', { userAgent: 'UA-2' })
  assert.equal(second.deviceName, 'Phone X (2)')
})

// Each test gets a scratch DSH_HOME; no cross-test state leakage.
