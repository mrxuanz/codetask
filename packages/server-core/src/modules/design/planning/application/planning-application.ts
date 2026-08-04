import type {
  DraftSnapshot,
  ExecutionTreeSnapshot,
  JobAccepted,
  JobSubmission,
  PatchTreeNodeBody,
  PlanningSessionStatus,
  ReferenceManifest,
  DesignSettingsSnapshot,
  ExecutionSettingsSnapshot
} from '@codetask/contracts'
import type { DesignRealtimeEventName } from '@codetask/contracts'
import {
  allNodesConfirmed,
  assertTransition,
  isActivePlanningStatus,
  type PlanningRunRecord,
  type PlanningSessionRecord
} from '../domain/planning.ts'
import {
  DesignConflictError,
  DesignForbiddenError,
  DesignNotFoundError,
  DesignValidationError,
  newId,
  nowMs,
  stableHash,
  type Actor
} from '../../shared.ts'

export interface PlanningCapacityPort {
  acquire(input: { planningSessionId: string; pool: string }): Promise<{ leaseId: string } | null>
  release(leaseId: string): Promise<void>
}

export interface JobSubmissionPort {
  accept(submission: JobSubmission): Promise<JobAccepted>
}

export interface PlanningEventPort {
  publish(sessionId: string, event: DesignRealtimeEventName, payload: Record<string, unknown>): void
}

export interface PlanningRepository {
  getSession(sessionId: string): Promise<PlanningSessionRecord | null>
  listActiveForDraft(draftId: string): Promise<PlanningSessionRecord[]>
  insertSession(session: PlanningSessionRecord): Promise<void>
  updateSession(
    session: PlanningSessionRecord,
    expectedTreeRevision?: number
  ): Promise<PlanningSessionRecord>
  insertRun(run: PlanningRunRecord): Promise<void>
  updateRun(run: PlanningRunRecord): Promise<void>
  getRun(runId: string): Promise<PlanningRunRecord | null>
  saveReferenceSnapshot(input: {
    id: string
    draftId: string
    draftLockRevision: number
    manifest: ReferenceManifest
    contentHash: string
    createdAt: number
  }): Promise<void>
  getReferenceManifest(snapshotId: string): Promise<ReferenceManifest | null>
  saveTree(input: {
    planId: string
    sessionId: string
    tree: ExecutionTreeSnapshot
    contentHash: string
  }): Promise<void>
  getTree(sessionId: string): Promise<ExecutionTreeSnapshot | null>
  insertHandoff(input: {
    submissionId: string
    planningSessionId: string
    idempotencyKey: string
    payloadJson: string
    createdAt: number
  }): Promise<{ created: boolean; existingJobId: string | null }>
  markHandoffAccepted(input: {
    submissionId: string
    jobId: string
    acceptedAt: number
  }): Promise<void>
  findHandoffByIdempotency(key: string): Promise<{
    submissionId: string
    status: string
    jobId: string | null
    payloadJson: string
  } | null>
}

export interface PlannerRunnerPort {
  run(input: {
    sessionId: string
    runId: string
    fencingToken: string
    draftSnapshot: DraftSnapshot
    referenceManifest: ReferenceManifest
    executionProfile: { plannerCoreCode: string }
    plannerSettingsSnapshotJson?: string
  }): Promise<void>
}

export type PlanningSettingsPort = {
  capturePlannerSettings?: (providerCode: string) => DesignSettingsSnapshot
  captureExecutionSettings?: (
    taskProvider: string,
    verificationProvider: string
  ) => ExecutionSettingsSnapshot
}

function plannerSettingsHash(snapshot: DesignSettingsSnapshot): string {
  return stableHash(
    JSON.stringify({
      plannerProvider: snapshot.plannerProvider,
      promptBody: snapshot.promptBody,
      mcpServers: snapshot.mcpServers,
      sourceRevisions: snapshot.sourceRevisions
    })
  )
}

function executionSettingsHash(snapshot: ExecutionSettingsSnapshot): string {
  return stableHash(
    JSON.stringify({
      taskMcpServers: snapshot.taskMcpServers,
      verificationMcpServers: snapshot.verificationMcpServers,
      sliceVerifierPromptBody: snapshot.sliceVerifierPromptBody,
      milestoneVerifierPromptBody: snapshot.milestoneVerifierPromptBody,
      sourceRevisions: snapshot.sourceRevisions
    })
  )
}

