import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openKernelDatabase } from '../../src/server/adapters/sqlite'
import { createDraftModule } from '../../src/server/composition/draft'
import { createProviderRegistry } from '../../src/server/providers/composition'
import type { ProviderDriver, ProviderTurnContext } from '../../src/server/providers/driver'
import { createPreparedProviderTurn } from '../../src/server/providers/delegating-driver'
import type { AgentTurnChunk } from '../../src/server/agent-runtime/types'

test('draft module uses the read-only planner and persists only a validated tree', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-draft-module-'))
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot)
  const database = openKernelDatabase({ filename: ':memory:' })
  database.client
    .prepare(
      `INSERT INTO auth_users
         (id, singleton_key, username, normalized_username, password_hash,
          password_version, created_at_ms, updated_at_ms)
       VALUES ('user-1', 1, 'Alice', 'alice', 'hash', 1, 1, 1)`
    )
    .run()
  const base = createProviderRegistry().get('cursorcli')
  const installation = {
    id: 'cursorcli:test',
    provider: 'cursorcli' as const,
    command: 'agent',
    source: 'path' as const,
    invocation: { executable: 'agent', prefixArgs: [] },
    resolvedPath: 'agent',
    canonicalPath: 'agent'
  }
  let captured: ProviderTurnContext | null = null
  const reply = JSON.stringify({
    schemaVersion: 1,
    title: 'Plan',
    summary: 'Validated plan',
    milestones: [
      {
        id: 'm1',
        title: 'Milestone',
        objective: 'Land the requested boundary.',
        successCriteria: 'The boundary is complete.',
        slices: [
          {
            id: 'm1-s1',
            title: 'Slice',
            objective: 'Add one vertical slice.',
            successCriteria: 'The slice is observable.',
            dependsOn: [],
            tasks: [
              {
                id: 'm1-s1-t1',
                title: 'Implement boundary',
                objective: 'Add the narrow implementation.',
                kind: 'general-implementation',
                estimatedMinutes: 10,
                files: ['src/example.ts'],
                dependsOn: [],
                acceptanceCriteria: ['The implementation exposes the requested behavior.'],
                attachmentIds: []
              }
            ]
          }
        ]
      }
    ]
  })
  const fakeDriver: ProviderDriver = {
    kind: 'test-fake',
    descriptor: base.descriptor,
    settings: base.settings,
    discover: async () => installation,
    installDirs: () => [],
    prepareAuth: ({ runtimeRoot }) => ({
      mode: 'host-identity',
      runtimeRoot,
      envPatch: {},
      readRoots: [],
      writeRoots: [],
      cleanupPlan: () => undefined,
      diagnostics: {
        provider: 'cursorcli',
        mode: 'host-identity',
        authMaterialPresent: true,
        warnings: []
      },
      filesystemProfile: {
        provider: 'cursorcli',
        hostReadRoots: [],
        hostWriteRoots: [],
        runtimeEnv: {},
        credentialSnapshots: [],
        scrubPatterns: []
      }
    }),
    preflight: () => undefined,
    supports: () => true,
    contributeSandboxPolicy: () => ({
      readRoots: [],
      writeRoots: [],
      environment: {},
      credentialSnapshots: []
    }),
    prepareTurn: async (turn) => {
      captured = turn
      return createPreparedProviderTurn({
        installation,
        turn,
        streamFactory: async function* (): AsyncGenerator<AgentTurnChunk> {
          yield { type: 'completed', reply, runtimeSessionId: null }
        }
      })
    }
  }
  const module = createDraftModule({
    database,
    runtimeRoot: join(root, 'runtime'),
    draftAssetsRoot: join(root, 'draft-assets'),
    jobIntakeAssetsRoot: join(root, 'job-intake-assets'),
    hostEnvironment: Object.freeze({ PATH: '/usr/bin', HOME: root }),
    cursorDriver: fakeDriver
  })
  t.after(async () => {
    await module.shutdown()
    database.close()
    rmSync(root, { recursive: true, force: true })
  })

  database.client
    .prepare(
      `INSERT INTO conversation_workspaces
         (id, user_id, title, root_path, canonical_key, created_at_ms, updated_at_ms)
       VALUES ('workspace-1', 'user-1', 'Workspace', ?, ?, 1, 1)`
    )
    .run(workspaceRoot, workspaceRoot)
  const draft = module.service.createDraft('user-1', {
    workspaceId: 'workspace-1',
    title: 'Feature',
    objective: 'Implement a feature.',
    requirements: 'Keep it narrow.',
    constraints: 'No environment configuration.',
    acceptanceCriteria: 'The feature is represented by a small tree.'
  })

  const events = []
  for await (const event of module.streamGeneration({
    userId: 'user-1',
    draftId: draft.id
  })) {
    events.push(event)
  }

  assert.deepEqual(
    events.map((event) => event.type),
    ['started', 'completed']
  )
  assert.equal(captured?.input.role, 'planner')
  assert.equal(captured?.input.capabilityProfile, 'planner-read')
  assert.match(captured?.input.systemPrompt ?? '', /Skills operating manual/)
  assert.match(captured?.input.systemPrompt ?? '', /Server-enforced output protocol/)
  const details = module.service.getDraft('user-1', draft.id)
  assert.equal(details.draft.status, 'tree_ready')
  assert.equal(details.executionTree?.tree.milestones[0]?.slices[0]?.tasks.length, 1)
  assert.deepEqual(database.client.prepare(`SELECT COUNT(*) AS n FROM job_intake_handoffs`).get(), {
    n: 0
  })
})

