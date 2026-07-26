import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { openKernelDatabase, SqliteUnitOfWork } from '../../../src/server/adapters/sqlite'
import { AuthError, type AuthErrorCode } from '../../../src/server/core/domain/auth'
import {
  SecureAuthService,
  type AuthSessionResult,
  type SecureAuthPolicy
} from '../../../src/server/core/application/auth'
import type {
  Clock,
  HumanChallengeGenerator,
  IdGenerator,
  PasswordHasher,
  SecureTokenService,
  SetupGrantVerifier
} from '../../../src/server/core/application/ports'

class FakeClock implements Clock {
  value = 1_000

  nowMs(): number {
    return this.value
  }
}

class FakeIds implements IdGenerator {
  private next = 0

  generate(): string {
    this.next += 1
    return `00000000-0000-4000-8000-${String(this.next).padStart(12, '0')}`
  }
}

class FakeTokens implements SecureTokenService {
  private next = 0

  generateToken(): string {
    this.next += 1
    return `token${String(this.next).padStart(38, '0')}`
  }

  digest(context: string, value: string): string {
    return createHash('sha256').update(`${context}\0${value}`).digest('hex')
  }

  equalsDigest(left: string, right: string): boolean {
    return left === right
  }
}

class FakePasswordHasher implements PasswordHasher {
  readonly verifiedHashes: Array<string | null> = []

  async hash(password: string): Promise<string> {
    return `fake$${password}`
  }

  async verify(
    password: string,
    encodedHash: string | null
  ): Promise<{ valid: boolean; needsRehash: boolean }> {
    this.verifiedHashes.push(encodedHash)
    return { valid: encodedHash === `fake$${password}`, needsRehash: false }
  }
}

class FakeChallenges implements HumanChallengeGenerator {
  generate(): { answer: string; publicPayload: string } {
    return { answer: 'ABC123', publicPayload: 'data:image/test;base64,c2FmZQ==' }
  }
}

class FakeSetupGrants implements SetupGrantVerifier {
  verify(grant: string): boolean {
    return grant === 'valid-setup-grant'
  }
}

const POLICY: SecureAuthPolicy = {
  requireSetupGrant: true,
  sessionTtlMs: 10_000,
  sessionTouchIntervalMs: 1_000,
  maxSessionsPerUser: 2,
  requestWindowMs: 1_000,
  maxLoginRequestsPerWindow: 20,
  failureWindowMs: 10_000,
  captchaAfterFailures: 2,
  lockoutAfterFailures: 3,
  lockoutScheduleMs: [1_000, 5_000],
  challengeTtlMs: 2_000,
  challengeMaxAttempts: 3,
  maxActiveChallenges: 10,
  maxChallengeRequestsPerWindow: 10,
  cleanupThrottleAgeMs: 20_000
}

function createHarness(): {
  database: ReturnType<typeof openKernelDatabase>
  clock: FakeClock
  passwordHasher: FakePasswordHasher
  service: SecureAuthService
} {
  const database = openKernelDatabase({ filename: ':memory:' })
  const clock = new FakeClock()
  const passwordHasher = new FakePasswordHasher()
  const service = new SecureAuthService({
    unitOfWork: new SqliteUnitOfWork(database),
    passwordHasher,
    tokens: new FakeTokens(),
    challenges: new FakeChallenges(),
    setupGrants: new FakeSetupGrants(),
    clock,
    ids: new FakeIds(),
    policy: POLICY
  })
  return { database, clock, passwordHasher, service }
}

async function setup(service: SecureAuthService): Promise<AuthSessionResult> {
  return service.setupAccount({
    username: 'Alice_Dev',
    password: 'Strong Passw0rd!',
    setupGrant: 'valid-setup-grant',
    requestScope: '127.0.0.1'
  })
}

function expectAuthCode(code: AuthErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof AuthError && error.code === code
}