function firstTaskCoreCode(tree: ExecutionTreeSnapshot): string {
  for (const milestone of tree.milestones) {
    for (const slice of milestone.slices) {
      for (const task of slice.tasks) {
        const code = task.coreCode?.trim()
        if (code) return code
      }
    }
  }
  return 'codex'
}

export class PlanningApplication {
  constructor(
    private readonly repo: PlanningRepository,
    private readonly capacity: PlanningCapacityPort,
    private readonly jobSubmission: JobSubmissionPort,
    private readonly events: PlanningEventPort,
    private readonly planner: PlannerRunnerPort,
    private readonly settings: PlanningSettingsPort = {}
  ) {}

  async listForDraft(actor: Actor, draftId: string): Promise<PlanningSessionRecord[]> {
    // Ownership: draft actor checked by caller or via session actorId filter.
    const sessions = await this.repo.listActiveForDraft(draftId)
    return sessions.filter((s) => s.actorId === actor.userId)
  }

  async get(
    actor: Actor,
    sessionId: string
  ): Promise<{
    session: PlanningSessionRecord
    tree: ExecutionTreeSnapshot | null
  }> {
    const session = await this.requireOwned(actor, sessionId)
    const tree = await this.repo.getTree(sessionId)
    return { session, tree }
  }

  async createSession(input: {
    actor: Actor
    draftSnapshot: DraftSnapshot
    references: ReferenceManifest['references']
  }): Promise<PlanningSessionRecord> {
    const { actor, draftSnapshot } = input
    if (!draftSnapshot.executionProfile) {
      throw new DesignValidationError('Execution profile required')
    }
    const existing = await this.repo.listActiveForDraft(draftSnapshot.draftId)
    if (existing.some((s) => isActivePlanningStatus(s.status))) {
      throw new DesignValidationError('Draft already has an active planning session')
    }

    const now = nowMs()
    const snapshotId = newId('refsnap')
    const manifest: ReferenceManifest = {
      snapshotId,
      draftId: draftSnapshot.draftId,
      draftLockRevision: draftSnapshot.lockRevision,
      contentHash: stableHash(JSON.stringify(input.references)),
      references: input.references,
      createdAt: new Date(now).toISOString()
    }
    await this.repo.saveReferenceSnapshot({
      id: snapshotId,
      draftId: draftSnapshot.draftId,
      draftLockRevision: draftSnapshot.lockRevision,
      manifest,
      contentHash: manifest.contentHash,
      createdAt: now
    })

    const plannerProvider = draftSnapshot.executionProfile.plannerCoreCode
    const plannerSnapshot = this.settings.capturePlannerSettings?.(plannerProvider)

    const session: PlanningSessionRecord = {
      id: newId('plan'),
      actorId: actor.userId,
      projectId: draftSnapshot.projectId,
      sourceDraftId: draftSnapshot.draftId,
      draftSnapshotJson: JSON.stringify(draftSnapshot),
      referenceSnapshotId: snapshotId,
      executionProfile: draftSnapshot.executionProfile,
      plannerSettingsSnapshotJson: plannerSnapshot ? JSON.stringify(plannerSnapshot) : '{}',
      plannerSettingsHash: plannerSnapshot ? plannerSettingsHash(plannerSnapshot) : '',
      status: 'queued',
      activeRunId: null,
      treeRevision: 0,
      publishedJobId: null,
      lastErrorJson: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: null
    }
    await this.repo.insertSession(session)
    this.events.publish(session.id, 'planning.changed', { status: session.status })
    void this.startPlanning(actor, session.id)
    return session
  }

  async startPlanning(actor: Actor, sessionId: string): Promise<void> {
    const session = await this.requireOwned(actor, sessionId)
    if (session.status !== 'queued' && session.status !== 'failed') {
      return
    }
    assertTransition(session.status === 'failed' ? 'failed' : 'queued', 'planning')

    const lease = await this.capacity.acquire({
      planningSessionId: session.id,
      pool: 'planner'
    })
    if (!lease) {
      throw new DesignValidationError('Planning capacity unavailable')
    }

    const runId = newId('prun')
    const fencingToken = newId('fence')
    const now = nowMs()
    await this.repo.insertRun({
      id: runId,
      planningSessionId: session.id,
      status: 'running',
      attemptNo: 1,
      provider: session.executionProfile.plannerCoreCode,
      model: null,
      fencingToken,
      startedAt: now,
      finishedAt: null,
      errorJson: null
    })

    const next = {
      ...session,
      status: 'planning' as PlanningSessionStatus,
      activeRunId: runId,
      updatedAt: now,
      lastErrorJson: null
    }
    await this.repo.updateSession(next)
    this.events.publish(session.id, 'planning.progress', { status: 'planning', runId })

    const draftSnapshot = JSON.parse(session.draftSnapshotJson) as DraftSnapshot
    const manifest = session.referenceSnapshotId
      ? await this.repo.getReferenceManifest(session.referenceSnapshotId)
      : null
    if (!manifest) {
      await this.failSession(session.id, 'Missing reference manifest')
      await this.capacity.release(lease.leaseId)
      return
    }

    try {
      await this.planner.run({
        sessionId: session.id,
        runId,
        fencingToken,
        draftSnapshot,
        referenceManifest: manifest,
        executionProfile: session.executionProfile,
        plannerSettingsSnapshotJson: session.plannerSettingsSnapshotJson
      })
    } catch (error) {
      await this.failSession(session.id, error instanceof Error ? error.message : String(error))
    } finally {
      await this.capacity.release(lease.leaseId)
    }
  }

