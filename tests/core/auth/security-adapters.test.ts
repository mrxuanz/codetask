import assert from 'node:assert/strict'
import { scrypt } from 'node:crypto'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'
import {
  HmacSetupGrantService,
  HmacTokenService,
  NodePasswordHasher,
  SvgHumanChallengeGenerator
} from '../../../src/server/adapters/security'

const SECRET = Buffer.alloc(32, 7)
const scryptAsync = promisify(scrypt)

describe('secure authentication adapters', () => {
  it('hashes and verifies passwords using a versioned bounded scrypt format', async () => {
    const hasher = new NodePasswordHasher()
    const encoded = await hasher.hash('Strong Passw0rd!')

    assert.match(encoded, /^scrypt\$v=1\$N=32768\$r=8\$p=1\$/)
    assert.deepEqual(await hasher.verify('Strong Passw0rd!', encoded), {
      valid: true,
      needsRehash: false
    })
    assert.equal((await hasher.verify('wrong', encoded)).valid, false)
    assert.equal((await hasher.verify('wrong', null)).valid, false)
    assert.equal((await hasher.verify('wrong', 'malformed')).valid, false)
  })

  it('verifies the legacy text-salt format and requests an immediate rehash', async () => {
    const hasher = new NodePasswordHasher()
    const password = 'Legacy Passw0rd!'
    const salt = '00112233445566778899aabbccddeeff'
    const derived = (await scryptAsync(password, salt, 64)) as Buffer
    const encoded = `v1:${salt}:${derived.toString('hex')}`

    assert.deepEqual(await hasher.verify(password, encoded), {
      valid: true,
      needsRehash: true
    })
    assert.equal((await hasher.verify('wrong', encoded)).valid, false)
  })

  it('generates opaque tokens and context-separated digests', () => {
    const tokens = new HmacTokenService(SECRET)
    const token = tokens.generateToken()

    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(tokens.digest('session', token).length, 64)
    assert.notEqual(tokens.digest('session', token), tokens.digest('challenge', token))
  })

  it('rejects forged, expired, overlong, and future-dated setup grants', () => {
    const grants = new HmacSetupGrantService(SECRET)
    const issued = grants.issue(1_000, 10_000)

    assert.equal(grants.verify(issued.grant, 2_000), true)
    assert.equal(grants.verify(`${issued.grant}x`, 2_000), false)
    assert.equal(grants.verify(issued.grant, 11_000), false)

    const future = grants.issue(100_000, 10_000)
    assert.equal(grants.verify(future.grant, 1_000), false)
  })

  it('uses cryptographic randomness and emits a bounded SVG data payload', () => {
    const generator = new SvgHumanChallengeGenerator()
    const first = generator.generate()
    const second = generator.generate()

    assert.match(first.answer, /^[A-HJ-NP-Z2-9]{6}$/)
    assert.match(first.publicPayload, /^data:image\/svg\+xml;base64,/)
    assert.ok(first.publicPayload.length < 128 * 1024)
    assert.notEqual(first.answer, second.answer)
  })
})