test('conversational Planner requires explicit confirmation before generating with its selected Provider', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'codetask-planner-conversation-'))
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot)
  const database = openKernelDatabase({ filename: ':memory:' })
  database.client
    .prepare(
      `INSERT INTO auth_users
         (id, singleton_key, username, normalized_username, password_hash,
          password_version, created_at_ms, updated_at_ms)
       VALUES ('user-1', 1, 'Alice', 'alice', 'hash', 1, 1, 1)`
    )
    .run()
  database.client
    .prepare(
      `INSERT INTO conversation_workspaces
         (id, user_id, title, root_path, canonical_key, created_at_ms, updated_at_ms)
       VALUES ('workspace-1', 'user-1', 'Workspace', ?, ?, 1, 1)`
    )
    .run(workspaceRoot, workspaceRoot)

  const base = createProviderRegistry().get('opencode')
  const installation = {
    id: 'opencode:test',
    provider: 'opencode' as const,
    command: 'opencode',
    source: 'path' as const,
    invocation: { executable: 'opencode', prefixArgs: [] },
    resolvedPath: 'opencode',
    canonicalPath: 'opencode'
  }
  const treeReply = JSON.stringify({
    schemaVersion: 1,
    title: 'Confirmed plan',
    summary: 'Generated only after the user confirmed the requirements.',
    milestones: [
      {
        id: 'm1',
        title: 'Milestone',
        objective: 'Deliver the confirmed change.',
        successCriteria: 'The confirmed acceptance criteria pass.',
        slices: [
          {
            id: 'm1-s1',
            title: 'Slice',
            objective: 'Implement one vertical slice.',
            successCriteria: 'The slice is observable.',
            dependsOn: [],
            tasks: [
              {
                id: 'm1-s1-t1',
                title: 'Implement confirmed change',
                objective: 'Implement only the confirmed scope.',
                kind: 'general-implementation',
                estimatedMinutes: 10,
                files: ['src/example.ts'],
                dependsOn: [],
                acceptanceCriteria: ['The confirmed behavior is covered.'],
                attachmentIds: []
              }
            ]
          }
        ]
      }
    ]
  })
  const replies = [
    JSON.stringify({
      schemaVersion: 1,
      message: '需求已经确认，可以生成执行树。',
      phase: 'ready',
      draft: {
        title: 'Confirmed feature',
        objective: 'Implement the feature discussed with the user.',
        requirements: 'Keep the change narrow and preserve existing behavior.',
        constraints: 'Do not use product environment variables.',
        acceptanceCriteria: 'The feature and its regression tests pass.'
      }
    }),
    treeReply
  ]
  const captured: ProviderTurnContext[] = []
  const fakeDriver: ProviderDriver = {
    kind: 'test-fake',
    descriptor: base.descriptor,
    settings: base.settings,
    discover: async () => installation,
    installDirs: () => [],
    prepareAuth: ({ runtimeRoot }) => ({
      mode: 'host-identity',
      runtimeRoot,
      envPatch: {},
      readRoots: [],
      writeRoots: [],
      cleanupPlan: () => undefined,
      diagnostics: {
        provider: 'opencode',
        mode: 'host-identity',
        authMaterialPresent: true,
        warnings: []
      },
      filesystemProfile: {
        provider: 'opencode',
        hostReadRoots: [],
        hostWriteRoots: [],
        runtimeEnv: {},
        credentialSnapshots: [],
        scrubPatterns: []
      }
    }),
    preflight: () => undefined,
    supports: () => true,
    contributeSandboxPolicy: () => ({
      readRoots: [],
      writeRoots: [],
      environment: {},
      credentialSnapshots: []
    }),
    prepareTurn: async (turn) => {
      captured.push(turn)
      const reply = replies.shift()
      assert.ok(reply, 'unexpected Provider turn')
      return createPreparedProviderTurn({
        installation,
        turn,
        streamFactory: async function* (): AsyncGenerator<AgentTurnChunk> {
          yield { type: 'completed', reply, runtimeSessionId: 'opencode-session-1' }
        }
      })
    }
  }
  const module = createDraftModule({
    database,
    runtimeRoot: join(root, 'runtime'),
    draftAssetsRoot: join(root, 'draft-assets'),
    jobIntakeAssetsRoot: join(root, 'job-intake-assets'),
    hostEnvironment: Object.freeze({ PATH: '/usr/bin', HOME: root }),
    registry: createProviderRegistry().withOverrides([fakeDriver])
  })
  t.after(async () => {
    await module.shutdown()
    database.close()
    rmSync(root, { recursive: true, force: true })
  })

  const session = module.startPlannerSession({
    userId: 'user-1',
    workspaceId: 'workspace-1',
    provider: 'opencode',
    initialPrompt: 'I need a small feature but need help clarifying it.'
  })
  assert.equal(session.thread.kind, 'planner')
  assert.equal(session.thread.provider, 'opencode')
  assert.equal(session.draft.plannerPhase, 'gathering')

  await assert.rejects(
    async () => {
      for await (const _event of module.streamGeneration({
        userId: 'user-1',
        draftId: session.draft.id
      })) {
        // The service must reject before a Provider turn starts.
      }
    },
    /draft\.requirements_not_confirmed/
  )
  assert.equal(captured.length, 0)

  const plannerEvents = []
  for await (const event of module.streamPlannerTurn({
    userId: 'user-1',
    draftId: session.draft.id,
    prompt: '我确认右侧显示的需求合同。'
  })) {
    plannerEvents.push(event)
  }
  assert.deepEqual(
    plannerEvents.map((event) => event.type),
    ['started', 'completed']
  )
  assert.equal(plannerEvents.at(-1)?.type, 'completed')
  assert.equal(
    plannerEvents.at(-1)?.type === 'completed'
      ? plannerEvents.at(-1)?.draft.plannerPhase
      : undefined,
    'ready'
  )
  assert.equal(captured[0]?.input.provider, 'opencode')
  assert.equal(captured[0]?.input.capabilityProfile, 'planner-read')
  assert.match(captured[0]?.input.systemPrompt ?? '', /strictly read-only/)
  assert.match(captured[0]?.input.systemPrompt ?? '', /explicit confirmation/)

  const generationEvents = []
  for await (const event of module.streamGeneration({
    userId: 'user-1',
    draftId: session.draft.id
  })) {
    generationEvents.push(event)
  }
  assert.deepEqual(
    generationEvents.map((event) => event.type),
    ['started', 'completed']
  )
  assert.equal(captured[1]?.input.provider, 'opencode')
  assert.equal(captured[1]?.input.capabilityProfile, 'planner-read')
  assert.equal(module.service.getDraft('user-1', session.draft.id).draft.status, 'tree_ready')
})
