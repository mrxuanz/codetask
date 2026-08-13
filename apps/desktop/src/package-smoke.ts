import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { DesktopServiceHandle } from './desktop-service'

/** Packaged product probe kept separate from the production Electron shell lifecycle. */
export async function runPackagedSmoke(
  handle: DesktopServiceHandle,
  shutdown: () => Promise<void>
): Promise<void> {
  async function json<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const response = await fetch(`${handle.url}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-codetask-auth-transport': 'bearer',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers
      },
      signal: AbortSignal.timeout(15_000)
    })
    const body = (await response.json()) as {
      success?: boolean
      data?: T
      error?: { message?: string } | string
    }
    if (!response.ok || body.success !== true) {
      throw new Error(
        `Smoke ${path} failed with HTTP ${response.status}: ${JSON.stringify(body.error ?? body)}`
      )
    }
    return body.data as T
  }

  const health = await json<{ status: string }>('/api/health')
  if (health.status !== 'ok') throw new Error('Smoke health check returned an unexpected response')

  const credentials = { username: 'package-smoke', password: 'PackageSmoke-2026!Strong' }
  const setup = await json<{ token: string }>('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify(credentials)
  })
  await json('/api/auth/logout', { method: 'POST' }, setup.token)
  const login = await json<{ token: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials)
  })

  const workspaceRoot = join(app.getPath('userData'), 'package-smoke-workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  const project = await json<{ id: string }>(
    '/api/projects',
    {
      method: 'POST',
      body: JSON.stringify({
        title: 'Package smoke project',
        workspaceRoot,
        createIfMissing: true
      })
    },
    login.token
  )
  const conversation = await json<{ id: string }>(
    `/api/projects/${encodeURIComponent(project.id)}/conversations`,
    {
      method: 'POST',
      body: JSON.stringify({ title: 'Package smoke conversation', providerCode: 'codex' })
    },
    login.token
  )
  const turn = await json<{ turnId: string }>(
    `/api/conversations/${encodeURIComponent(conversation.id)}/turns`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: 'Reply to the packaged smoke test.',
        attachmentIds: [],
        idempotencyKey: 'package-smoke-turn-1',
        providerCode: 'codex'
      })
    },
    login.token
  )

  let turnStatus = ''
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await json<{ state: string }>(
      `/api/conversations/${encodeURIComponent(conversation.id)}/turns/${encodeURIComponent(turn.turnId)}`,
      {},
      login.token
    )
    turnStatus = current.state
    if (turnStatus === 'completed') break
    if (turnStatus === 'failed' || turnStatus === 'cancelled') {
      throw new Error(`Packaged conversation smoke ended in ${turnStatus}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (turnStatus !== 'completed') throw new Error('Packaged conversation smoke timed out')

  const messages = await json<Array<{ role: string; content: string }>>(
    `/api/conversations/${encodeURIComponent(conversation.id)}/messages?limit=20`,
    {},
    login.token
  )
  if (
    !messages.some(
      (message) => message.role === 'assistant' && /smoke reply/i.test(message.content)
    )
  ) {
    throw new Error('Packaged conversation smoke did not persist the assistant reply')
  }

  console.log(
    `CODETASK_SMOKE_READY ${JSON.stringify({
      url: handle.url,
      health: 'ok',
      account: 'setup-login-ok',
      conversation: 'reply-ok',
      instanceId: handle.instanceId
    })}`
  )
  await shutdown()
  app.exit(0)
}