describe('SecureAuthService', () => {
  it('enforces setup grant and credential policy without trimming passwords', async () => {
    const { database, service } = createHarness()
    try {
      await assert.rejects(
        service.setupAccount({
          username: 'Alice_Dev',
          password: 'Strong Passw0rd!',
          setupGrant: 'forged',
          requestScope: '127.0.0.1'
        }),
        expectAuthCode('auth.setup_grant_invalid')
      )
      await assert.rejects(
        service.setupAccount({
          username: 'Alice_Dev',
          password: 'short',
          setupGrant: 'valid-setup-grant',
          requestScope: '127.0.0.1'
        }),
        expectAuthCode('auth.password_policy_violation')
      )

      const result = await setup(service)
      assert.equal(result.username, 'Alice_Dev')
      assert.deepEqual(service.bootstrap(result.token), {
        initialized: true,
        authenticated: true,
        username: 'Alice_Dev'
      })
      assert.equal(
        database.client.prepare(`SELECT token_digest FROM auth_sessions WHERE id IS NOT NULL`).get()
          ?.token_digest === result.token,
        false
      )
      assert.equal(
        database.client.prepare(`SELECT password_hash FROM auth_users`).get()?.password_hash,
        'fake$Strong Passw0rd!'
      )
      await assert.rejects(
        service.setupAccount({
          username: 'Second_User',
          password: 'Another Passw0rd!',
          setupGrant: 'valid-setup-grant',
          requestScope: '127.0.0.2'
        }),
        expectAuthCode('auth.already_initialized')
      )
    } finally {
      database.close()
    }
  })

  it('uses a dummy password verification for unknown users', async () => {
    const { database, passwordHasher, service } = createHarness()
    try {
      await setup(service)
      await assert.rejects(
        service.login({
          username: 'Nobody',
          password: 'Strong Passw0rd!',
          requestScope: '127.0.0.1'
        }),
        expectAuthCode('auth.invalid_credentials')
      )
      assert.equal(passwordHasher.verifiedHashes.at(-1), null)
    } finally {
      database.close()
    }
  })

  it('persists failures, requires a scoped challenge, and locks repeated failures', async () => {
    const { database, service } = createHarness()
    try {
      const initial = await setup(service)
      service.logout(initial.token)

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          service.login({
            username: 'Alice_Dev',
            password: 'Wrong Passw0rd!',
            requestScope: '127.0.0.1'
          }),
          expectAuthCode('auth.invalid_credentials')
        )
      }
      await assert.rejects(
        service.login({
          username: 'Alice_Dev',
          password: 'Strong Passw0rd!',
          requestScope: '127.0.0.1'
        }),
        expectAuthCode('auth.challenge_required')
      )

      const challenge = service.issueChallenge('127.0.0.1')
      await assert.rejects(
        service.login({
          username: 'Alice_Dev',
          password: 'Wrong Passw0rd!',
          requestScope: '127.0.0.1',
          challengeId: challenge.challengeId,
          challengeAnswer: 'ABC123'
        }),
        (error: unknown) =>
          error instanceof AuthError &&
          error.code === 'auth.invalid_credentials' &&
          error.details.retryAfterMs === 1_000
      )
      await assert.rejects(
        service.login({
          username: 'Alice_Dev',
          password: 'Strong Passw0rd!',
          requestScope: '127.0.0.1'
        }),
        expectAuthCode('auth.rate_limited')
      )
    } finally {
      database.close()
    }
  })

  it('accepts a valid challenge, caps sessions, and supports logout all', async () => {
    const { database, clock, service } = createHarness()
    try {
      const first = await setup(service)
      service.logout(first.token)
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          service.login({
            username: 'Alice_Dev',
            password: 'Wrong Passw0rd!',
            requestScope: '127.0.0.1'
          }),
          expectAuthCode('auth.invalid_credentials')
        )
      }
      const challenge = service.issueChallenge('127.0.0.1')
      const second = await service.login({
        username: 'alice_dev',
        password: 'Strong Passw0rd!',
        requestScope: '127.0.0.1',
        challengeId: challenge.challengeId,
        challengeAnswer: 'abc123'
      })
      clock.value += 1
      const third = await service.login({
        username: 'Alice_Dev',
        password: 'Strong Passw0rd!',
        requestScope: '127.0.0.2'
      })
      clock.value += 1
      const fourth = await service.login({
        username: 'Alice_Dev',
        password: 'Strong Passw0rd!',
        requestScope: '127.0.0.3'
      })

      assert.equal(service.tryAuthenticate(second.token), null)
      assert.equal(service.authenticate(third.token).username, 'Alice_Dev')
      service.logoutAll(fourth.token)
      assert.equal(service.tryAuthenticate(third.token), null)
      assert.equal(service.tryAuthenticate(fourth.token), null)
    } finally {
      database.close()
    }
  })

  it('changes the password, revokes prior sessions, and issues a replacement session', async () => {
    const { database, service } = createHarness()
    try {
      const initial = await setup(service)
      const changed = await service.changePassword({
        token: initial.token,
        currentPassword: 'Strong Passw0rd!',
        newPassword: 'Different Passw0rd!'
      })

      assert.equal(service.tryAuthenticate(initial.token), null)
      assert.equal(service.authenticate(changed.token).username, 'Alice_Dev')
      await assert.rejects(
        service.login({
          username: 'Alice_Dev',
          password: 'Strong Passw0rd!',
          requestScope: '127.0.0.2'
        }),
        expectAuthCode('auth.invalid_credentials')
      )
      const loggedIn = await service.login({
        username: 'Alice_Dev',
        password: 'Different Passw0rd!',
        requestScope: '127.0.0.3'
      })
      assert.equal(service.authenticate(loggedIn.token).username, 'Alice_Dev')
    } finally {
      database.close()
    }
  })

  it('cleans expired sessions, challenges, and stale throttle state', async () => {
    const { database, clock, service } = createHarness()
    try {
      await setup(service)
      service.issueChallenge('127.0.0.1')
      await assert.rejects(
        service.login({
          username: 'Alice_Dev',
          password: 'Wrong Passw0rd!',
          requestScope: '127.0.0.1'
        }),
        expectAuthCode('auth.invalid_credentials')
      )
      clock.value += 30_000
      const result = service.cleanup()
      assert.ok(result.sessions >= 1)
      assert.ok(result.challenges >= 1)
      assert.ok(result.throttles >= 1)
    } finally {
      database.close()
    }
  })
})
