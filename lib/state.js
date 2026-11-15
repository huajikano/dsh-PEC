import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_VERSION = 1
const CODE_TTL_MS = 10 * 60 * 1000
/** Persist `lastSeenAt` at most this often per device (never on every request). */
const SEEN_PERSIST_MS = 5 * 60 * 1000
/** Coalesce bursts of durable writes into one file replacement. */
const SAVE_DEBOUNCE_MS = 1500

const STATE_DIR = 'dsh-pec'
const LEGACY_STATE_DIR = 'cc-dsh'
let migrated = false

function stateDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dir = path.join(home, STATE_DIR)
  if (!migrated) {
    migrated = true
    // 2.0.0 renamed the package: carry the pairings over once so nobody has to
    // re-pair a phone after upgrading.
    try {
      const legacy = path.join(home, LEGACY_STATE_DIR)
      const next = path.join(dir, 'state.json')
      const previous = path.join(legacy, 'state.json')
      if (!fs.existsSync(next) && fs.existsSync(previous)) {
        fs.mkdirSync(dir, { recursive: true })
        fs.copyFileSync(previous, next)
        if (fs.existsSync(`${previous}.bak`)) fs.copyFileSync(`${previous}.bak`, `${next}.bak`)
      }
    } catch {
      /* best effort: a failed copy just means pairing again */
    }
  }
  return dir
}

function stateFile() {
  return path.join(stateDir(), 'state.json')
}

export function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex')
}

/** A human-friendly recovery code: four groups of four digits. */
function newRecoveryCode() {
  const groups = Array.from({ length: 4 }, () => String(crypto.randomInt(0, 10_000)).padStart(4, '0'))
  return groups.join('-')
}
function recoveryHash(code) {
  return crypto.createHash('sha256').update(String(code).trim()).digest('hex')
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url')
}

function newPairCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed && parsed.version === STATE_VERSION && Array.isArray(parsed.devices)) return parsed
  } catch {
    /* missing or unreadable */
  }
  return null
}

/**
 * Durable gateway state: identity and paired devices.
 *
 * The pairing code is deliberately memory-only: rotating it must never touch
 * the file that holds the device tokens, and every authenticated request used
 * to rewrite that file. Writes are now limited to real changes (pair, revoke,
 * rename, name) plus a throttled `lastSeenAt` flush.
 */
export class GatewayState {
  constructor(log) {
    this.log = log
    this.data = this.#load()
    // The pairing code is memory-only; drop any copy left by older versions.
    delete this.data.code
    this.code = null
    this.saveTimer = null
    this.authFailures = 0
  }

