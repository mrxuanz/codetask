import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../../src/server/bootstrap'
import { createApp } from '../../src/server'
import type { JobItemExecutor } from '../../src/server/composition/job'

function cookieValue(headers: Headers, name: string): string {
  const combined =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie().join('; ')
      : (headers.get('set-cookie') ?? '')
  const match = combined.match(new RegExp(`${name}=([^;,]+)`))
  assert.ok(match, `missing ${name} cookie`)
  return match[1] ?? ''
}

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('test.wait_timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('draft API hands an image-safe snapshot through all SDK/ACP Job actors', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-draft-api-data-'))
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'codetask-draft-api-workspace-'))
  const actors: string[] = []
  const jobExecutor: JobItemExecutor = async (input) => {
    actors.push(`${input.item.providerCode}:${input.item.kind}`)
    if (input.item.kind === 'work') {
      return JSON.stringify({
        status: 'completed',
        summary: 'Implemented the bounded Work.',
        changedFiles: ['src/server/job/intake.ts'],
        evidence: ['fake E2E executor completed the Work']
      })
    }
    return JSON.stringify({
      status: 'passed',
      summary: 'The read-only gate passed.',
      evidence: ['fake E2E verifier observed the expected state'],
      repairTasks: []
    })
  }
  const runtime = createRuntime({
    dataDir,
    mode: 'desktop',
    authSecret: '44'.repeat(32),
    jobExecutor
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

  const jobSettingsResponse = await app.request('/api/job-settings', {
    headers: { Host: 'localhost', Cookie: cookie }
  })
  assert.equal(jobSettingsResponse.status, 200)
  const jobSettings = (await jobSettingsResponse.json()) as {
    data: {
      settings: {
        maxConcurrentJobs: number
        work: { provider: string; prompt: string; skillsManual: string }
        workValidation: { provider: string; enabled: boolean }
        sliceValidation: { provider: string; enabled: boolean }
        milestoneValidation: { provider: string; enabled: boolean }
      }
    }
  }
  assert.equal(jobSettings.data.settings.maxConcurrentJobs, 2)
  assert.equal(jobSettings.data.settings.work.provider, 'codex')
  assert.match(jobSettings.data.settings.work.skillsManual, /untrusted project data/i)
  assert.equal(JSON.stringify(jobSettings).toLowerCase().includes('apikey'), false)

  const providersResponse = await app.request('/api/job-providers', {
    headers: { Host: 'localhost', Cookie: cookie }
  })
  assert.equal(providersResponse.status, 200)
  const providers = (await providersResponse.json()) as {
    data: Array<{
      code: string
      protocol: string
      supportsTask: boolean
      supportsVerification: boolean
    }>
  }
  assert.deepEqual(
    providers.data.map((provider) => [provider.code, provider.protocol]),
    [
      ['codex', 'sdk'],
      ['claude-code', 'sdk'],
      ['opencode', 'local-server'],
      ['cursorcli', 'acp']
    ]
  )
  assert.ok(
    providers.data.every((provider) => provider.supportsTask && provider.supportsVerification)
  )

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
      constraints: 'Do not use environment variables.',
      acceptanceCriteria: 'The handed-off Job runs all configured gates.'
    })
  })
  assert.equal(createdResponse.status, 201)
  const created = (await createdResponse.json()) as {
    data: { id: string; revision: number }
  }

  const uploadBody = new FormData()
  uploadBody.set('expectedRevision', String(created.data.revision))
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )
  uploadBody.set('file', new File([onePixelPng], 'reference.png', { type: 'image/png' }))
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
    data: {
      handoff: { state: string; attachmentCount: number; jobModuleImplemented: boolean }
      job: { id: string; state: string; totalItems: number }
    }
  }
  assert.deepEqual(confirmed.data.handoff, {
    ...confirmed.data.handoff,
    state: 'pending',
    attachmentCount: 1,
    jobModuleImplemented: true
  })
  assert.equal(confirmed.data.job.totalItems, 4)

  await waitFor(
    () => runtime.context.job.service.getJob(user.id, confirmed.data.job.id).state === 'succeeded'
  )
  assert.deepEqual(actors, [
    'codex:work',
    'claude-code:work_validation',
    'opencode:slice_validation',
    'cursorcli:milestone_validation'
  ])
  assert.deepEqual(
    runtime.context.kernelDb.client
      .prepare(`SELECT display_name, media_type FROM job_attachments WHERE job_id = ?`)
      .get(confirmed.data.job.id),
    { display_name: 'reference.png', media_type: 'image/png' }
  )

  const jobsResponse = await app.request('/api/jobs', {
    headers: { Host: 'localhost', Cookie: cookie }
  })
  assert.equal(jobsResponse.status, 200)
  const jobs = (await jobsResponse.json()) as {
    data: Array<{ id: string; state: string; completedItems: number; totalItems: number }>
  }
  assert.deepEqual(jobs.data, [
    {
      ...jobs.data[0],
      id: confirmed.data.job.id,
      state: 'succeeded',
      completedItems: 4,
      totalItems: 4
    }
  ])

  const jobDetailResponse = await app.request(`/api/jobs/${confirmed.data.job.id}`, {
    headers: { Host: 'localhost', Cookie: cookie }
  })
  assert.equal(jobDetailResponse.status, 200)
  const jobDetail = (await jobDetailResponse.json()) as {
    data: {
      state: string
      items: Array<{ sequence: number; state: string; repairGeneration: number }>
    }
  }
  assert.equal(jobDetail.data.state, 'succeeded')
  assert.deepEqual(
    jobDetail.data.items.map((item) => [item.sequence, item.state, item.repairGeneration]),
    [
      [1, 'succeeded', 0],
      [2, 'succeeded', 0],
      [3, 'succeeded', 0],
      [4, 'succeeded', 0]
    ]
  )

  const deletedResponse = await app.request(`/api/drafts/${created.data.id}`, {
    method: 'DELETE',
    headers: mutationHeaders
  })
  assert.equal(deletedResponse.status, 200)
  assert.deepEqual(
    runtime.context.kernelDb.client
      .prepare(`SELECT state FROM job_intake_handoffs WHERE source_draft_id = ?`)
      .get(created.data.id),
    { state: 'accepted' }
  )
})