  async retry(actor: Actor, sessionId: string): Promise<PlanningSessionRecord> {
    const session = await this.requireOwned(actor, sessionId)
    assertTransition(session.status, 'queued')
    const next = {
      ...session,
      status: 'queued' as const,
      updatedAt: nowMs(),
      lastErrorJson: null
    }
    const saved = await this.repo.updateSession(next)
    void this.startPlanning(actor, sessionId)
    return saved
  }

  async cancel(actor: Actor, sessionId: string): Promise<PlanningSessionRecord> {
    const session = await this.requireOwned(actor, sessionId)
    if (session.status === 'published') {
      throw new DesignValidationError('Published session cannot be cancelled')
    }
    const next = {
      ...session,
      status: 'cancelled' as const,
      updatedAt: nowMs()
    }
    const saved = await this.repo.updateSession(next)
    this.events.publish(sessionId, 'planning.changed', { status: 'cancelled' })
    return saved
  }

  async regenerate(actor: Actor, sessionId: string): Promise<PlanningSessionRecord> {
    const session = await this.requireOwned(actor, sessionId)
    assertTransition(session.status, 'queued')
    const next = {
      ...session,
      status: 'queued' as const,
      treeRevision: session.treeRevision,
      updatedAt: nowMs()
    }
    const saved = await this.repo.updateSession(next)
    void this.startPlanning(actor, sessionId)
    return saved
  }

  /** Partial planner progress while MCP outline/contexts are filling in. */
  notifyPlannerProgress(input: {
    sessionId: string
    contextsRegistered: number
    contextsTotal: number
    milestones: number
    slices: number
    tasks: number
  }): void {
    this.events.publish(input.sessionId, 'planning.progress', {
      status: 'planning',
      contextsRegistered: input.contextsRegistered,
      contextsTotal: input.contextsTotal,
      milestones: input.milestones,
      slices: input.slices,
      tasks: input.tasks
    })
  }

  /** Called by Planner MCP via PlanningApplicationPort after finalize. */
  async commitExecutionTree(input: {
    sessionId: string
    fencingToken: string
    tree: ExecutionTreeSnapshot
  }): Promise<void> {
    const session = await this.repo.getSession(input.sessionId)
    if (!session) throw new DesignNotFoundError('Planning session not found')
    if (session.status !== 'planning') {
      throw new DesignValidationError('Session is not accepting planner writes')
    }
    if (!session.activeRunId) {
      throw new DesignValidationError('No active planning run')
    }

    const run = await this.repo.getRun(session.activeRunId)
    if (!run || run.status !== 'running') {
      throw new DesignValidationError('No active planning run')
    }
    if (run.fencingToken !== input.fencingToken) {
      throw new DesignValidationError('Stale planning run (fencing token mismatch)')
    }

    assertTransition(session.status, 'plan_editing')

    const contentHash = stableHash(JSON.stringify(input.tree))
    const revision = session.treeRevision + 1
    const tree = { ...input.tree, revision, planningSessionId: session.id }
    await this.repo.saveTree({
      planId: tree.treeId,
      sessionId: session.id,
      tree,
      contentHash
    })
    const now = nowMs()
    await this.repo.updateRun({
      ...run,
      status: 'succeeded',
      finishedAt: now,
      errorJson: null
    })
    const next = {
      ...session,
      status: 'plan_editing' as const,
      treeRevision: revision,
      updatedAt: now
    }
    await this.repo.updateSession(next)
    this.events.publish(session.id, 'planning.tree.changed', {
      treeRevision: revision
    })
  }

