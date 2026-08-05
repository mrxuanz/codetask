import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import type { AppDatabase } from '../../src/server/db'
import { migration040DestructiveAuthCurrent } from '../../packages/database/src/migrations/v001_042/040_destructive_auth_current.ts'
import { migration041AuthSecretSqlite } from '../../packages/database/src/migrations/v001_042/041_auth_secret_sqlite.ts'
import { readSqliteAuthSecret } from '../../src/server/auth/secret'
import { SecureAuthService } from '../../src/server/auth/service'
import type { AppContext } from '../../src/server/context'
import { createAuthRoutes } from '../../src/server/routes/auth'
import { NodeSqliteAdapter } from '../helpers/node-sqlite-adapter'

const USERNAME = 'ops_user'
const PASSWORD = 'ValidPass1!'

async function withAuth(
  run: (auth: SecureAuthService, client: NodeSqliteAdapter, authSecret: string) => Promise<void>
): Promise<void> {
  const client = new NodeSqliteAdapter()
  try {
    migration040DestructiveAuthCurrent.up(client as never)
    migration041AuthSecretSqlite.up(client as never)
    const authSecret = readSqliteAuthSecret(client as never)
    const db = { $client: client } as unknown as AppDatabase
    await run(new SecureAuthService(db, authSecret), client, authSecret)
  } finally {
    client.close()
  }
}

test('sessions are multi-device and only HMAC digests are persisted', async () => {
  await withAuth(async (auth, client) => {
    const first = await auth.setup(USERNAME, PASSWORD)
    const second = await auth.login({
      username: USERNAME,
      password: PASSWORD,
      clientIp: '127.0.0.1'
    })

    assert.notEqual(first.token, second.token)
    assert.equal(auth.authenticateToken(first.token)?.username, USERNAME)
    assert.equal(auth.authenticateToken(second.token)?.username, USERNAME)

    const rows = client.prepare(`SELECT token_digest FROM auth_sessions`).all() as Array<{
      token_digest: string
    }>
    assert.equal(rows.length, 2)
    assert.equal(
      rows.some((row) => row.token_digest === first.token),
      false
    )
    assert.equal(
      rows.some((row) => row.token_digest === second.token),
      false
    )

    auth.logout(first.token)
    assert.equal(auth.authenticateToken(first.token), null)
    assert.equal(auth.authenticateToken(second.token)?.username, USERNAME)
  })
})

test('login failures are scoped and persisted without a global account lock', async () => {
  await withAuth(async (auth, client) => {
    await auth.setup(USERNAME, PASSWORD)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        auth.login({
          username: USERNAME,
          password: 'WrongPass1!',
          clientIp: '10.0.0.1'
        })
      )
    }

    const rows = client
      .prepare(
        `SELECT failure_count, captcha_required FROM auth_throttles WHERE key LIKE 'login:%'`
      )
      .all() as Array<{ failure_count: number; captcha_required: number }>
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.failure_count, 3)
    assert.equal(rows[0]?.captcha_required, 1)

    const valid = await auth.login({
      username: USERNAME,
      password: PASSWORD,
      clientIp: '10.0.0.2'
    })
    assert.equal(auth.authenticateToken(valid.token)?.username, USERNAME)
  })
})

test('captcha challenges are scoped, attempt-limited, and cleaned by the auth janitor', async () => {
  await withAuth(async (auth, client) => {
    const challenge = auth.generateCaptcha('192.0.2.1')
    assert.ok(challenge.challengeId.startsWith('cpt_'))
    assert.ok(challenge.image.startsWith('data:image/svg+xml;base64,'))
    assert.equal(auth.verifyCaptchaForClient(challenge.challengeId, 'WRONG', '192.0.2.1'), false)
    const row = client
      .prepare(`SELECT attempts FROM auth_challenges WHERE id = ?`)
      .get(challenge.challengeId) as { attempts: number }
    assert.equal(row.attempts, 1)

    client
      .prepare(`UPDATE auth_challenges SET expires_at_ms = ? WHERE id = ?`)
      .run(Date.now() - 1, challenge.challengeId)
    auth.cleanup()
    const count = client.prepare(`SELECT count(*) AS count FROM auth_challenges`).get() as {
      count: number
    }
    assert.equal(count.count, 0)
  })
})

test('Hono browser auth returns HttpOnly cookies while Bearer tokens require opt-in', async () => {
  await withAuth(async (auth, _client, authSecret) => {
    const app = new Hono()
    app.route(
      '/api/auth',
      createAuthRoutes({
        security: {
          mode: 'desktop',
          authSecret,
          auth
        }
      } as AppContext)
    )

    const setup = await app.request('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD })
    })
    assert.equal(setup.status, 200)
    const setupBody = (await setup.json()) as {
      data: {
        actor?: { userId: string; username: string; sessionExpiresAt: number }
        token?: string
      }
    }
    assert.equal(setupBody.data.actor?.username, USERNAME)
    assert.ok(setupBody.data.actor?.userId)
    assert.equal(setupBody.data.token, undefined)
    const cookies = setup.headers.get('set-cookie') ?? ''
    assert.match(cookies, /codetask_session=/)
    assert.match(cookies, /HttpOnly/i)
    assert.match(cookies, /codetask_csrf=/)

    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codetask-auth-transport': 'bearer'
      },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD })
    })
    assert.equal(login.status, 200)
    const loginBody = (await login.json()) as {
      data: { token?: string; actor?: { username: string } }
    }
    assert.ok(loginBody.data.token)
    assert.equal(loginBody.data.actor?.username, USERNAME)
  })
})