  #load() {
    const primary = readJson(stateFile())
    if (primary) return primary
    const backup = readJson(`${stateFile()}.bak`)
    if (backup) {
      this.log?.warn('state.json unreadable — restored the last backup')
      return backup
    }
    return {
      version: STATE_VERSION,
      serverId: crypto.randomUUID(),
      name: `${os.hostname() || 'DSH'} 的电脑`,
      devices: [],
      code: null,
      recoveryHash: null,
    }
  }

  /** Debounced durable write, coalescing bursts into one atomic replace. */
  #saveSoon() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.#save()
    }, SAVE_DEBOUNCE_MS)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  #save() {
    try {
      fs.mkdirSync(stateDir(), { recursive: true })
      const target = stateFile()
      const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      try {
        fs.copyFileSync(target, `${target}.bak`)
      } catch {
        /* first write */
      }
      fs.renameSync(tmp, target)
    } catch (error) {
      this.log?.warn('cannot persist state:', error?.message || error)
    }
  }

  get serverId() {
    return this.data.serverId
  }

  get name() {
    return this.data.name
  }

  set name(value) {
    this.data.name = String(value || '').slice(0, 60) || this.data.name
    this.#saveSoon()
  }

  devices() {
    return this.data.devices.map((device) => ({
      id: device.id,
      name: device.name,
      platform: device.platform || '',
      userAgent: device.userAgent || '',
      createdAt: device.createdAt || 0,
      lastSeenAt: device.lastSeenAt || 0,
    }))
  }

  /** Debug/self-check view; never includes token hashes. */
  snapshot() {
    return {
      serverId: this.data.serverId,
      name: this.data.name,
      devices: this.devices(),
      codeExpiresAt: this.code?.expiresAt || 0,
      codePersisted: Boolean(this.data.code),
      authFailures: this.authFailures,
      file: stateFile(),
    }
  }

  /** Current pairing code, rotated in memory only. */
  pairCode() {
    const now = Date.now()
    if (!this.code || this.code.expiresAt <= now) {
      this.code = { value: newPairCode(), expiresAt: now + CODE_TTL_MS }
    }
    return { value: this.code.value, expiresAt: this.code.expiresAt }
  }

  /** Generate (or regenerate) the recovery code. Plaintext is shown once. */
  generateRecovery() {
    const code = newRecoveryCode()
    this.data.recoveryHash = recoveryHash(code)
    this.#save()
    return { code }
  }

  /** Whether a recovery code has been set up. */
  hasRecovery() {
    return Boolean(this.data.recoveryHash)
  }

  /** Remove the recovery code. */
  clearRecovery() {
    this.data.recoveryHash = null
    this.#save()
  }

  /** Whether the given recovery code matches the stored hash. */
  recoveryMatches(code) {
    if (!this.data.recoveryHash || !code) return false
    const expected = Buffer.from(this.data.recoveryHash, 'hex')
    const given = Buffer.from(recoveryHash(code), 'hex')
    return expected.length === given.length && crypto.timingSafeEqual(expected, given)
  }

  /** A one-use recovery code is consumed: rotate it after successful use. */
  rotateRecovery() {
    if (!this.data.recoveryHash) return null
    const code = newRecoveryCode()
    this.data.recoveryHash = recoveryHash(code)
    this.#save()
    return code
  }

  rotateCode() {
    this.code = { value: newPairCode(), expiresAt: Date.now() + CODE_TTL_MS }
    return { ...this.code }
  }

  /** A readable, unique display name for a newly paired device. */
  #uniqueName(desired) {
    const base = String(desired || '手机').trim().slice(0, 40) || '手机'
    const taken = new Set(this.data.devices.map((device) => device.name))
    if (!taken.has(base)) return base
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${base} (${index})`
      if (!taken.has(candidate)) return candidate
    }
    return `${base} ${crypto.randomBytes(2).toString('hex')}`
  }

  /** Exchange a pairing code or a recovery code for a durable device token. */
  pair(code, deviceName, options = {}) {
    const nothingPairedYet = this.data.devices.length === 0
    const trustedFirstPair = nothingPairedYet && options.allowFirstPair === true

    // A recovery code (set up beforehand, printed by the owner) lets a phone
    // re-pair from anywhere - no need to read the pairing code off the screen.
    const viaRecovery = options.recoveryCode && this.recoveryMatches(options.recoveryCode)

    if (!trustedFirstPair && !viaRecovery) {
      const current = this.pairCode()
      const expected = Buffer.from(current.value)
      const given = Buffer.from(String(code ?? '').trim())
      if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        return { ok: false, reason: 'code-invalid' }
      }
    }

    // A phone that lost its browser storage re-pairs with the same user agent;
    // retire those old records so the device list does not accumulate ghosts.
    // Empty user agents (legacy or APK shell entries) cannot be matched
    // reliably and are left alone.
    const incomingUa = String(options.userAgent || '')
    if (incomingUa) {
      this.data.devices = this.data.devices.filter((device) => device.userAgent !== incomingUa)
    }

    const token = newToken()
    const device = {
      id: crypto.randomUUID(),
      name: this.#uniqueName(deviceName),
      tokenHash: hashCode(token),
      platform: String(options.platform || '').slice(0, 60),
      userAgent: String(options.userAgent || '').slice(0, 200),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      seenPersistedAt: Date.now(),
    }
    this.data.devices.push(device)
    // A pairing code is single use.
    this.rotateCode()
    // A recovery code is single use too: rotate it and return the fresh one
    // so the user can save it for the next emergency.
    const nextRecovery = viaRecovery ? this.rotateRecovery() : null
    this.#save()
    return {
      ok: true,
      token,
      deviceId: device.id,
      deviceName: device.name,
      serverName: this.name,
      ...(nextRecovery ? { recoveryCode: nextRecovery } : {}),
    }
  }

  authenticate(token) {
    if (!token) {
      this.authFailures += 1
      return null
    }
    const hash = hashCode(token)
    const device = this.data.devices.find((entry) => entry.tokenHash === hash)
    if (!device) {
      this.authFailures += 1
      return null
    }
    const now = Date.now()
    device.lastSeenAt = now
    // Persisting on every request is what used to clobber the device list; a
    // throttled flush keeps `lastSeenAt` useful without that risk.
    if (now - (device.seenPersistedAt || 0) > SEEN_PERSIST_MS) {
      device.seenPersistedAt = now
      this.#saveSoon()
    }
    return device
  }

  rename(deviceId, name) {
    const device = this.data.devices.find((entry) => entry.id === deviceId)
    if (!device) return false
    const next = String(name || '').trim().slice(0, 40)
    if (!next) return false
    device.name = next
    this.#save()
    return true
  }

  revoke(deviceId) {
    const before = this.data.devices.length
    this.data.devices = this.data.devices.filter((entry) => entry.id !== deviceId)
    if (this.data.devices.length === before) return false
    this.#save()
    return true
  }
}
