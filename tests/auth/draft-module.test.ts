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