  async patchNode(
    actor: Actor,
    sessionId: string,
    nodeId: string,
    body: PatchTreeNodeBody
  ): Promise<ExecutionTreeSnapshot> {
    const session = await this.requireOwned(actor, sessionId)
    if (session.status !== 'plan_editing' && session.status !== 'ready_to_publish') {
      throw new DesignValidationError('Tree is not editable')
    }
    if (session.treeRevision !== body.expectedRevision) throw new DesignConflictError()
    const tree = await this.repo.getTree(sessionId)
    if (!tree) throw new DesignNotFoundError('Execution tree not found')

    let found = false
    const milestones = tree.milestones.map((m) => {
      if (m.id === nodeId) {
        found = true
        return {
          ...m,
          title: body.title ?? m.title,
          description: body.description ?? m.description,
          successCriteria: body.successCriteria ?? m.successCriteria,
          confirmed: false
        }
      }
      return {
        ...m,
        slices: m.slices.map((s) => {
          if (s.id === nodeId) {
            found = true
            return {
              ...s,
              title: body.title ?? s.title,
              description: body.description ?? s.description,
              successCriteria: body.successCriteria ?? s.successCriteria,
              confirmed: false
            }
          }
          return {
            ...s,
            tasks: s.tasks.map((t) => {
              if (t.id !== nodeId) return t
              found = true
              return {
                ...t,
                title: body.title ?? t.title,
                description: body.description ?? t.description,
                successCriteria: body.successCriteria ?? t.successCriteria,
                contextMarkdown: body.contextMarkdown ?? t.contextMarkdown,
                abilityCode: body.abilityCode ?? t.abilityCode,
                coreCode: body.coreCode ?? t.coreCode,
                canRunInParallel: body.canRunInParallel ?? t.canRunInParallel,
                referenceIds: body.referenceIds ?? t.referenceIds,
                dependsOnTaskIds: body.dependsOnTaskIds ?? t.dependsOnTaskIds,
                confirmed: false
              }
            })
          }
        })
      }
    })
    if (!found) throw new DesignNotFoundError('Node not found')

    const revision = session.treeRevision + 1
    const nextTree: ExecutionTreeSnapshot = {
      ...tree,
      revision,
      milestones
    }
    await this.repo.saveTree({
      planId: nextTree.treeId,
      sessionId,
      tree: nextTree,
      contentHash: stableHash(JSON.stringify(nextTree))
    })
    await this.repo.updateSession(
      {
        ...session,
        status: 'plan_editing',
        treeRevision: revision,
        updatedAt: nowMs()
      },
      body.expectedRevision
    )
    this.events.publish(sessionId, 'planning.tree.changed', { treeRevision: revision })
    return nextTree
  }

  async confirmNode(
    actor: Actor,
    sessionId: string,
    nodeId: string,
    expectedRevision: number
  ): Promise<ExecutionTreeSnapshot> {
    const session = await this.requireOwned(actor, sessionId)
    if (session.status !== 'plan_editing' && session.status !== 'ready_to_publish') {
      throw new DesignValidationError('Tree is not confirmable')
    }
    if (session.treeRevision !== expectedRevision) throw new DesignConflictError()
    const tree = await this.repo.getTree(sessionId)
    if (!tree) throw new DesignNotFoundError('Execution tree not found')

    let found = false
    const milestones = tree.milestones.map((m) => {
      if (m.id === nodeId) {
        found = true
        return { ...m, confirmed: true }
      }
      return {
        ...m,
        slices: m.slices.map((s) => {
          if (s.id === nodeId) {
            found = true
            return { ...s, confirmed: true }
          }
          return {
            ...s,
            tasks: s.tasks.map((t) => {
              if (t.id !== nodeId) return t
              found = true
              return { ...t, confirmed: true }
            })
          }
        })
      }
    })
    if (!found) throw new DesignNotFoundError('Node not found')

    const revision = session.treeRevision + 1
    const nextTree: ExecutionTreeSnapshot = { ...tree, revision, milestones }
    const ready = allNodesConfirmed(nextTree)
    await this.repo.saveTree({
      planId: nextTree.treeId,
      sessionId,
      tree: nextTree,
      contentHash: stableHash(JSON.stringify(nextTree))
    })
    await this.repo.updateSession(
      {
        ...session,
        status: ready ? 'ready_to_publish' : 'plan_editing',
        treeRevision: revision,
        updatedAt: nowMs()
      },
      expectedRevision
    )
    this.events.publish(sessionId, 'planning.tree.changed', {
      treeRevision: revision,
      readyToPublish: ready
    })
    return nextTree
  }

