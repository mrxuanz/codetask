import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../../src/server/bootstrap'
import { createApp } from '../../src/server'

function cookieValue(headers: Headers, name: string): string {
  const combined =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie().join('; ')
      : (headers.get('set-cookie') ?? '')
  const match = combined.match(new RegExp(`${name}=([^;,]+)`))
  assert.ok(match, `missing ${name} cookie`)
  return match[1] ?? ''
}

test('authenticated conversation API creates and switches four-Provider threads without model or secret settings', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-conversation-api-data-'))
  const folders = mkdtempSync(join(tmpdir(), 'codetask-conversation-api-folders-'))
  const runtime = createRuntime({
    dataDir,
    mode: 'desktop',
    authSecret: '33'.repeat(32)
  })
  t.after(async () => {
    await runtime.shutdown()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(folders, { recursive: true, force: true })
  })

  await runtime.ensureReady()
  const app = createApp(runtime.context, { isDev: false })
  const setup = await app.request('/api/setup', {
    method: 'POST',
    headers: { Host: 'localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Conversation_Admin',
      password: 'Strong Passw0rd!'
    })
  })
  assert.equal(setup.status, 200)

  const session = cookieValue(setup.headers, 'codetask_session')
  const csrf = cookieValue(setup.headers, 'codetask_csrf')
  const authHeaders = {
    Host: 'localhost',
    Cookie: `codetask_session=${session}; codetask_csrf=${csrf}`,
    'x-codetask-csrf': csrf,
    'Content-Type': 'application/json'
  }

  const mkdir = await app.request('/api/fs/mkdir', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ parentPath: folders, name: 'new-workspace' })
  })
  assert.equal(mkdir.status, 201)
  const mkdirBody = (await mkdir.json()) as {
    data: { path: string }
  }
  assert.equal(mkdirBody.data.path, realpathSync(join(folders, 'new-workspace')))

  const createWorkspace = await app.request('/api/conversation/workspaces', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ path: mkdirBody.data.path })
  })
  assert.equal(createWorkspace.status, 201)
  const createdWorkspaceBody = (await createWorkspace.json()) as { data: { id: string } }

  const settings = await app.request('/api/conversation/settings', {
    headers: { Host: 'localhost', Cookie: `codetask_session=${session}` }
  })
  assert.equal(settings.status, 200)
  const settingsBody = (await settings.json()) as { data: Record<string, unknown> }
  assert.deepEqual(Object.keys(settingsBody.data).sort(), ['provider', 'revision', 'updatedAtMs', 'userId'])
  assert.equal(settingsBody.data.provider, 'codex')
  assert.equal(JSON.stringify(settingsBody).toLowerCase().includes('key'), false)
  assert.equal(JSON.stringify(settingsBody).toLowerCase().includes('model'), false)

  const providers = await app.request('/api/conversation/providers', {
    headers: { Host: 'localhost', Cookie: `codetask_session=${session}` }
  })
  assert.equal(providers.status, 200)
  const providersBody = (await providers.json()) as {
    data: Array<{ code: string; protocol: string }>
  }
  assert.deepEqual(
    providersBody.data.map((provider) => [provider.code, provider.protocol]),
    [
      ['codex', 'sdk'],
      ['claude-code', 'sdk'],
      ['opencode', 'local-server'],
      ['cursorcli', 'acp']
    ]
  )

  const createThread = await app.request(
    `/api/conversation/workspaces/${createdWorkspaceBody.data.id}/threads`,
    {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ provider: 'claude-code' })
    }
  )
  assert.equal(createThread.status, 201)
  const threadBody = (await createThread.json()) as {
    data: { id: string; provider: string; runtimeSessionId: string | null }
  }
  assert.equal(threadBody.data.provider, 'claude-code')
  assert.equal('model' in threadBody.data, false)

  const switchProvider = await app.request(
    `/api/conversation/threads/${threadBody.data.id}`,
    {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ provider: 'opencode' })
    }
  )
  assert.equal(switchProvider.status, 200)
  const switchedBody = (await switchProvider.json()) as {
    data: { provider: string; runtimeSessionId: string | null }
  }
  assert.equal(switchedBody.data.provider, 'opencode')
  assert.equal(switchedBody.data.runtimeSessionId, null)

  const workspaces = await app.request('/api/conversation/workspaces', {
    headers: { Host: 'localhost', Cookie: `codetask_session=${session}` }
  })
  const workspaceBody = (await workspaces.json()) as { data: Array<{ title: string }> }
  assert.deepEqual(
    workspaceBody.data.map((item) => item.title),
    ['new-workspace']
  )
})
