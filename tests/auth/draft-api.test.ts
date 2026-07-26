import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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

test('draft API edits settings and hands an attachment-safe snapshot to Job Intake', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-draft-api-data-'))
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'codetask-draft-api-workspace-'))
  const runtime = createRuntime({
    dataDir,
    mode: 'desktop',
    authSecret: '44'.repeat(32)
  })
  t.after(async () => {
    await runtime.shutdown()
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(workspaceRoot, { recursive: true, force: true })
  })
  await runtime.ensureReady()
  const app = createApp(runtime.context, { isDev: false })
  const setup = await app.request('/api/setup', {
    method: 'POST',
    headers: { Host: 'localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Draft_Admin', password: 'Strong Passw0rd!' })
  })
  const session = cookieValue(setup.headers, 'codetask_session')
  const csrf = cookieValue(setup.headers, 'codetask_csrf')
  const cookie = `codetask_session=${session}; codetask_csrf=${csrf}`
  const mutationHeaders = {
    Host: 'localhost',
    Cookie: cookie,
    'x-codetask-csrf': csrf,
    'Content-Type': 'application/json'
  }

  const workspaceResponse = await app.request('/api/conversation/workspaces', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ path: workspaceRoot })
  })
  const workspace = (await workspaceResponse.json()) as { data: { id: string } }

  const settingsResponse = await app.request('/api/draft-settings', {
    headers: { Host: 'localhost', Cookie: cookie }
  })
  const settings = (await settingsResponse.json()) as {
    data: {
      revision: number
      plannerPrompt: { value: string }
      skillsManual: { value: string }
    }
  }
  assert.match(settings.data.skillsManual.value, /Job intake boundary/i)
  assert.equal(JSON.stringify(settings).toLowerCase().includes('apikey'), false)

  const updateSettings = await app.request('/api/draft-settings', {
    method: 'PUT',
    headers: mutationHeaders,
    body: JSON.stringify({
      model: 'auto',
      plannerPrompt: 'Editable prompt',
      skillsManual: 'Editable Skills manual',
      expectedRevision: settings.data.revision
    })
  })
  assert.equal(updateSettings.status, 200)

  const createdResponse = await app.request('/api/drafts', {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({
      workspaceId: workspace.data.id,
      title: 'API draft',
      objective: 'Exercise the API boundary.',
      requirements: 'Persist and publish one plan.',
      constraints: 'Do not execute it.',
      acceptanceCriteria: 'The handoff stays pending.'
    })
  })
  assert.equal(createdResponse.status, 201)
  const created = (await createdResponse.json()) as {
    data: { id: string; revision: number }
  }

  const uploadBody = new FormData()
  uploadBody.set('expectedRevision', String(created.data.revision))
  uploadBody.set('file', new File(['reference'], 'reference.txt', { type: 'text/plain' }))
  const uploadedResponse = await app.request(`/api/drafts/${created.data.id}/attachments`, {
    method: 'POST',
    headers: {
      Host: 'localhost',
      Cookie: cookie,
      'x-codetask-csrf': csrf
    },
    body: uploadBody
  })
  assert.equal(uploadedResponse.status, 201)
  const uploaded = (await uploadedResponse.json()) as {
    data: { draft: { revision: number }; attachment: { id: string } }
  }

  const user = runtime.context.kernelDb.client
    .prepare(`SELECT id FROM auth_users LIMIT 1`)
    .get() as { id: string }
  const generation = runtime.context.draft.service.beginGeneration(user.id, created.data.id)
  const tree = {
    schemaVersion: 1 as const,
    title: 'API plan',
    summary: 'A pending plan.',
    milestones: [
      {
        id: 'm1',
        title: 'Boundary',
        objective: 'Define the boundary.',
        successCriteria: 'The handoff is self-contained.',
        slices: [
          {
            id: 'm1-s1',
            title: 'Intake',
            objective: 'Create the intake envelope.',
            successCriteria: 'The envelope and copy exist.',
            dependsOn: [],
            tasks: [
              {
                id: 'm1-s1-t1',
                title: 'Accept envelope',
                objective: 'Implement the future consumer.',
                kind: 'backend-implementation' as const,
                estimatedMinutes: 10,
                files: ['src/server/job/intake.ts'],
                dependsOn: [],
                acceptanceCriteria: ['The consumer accepts the immutable envelope.'],
                attachmentIds: [uploaded.data.attachment.id]
              }
            ]
          }
        ]
      }
    ]
  }
  const treeRecord = runtime.context.draft.service.completeGeneration(
    user.id,
    created.data.id,
    generation.run.id,
    tree,
    {
      plannerPrompt: generation.plannerPrompt,
      skillsManual: generation.skillsManual
    }
  )

  const confirmedResponse = await app.request(`/api/drafts/${created.data.id}/confirm`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({
      expectedRevision: uploaded.data.draft.revision,
      treeId: treeRecord.id
    })
  })
  assert.equal(confirmedResponse.status, 202)
  const confirmed = (await confirmedResponse.json()) as {
    data: { state: string; attachmentCount: number; jobModuleImplemented: boolean }
  }
  assert.deepEqual(confirmed.data, {
    ...confirmed.data,
    state: 'pending',
    attachmentCount: 1,
    jobModuleImplemented: false
  })

  const deletedResponse = await app.request(`/api/drafts/${created.data.id}`, {
    method: 'DELETE',
    headers: mutationHeaders
  })
  assert.equal(deletedResponse.status, 200)
  assert.deepEqual(
    runtime.context.kernelDb.client
      .prepare(`SELECT state FROM job_intake_handoffs WHERE source_draft_id = ?`)
      .get(created.data.id),
    { state: 'pending' }
  )
})