  async publish(
    actor: Actor,
    sessionId: string,
    expectedRevision: number,
    idempotencyKey: string
  ): Promise<{ session: PlanningSessionRecord; jobId: string }> {
    const existing = await this.repo.findHandoffByIdempotency(idempotencyKey)
    if (existing?.jobId) {
      const session = await this.requireOwned(actor, sessionId)
      return { session, jobId: existing.jobId }
    }

    const session = await this.requireOwned(actor, sessionId)
    if (session.status !== 'ready_to_publish') {
      throw new DesignValidationError('Session is not ready to publish')
    }
    if (session.treeRevision !== expectedRevision) throw new DesignConflictError()

    const tree = await this.repo.getTree(sessionId)
    if (!tree || !allNodesConfirmed(tree)) {
      throw new DesignValidationError('All nodes must be confirmed before publish')
    }
    const draftSnapshot = JSON.parse(session.draftSnapshotJson) as DraftSnapshot
    const manifest = session.referenceSnapshotId
      ? await this.repo.getReferenceManifest(session.referenceSnapshotId)
      : null
    if (!manifest) throw new DesignValidationError('Missing reference manifest')

    const submissionId = newId('sub')
    const taskProvider = firstTaskCoreCode(tree)
    const verificationProvider = session.executionProfile.sliceVerifierCoreCode
    const executionSnapshot = this.settings.captureExecutionSettings?.(
      taskProvider,
      verificationProvider
    )
    const submission: JobSubmission = {
      submissionId,
      idempotencyKey,
      actorId: actor.userId,
      projectId: session.projectId,
      title: draftSnapshot.title,
      summary: draftSnapshot.summary,
      workspaceRoot: draftSnapshot.workspaceRoot,
      source: {
        draftId: draftSnapshot.draftId,
        planningSessionId: session.id
      },
      draftSnapshot,
      referenceManifest: manifest,
      executionProfile: session.executionProfile,
      executionSettings: executionSnapshot
        ? {
            settingsHash: executionSettingsHash(executionSnapshot),
            capturedAt: new Date().toISOString(),
            payload: executionSnapshot as unknown as Record<string, unknown>
          }
        : {
            settingsHash: session.plannerSettingsHash,
            capturedAt: new Date().toISOString(),
            payload: JSON.parse(session.plannerSettingsSnapshotJson) as Record<string, unknown>
          },
      executionTree: tree,
      createdAt: new Date().toISOString()
    }

    assertTransition(session.status, 'publishing')
    const publishing = {
      ...session,
      status: 'publishing' as const,
      updatedAt: nowMs()
    }
    await this.repo.updateSession(publishing, expectedRevision)

    const handoff = await this.repo.insertHandoff({
      submissionId,
      planningSessionId: session.id,
      idempotencyKey,
      payloadJson: JSON.stringify(submission),
      createdAt: nowMs()
    })
    if (!handoff.created && handoff.existingJobId) {
      return { session: publishing, jobId: handoff.existingJobId }
    }

    const accepted = await this.jobSubmission.accept(submission)
    await this.repo.markHandoffAccepted({
      submissionId,
      jobId: accepted.jobId,
      acceptedAt: nowMs()
    })
    const published: PlanningSessionRecord = {
      ...publishing,
      status: 'published',
      publishedJobId: accepted.jobId,
      publishedAt: nowMs(),
      updatedAt: nowMs()
    }
    await this.repo.updateSession(published)
    this.events.publish(sessionId, 'planning.published', { jobId: accepted.jobId })
    return { session: published, jobId: accepted.jobId }
  }

  private async failSession(sessionId: string, message: string): Promise<void> {
    const session = await this.repo.getSession(sessionId)
    if (!session) return
    await this.repo.updateSession({
      ...session,
      status: 'failed',
      lastErrorJson: JSON.stringify({ message }),
      updatedAt: nowMs()
    })
    this.events.publish(sessionId, 'planning.failed', { message })
  }

  private async requireOwned(actor: Actor, sessionId: string): Promise<PlanningSessionRecord> {
    const session = await this.repo.getSession(sessionId)
    if (!session) throw new DesignNotFoundError('Planning session not found')
    if (session.actorId !== actor.userId) throw new DesignForbiddenError()
    return session
  }
}

/** Narrow port used by Planner MCP tools — no repository / workload imports. */
export type PlanningApplicationPort = Pick<
  PlanningApplication,
  'commitExecutionTree' | 'notifyPlannerProgress'
>
