import { createHash, randomUUID } from 'crypto'
import type { AgentRuntime, ProviderCode } from '@codetask/agent-runtime'
import { MCP_HTTP_ACCEPT_HEADER_VALUE } from '@codetask/agent-runtime'
import type { MilestoneVerdict, SliceVerdict } from '@codetask/contracts'
import type Database from 'better-sqlite3'
import { newId, nowMs } from '../../shared.ts'
import { VerificationRepository } from '../infrastructure/verification-repository.ts'
import { ExecutionOutbox } from '../../events/execution-outbox.ts'
import { WorkRepository } from '../../work/infrastructure/work-repository.ts'
import type { RuntimeHandleRegistry } from '../../pool/infrastructure/runtime-handle-registry.ts'
import { evaluateSliceVerdict } from '../domain/slice-verdict.ts'
import { evaluateMilestoneVerdict } from '../domain/milestone-verdict.ts'
import {
  MAX_MILESTONE_VERIFICATION_ATTEMPTS,
  MAX_SLICE_VERIFICATION_ATTEMPTS
} from '../domain/verification-policy.ts'
import { createInjectRepairWorkService } from '../../recovery/application/inject-repair-work.ts'
import { canInjectRepair } from '../../recovery/domain/repair-policy.ts'
import {
  readJobExecutionSettings,
  verificationMcpFromJobSettings,
  verifierPromptFromJobSettings
} from '../../job/application/job-settings-snapshot.ts'
import { normalizeProvider } from '../../job/application/submit-job.ts'
import {
  buildMilestoneVerifierMcpUrl,
  buildSliceVerifierMcpUrl,
  parseCompleteMilestoneVerification,
  parseCompleteSliceVerification,
  registerMilestoneVerifierMcpSession,
  registerSliceVerifierMcpSession,
  unregisterMilestoneVerifierMcpSession,
  unregisterSliceVerifierMcpSession
} from '../mcp/index.ts'
import {
  buildMilestoneVerificationEvidence,
  buildSliceVerificationEvidence,
  serializeVerificationEvidence,
  type MilestoneVerificationEvidenceBundle,
  type SliceVerificationEvidenceBundle
} from './verification-evidence.ts'

/** After turn completes, wait this long for MCP verdict before treating as missed hand-in. */
export const VERIFIER_VERDICT_GRACE_MS = 3 * 60 * 1000

function hashEvidenceBundle(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex')
}

function countAttempts(
  db: Database.Database,
  jobId: string,
  scopeType: string,
  scopeId: string,
  generation: number
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM verification_attempts
       WHERE job_id = ? AND scope_type = ? AND scope_id = ? AND generation = ?`
    )
    .get(jobId, scopeType, scopeId, generation) as { n: number }
  return Number(row.n)
}

function findSucceededBundle(
  db: Database.Database,
  jobId: string,
  scopeType: string,
  scopeId: string,
  bundleHash: string
): { status: string; verdictJson: string } | null {
  const row = db
    .prepare(
      `SELECT vr.status AS status, vr.verdict_json AS verdictJson FROM verification_attempts va
       JOIN verification_results vr ON vr.verification_attempt_id = va.id
       WHERE va.job_id = ? AND va.scope_type = ? AND va.scope_id = ?
         AND va.bundle_hash = ? AND va.status = 'succeeded'
       ORDER BY va.ended_at DESC LIMIT 1`
    )
    .get(jobId, scopeType, scopeId, bundleHash) as
    | { status: string; verdictJson: string }
    | undefined
  return row ?? null
}

function readJobWorkspaceRoot(db: Database.Database, jobId: string): string {
  const row = db
    .prepare(`SELECT workspace_root AS workspaceRoot FROM jobs WHERE id = ?`)
    .get(jobId) as { workspaceRoot?: string } | undefined
  return row?.workspaceRoot ?? ''
}

function readVerifierProvider(
  db: Database.Database,
  jobId: string,
  kind: 'slice' | 'milestone'
): ProviderCode {
  try {
    const row = db
      .prepare(`SELECT execution_profile_json FROM job_snapshots WHERE job_id = ?`)
      .get(jobId) as { execution_profile_json?: string } | undefined
    if (!row?.execution_profile_json) return 'opencode'
    const profile = JSON.parse(row.execution_profile_json) as {
      sliceVerifierCoreCode?: string
      milestoneVerifierCoreCode?: string
    }
    const raw =
      kind === 'milestone'
        ? profile.milestoneVerifierCoreCode
        : profile.sliceVerifierCoreCode
    return normalizeProvider(raw ?? 'opencode') as ProviderCode
  } catch {
    return 'opencode'
  }
}

function buildSliceEvidencePrompt(bundle: SliceVerificationEvidenceBundle): string {
  return [
    'Review this frozen Slice verification evidence bundle.',
    'Base every claim on the supplied requirements, Work state, TaskEvidence, validation result, or workspace inspection.',
    JSON.stringify(bundle, null, 2),
    'Submit exactly one complete_slice_verification verdict via the codeteam-slice-verifier MCP tool.'
  ].join('\n')
}

function buildMilestoneEvidencePrompt(bundle: MilestoneVerificationEvidenceBundle): string {
  return [
    'Review this frozen Milestone verification evidence bundle.',
    'Evaluate the Milestone criteria against the complete child Slice verdicts and job requirements.',
    JSON.stringify(bundle, null, 2),
    'Submit exactly one complete_milestone_verification verdict via the codeteam-milestone-verifier MCP tool.'
  ].join('\n')
}

class VerificationTurnAbortedError extends Error {
  constructor() {
    super('Verifier turn aborted by Job control')
    this.name = 'VerificationTurnAbortedError'
  }
}

function startVerdictWait<T>(input: {
  sessionId: string
  scopeLabel: string
  targetId: string
  unregister: (sessionId: string) => void
  register: (handlers: { resolve: (value: T) => void; reject: (error: Error) => void }) => void
}): {
  promise: Promise<T>
  resetTimeout: (timeoutMs: number) => void
  cancel: (reason?: string) => void
  settleWith: (value: T) => void
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectPromise: ((error: Error) => void) | undefined
  let resolvePromise: ((value: T) => void) | undefined
  let settled = false

  const cleanup = (): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    input.unregister(input.sessionId)
  }

  const scheduleTimeout = (timeoutMs: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      cleanup()
      rejectPromise?.(
        new Error(
          `Timed out waiting for ${input.scopeLabel} verifier completion after turn completed (${input.targetId})`
        )
      )
    }, timeoutMs)
  }

  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
    input.register({
      resolve: (value) => {
        if (settled) return
        cleanup()
        resolve(value)
      },
      reject: (error) => {
        if (settled) return
        cleanup()
        reject(error)
      }
    })
  })

  void promise.catch(() => {})

  return {
    promise,
    resetTimeout: (timeoutMs: number) => {
      if (settled) return
      scheduleTimeout(timeoutMs)
    },
    cancel: (reason?: string) => {
      if (settled) return
      cleanup()
      rejectPromise?.(
        new Error(reason ?? `Verifier wait cancelled for ${input.scopeLabel} ${input.targetId}`)
      )
    },
    settleWith: (value: T) => {
      if (settled) return
      cleanup()
      resolvePromise?.(value)
    }
  }
}

function persistVerdict(input: {
  db: Database.Database
  outbox: ExecutionOutbox
  jobId: string
  generation: number
  scopeType: 'slice' | 'milestone'
  scopeId: string
  runId: string
  attemptNumber: number
  bundleHash: string
  evidenceBundleJson: string
  verdict: SliceVerdict | MilestoneVerdict
}): void {
  const now = nowMs()
  const attemptId = newId('vattempt')
  const jobSettings = readJobExecutionSettings(input.db, input.jobId)
  const settingsBinding = {
    settingsHash: jobSettings?.settingsHash ?? '',
    verificationMcpServers: verificationMcpFromJobSettings(jobSettings),
    verifierPromptBody: verifierPromptFromJobSettings(
      jobSettings,
      input.scopeType === 'milestone' ? 'milestone' : 'slice'
    )
  }
  input.db
    .prepare(
      `INSERT INTO verification_attempts (
        id, job_id, generation, scope_type, scope_id, attempt_number,
        bundle_hash, evidence_bundle_json, status, run_id, started_at, ended_at, error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?)`
    )
    .run(
      attemptId,
      input.jobId,
      input.generation,
      input.scopeType,
      input.scopeId,
      input.attemptNumber,
      input.bundleHash,
      input.evidenceBundleJson,
      input.runId,
      now,
      now,
      JSON.stringify({ settingsBinding })
    )

  const resultId = newId('vresult')
  input.db
    .prepare(
      `INSERT INTO verification_results (
        id, verification_attempt_id, scope_type, scope_id, status, confidence,
        summary, verdict_json, bundle_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      resultId,
      attemptId,
      input.scopeType,
      input.scopeId,
      input.verdict.status,
      input.verdict.confidence,
      input.verdict.summary,
      JSON.stringify({ ...input.verdict, settingsHash: settingsBinding.settingsHash }),
      input.bundleHash,
      now
    )

  input.outbox.enqueue(
    input.jobId,
    'verification.changed',
    { jobId: input.jobId, scopeType: input.scopeType, scopeId: input.scopeId },
    input.db
  )
}

function priorSliceVerdict(prior: { status: string; verdictJson: string }): SliceVerdict {
  try {
    const parsed = JSON.parse(prior.verdictJson) as SliceVerdict
    if (parsed?.status && parsed.summary) return parsed
  } catch {
    // fall through
  }
  return {
    status: prior.status as SliceVerdict['status'],
    confidence: 'high',
    summary: `Cached slice verdict: ${prior.status}`,
    satisfiedSignals: [],
    missingSignals: [],
    questionableClaims: [],
    evidenceTrace: [],
    repairSuggestions: []
  }
}

function priorMilestoneVerdict(prior: { status: string; verdictJson: string }): MilestoneVerdict {
  try {
    const parsed = JSON.parse(prior.verdictJson) as MilestoneVerdict
    if (parsed?.status && parsed.summary) return parsed
  } catch {
    // fall through
  }
  return {
    status: (prior.status === 'passed' ? 'passed' : prior.status) as MilestoneVerdict['status'],
    confidence: 'high',
    summary: `Cached milestone verdict: ${prior.status}`,
    requirementTrace: [],
    sliceAssessments: [],
    repairTasks: []
  }
}

/**
 * Production Slice Verifier: AgentRuntime + MCP complete_slice_verification.
 * Rule-based evaluateSliceVerdict remains a test/fallback stub only
 * (no agentRuntime, or useRuleBasedFallback=true).
 */
export function createVerifySliceService(deps: {
  db: Database.Database
  verification: VerificationRepository
  outbox: ExecutionOutbox
  agentRuntime?: AgentRuntime
  handles?: RuntimeHandleRegistry
  work?: WorkRepository
  /** Test-only: skip AgentRuntime and use evaluateSliceVerdict. */
  useRuleBasedFallback?: boolean
}): {
  verify(input: {
    jobId: string
    generation: number
    sliceId: string
    runId: string
  }): Promise<SliceVerdict>
} {
  const work = deps.work ?? new WorkRepository(deps.db)
  const repair = createInjectRepairWorkService({ db: deps.db })

  return {
    async verify(input: {
      jobId: string
      generation: number
      sliceId: string
      runId: string
    }): Promise<SliceVerdict> {
      const sliceWork = work
        .listWork(input.jobId, input.generation)
        .filter((w) => w.sliceId === input.sliceId)

      const evidenceBundle = buildSliceVerificationEvidence({
        db: deps.db,
        jobId: input.jobId,
        generation: input.generation,
        sliceId: input.sliceId,
        workItems: sliceWork
      })
      const evidenceBundleJson = serializeVerificationEvidence(evidenceBundle)
      const bundleHash = hashEvidenceBundle(evidenceBundleJson)

      const prior = findSucceededBundle(
        deps.db,
        input.jobId,
        'slice',
        input.sliceId,
        bundleHash
      )
      if (prior) {
        deps.verification.updateSliceVerification(
          input.jobId,
          input.generation,
          input.sliceId,
          prior.status,
          prior.status === 'progress-ok' ? 'progress-ok' : prior.status
        )
        return priorSliceVerdict(prior)
      }

      const attempts = countAttempts(deps.db, input.jobId, 'slice', input.sliceId, input.generation)
      let verdict: SliceVerdict

      const agentRuntime = deps.agentRuntime
      const useRules = deps.useRuleBasedFallback === true || !agentRuntime
      if (useRules) {
        verdict = evaluateSliceVerdict(sliceWork)
      } else {
        try {
          verdict = await runSliceVerifierAgent({
            deps: { db: deps.db, agentRuntime, handles: deps.handles },
            evidenceBundle,
            input,
            attemptNumber: attempts + 1
          })
        } catch (error) {
          if (error instanceof VerificationTurnAbortedError) {
            return {
              status: 'inconclusive',
              confidence: 'low',
              summary: error.message,
              satisfiedSignals: [],
              missingSignals: ['verifier-aborted-by-control'],
              questionableClaims: [],
              evidenceTrace: [],
              repairSuggestions: []
            }
          }
          throw error
        }
      }

      if (verdict.status === 'inconclusive' && attempts + 1 >= MAX_SLICE_VERIFICATION_ATTEMPTS) {
        verdict = {
          ...verdict,
          status: 'blocked',
          confidence: 'high',
          summary: `Slice verification exhausted after ${MAX_SLICE_VERIFICATION_ATTEMPTS} attempts`
        }
      }

      const tx = deps.db.transaction(() => {
        persistVerdict({
          db: deps.db,
          outbox: deps.outbox,
          jobId: input.jobId,
          generation: input.generation,
          scopeType: 'slice',
          scopeId: input.sliceId,
          runId: input.runId,
          attemptNumber: attempts + 1,
          bundleHash,
          evidenceBundleJson,
          verdict
        })

        deps.verification.updateSliceVerification(
          input.jobId,
          input.generation,
          input.sliceId,
          verdict.status,
          verdict.status === 'progress-ok' ? 'progress-ok' : verdict.status
        )

        if (verdict.status === 'needs-repair') {
          for (const suggestion of verdict.repairSuggestions) {
            if (!suggestion.targetWorkId) continue
            const existing = deps.db
              .prepare(
                `SELECT COALESCE(MAX(generation_number), 0) AS n FROM repair_generations
                 WHERE job_id = ? AND generation = ? AND scope_type = 'work' AND scope_id = ?`
              )
              .get(input.jobId, input.generation, suggestion.targetWorkId) as { n: number }
            if (!canInjectRepair(Number(existing.n))) continue
            repair.inject({
              jobId: input.jobId,
              generation: input.generation,
              parentWorkId: suggestion.targetWorkId,
              kind: suggestion.kind,
              title: suggestion.title,
              description: suggestion.description,
              successCriteria: suggestion.successCriteria
            })
          }
        }
      })
      tx()
      return verdict
    }
  }
}

async function runSliceVerifierAgent(input: {
  deps: {
    db: Database.Database
    agentRuntime: AgentRuntime
    handles?: RuntimeHandleRegistry
  }
  evidenceBundle: SliceVerificationEvidenceBundle
  input: { jobId: string; generation: number; sliceId: string; runId: string }
  attemptNumber: number
}): Promise<SliceVerdict> {
  const { deps, evidenceBundle, attemptNumber } = input
  const jobId = input.input.jobId
  const sliceId = input.input.sliceId
  const runId = input.input.runId

  const jobSettings = readJobExecutionSettings(deps.db, jobId)
  const systemPrompt = verifierPromptFromJobSettings(jobSettings, 'slice')
  const userMcpServers = verificationMcpFromJobSettings(jobSettings)
  const provider = readVerifierProvider(deps.db, jobId, 'slice')
  const workspaceRoot = readJobWorkspaceRoot(deps.db, jobId)
  const sessionId = `slice-mcp-${randomUUID()}`
  const turnId = newId('vturn')
  const mcpUrl = buildSliceVerifierMcpUrl({ sessionId, jobId, sliceId })
  const signal = deps.handles?.ensureAbortController(runId).signal

  const verdictWait = startVerdictWait<SliceVerdict>({
    sessionId,
    scopeLabel: 'slice',
    targetId: sliceId,
    unregister: unregisterSliceVerifierMcpSession,
    register: (handlers) => {
      registerSliceVerifierMcpSession({
        sessionId,
        jobId,
        sliceId,
        ...handlers
      })
    }
  })

  const prompt = buildSliceEvidencePrompt(evidenceBundle)
  const abortVerdictWait = (): void => {
    verdictWait.cancel('Slice verifier aborted by Job control')
  }
  signal?.addEventListener('abort', abortVerdictWait, { once: true })
  deps.handles?.setTurnId(runId, turnId)

  try {
    for await (const event of deps.agentRuntime.runTurn({
      role: 'slice-verifier',
      capabilityProfile: 'verifier-sandbox',
      provider,
      workspaceRoot,
      prompt,
      systemPrompt,
      userMcpServers,
      ...(mcpUrl
        ? {
            mcpServers: [
              {
                name: 'codeteam-slice-verifier',
                url: mcpUrl,
                headers: { Accept: MCP_HTTP_ACCEPT_HEADER_VALUE }
              }
            ]
          }
        : {}),
      scopeId: `job:${jobId}:run:${runId}:verify:slice:${sliceId}:${attemptNumber}`,
      turnId,
      signal,
      workspaceAccess: 'live-read'
    })) {
      if (event.type === 'tool_call' && event.name === 'complete_slice_verification') {
        try {
          const verdict = parseCompleteSliceVerification(event.arguments)
          verdictWait.settleWith(verdict)
        } catch (error) {
          verdictWait.cancel(
            error instanceof Error ? error.message : 'Invalid complete_slice_verification payload'
          )
        }
        continue
      }
      if (event.type === 'failed') {
        verdictWait.cancel(event.message)
        break
      }
      if (event.type === 'completed') {
        verdictWait.resetTimeout(VERIFIER_VERDICT_GRACE_MS)
        break
      }
    }
  } catch (error) {
    verdictWait.cancel(
      error instanceof Error ? error.message : 'Slice verifier agent failed'
    )
  }

  try {
    const verdict = await verdictWait.promise
    if (signal?.aborted) throw new VerificationTurnAbortedError()
    return verdict
  } catch (error) {
    if (signal?.aborted) throw new VerificationTurnAbortedError()
    return {
      status: 'inconclusive',
      confidence: 'low',
      summary:
        error instanceof Error
          ? error.message
          : 'Timed out waiting for complete_slice_verification',
      satisfiedSignals: [],
      missingSignals: ['verifier-verdict-missing'],
      questionableClaims: [],
      evidenceTrace: [],
      repairSuggestions: []
    }
  } finally {
    signal?.removeEventListener('abort', abortVerdictWait)
    deps.handles?.setTurnId(runId, null)
  }
}

/**
 * Production Milestone Verifier: AgentRuntime + MCP complete_milestone_verification.
 * Rule-based evaluateMilestoneVerdict remains a test/fallback stub only
 * (no agentRuntime, or useRuleBasedFallback=true).
 */
export function createVerifyMilestoneService(deps: {
  db: Database.Database
  verification: VerificationRepository
  outbox: ExecutionOutbox
  agentRuntime?: AgentRuntime
  handles?: RuntimeHandleRegistry
  /** Test-only: skip AgentRuntime and use evaluateMilestoneVerdict. */
  useRuleBasedFallback?: boolean
}): {
  verify(input: {
    jobId: string
    generation: number
    milestoneId: string
    runId: string
  }): Promise<MilestoneVerdict>
} {
  return {
    async verify(input: {
      jobId: string
      generation: number
      milestoneId: string
      runId: string
    }): Promise<MilestoneVerdict> {
      const sliceIds = deps.verification.listSliceIds(
        input.jobId,
        input.generation,
        input.milestoneId
      )
      const sliceVerificationStates = new Map(
        sliceIds.map((id) => [
          id,
          deps.verification.getSliceVerificationState(input.jobId, input.generation, id)
        ])
      )

      const evidenceBundle = buildMilestoneVerificationEvidence({
        db: deps.db,
        jobId: input.jobId,
        generation: input.generation,
        milestoneId: input.milestoneId
      })
      const evidenceBundleJson = serializeVerificationEvidence(evidenceBundle)
      const bundleHash = hashEvidenceBundle(evidenceBundleJson)

      const prior = findSucceededBundle(
        deps.db,
        input.jobId,
        'milestone',
        input.milestoneId,
        bundleHash
      )
      if (prior) {
        deps.verification.updateMilestoneState(
          input.jobId,
          input.generation,
          input.milestoneId,
          prior.status === 'passed' ? 'passed' : prior.status
        )
        return priorMilestoneVerdict(prior)
      }

      const attempts = countAttempts(
        deps.db,
        input.jobId,
        'milestone',
        input.milestoneId,
        input.generation
      )
      let verdict: MilestoneVerdict

      const agentRuntime = deps.agentRuntime
      const useRules = deps.useRuleBasedFallback === true || !agentRuntime
      if (useRules) {
        verdict = evaluateMilestoneVerdict({ sliceIds, sliceVerificationStates })
      } else {
        try {
          verdict = await runMilestoneVerifierAgent({
            deps: { db: deps.db, agentRuntime, handles: deps.handles },
            input,
            evidenceBundle,
            attemptNumber: attempts + 1
          })
        } catch (error) {
          if (error instanceof VerificationTurnAbortedError) {
            return {
              status: 'inconclusive',
              confidence: 'low',
              summary: error.message,
              requirementTrace: [],
              sliceAssessments: [],
              repairTasks: []
            }
          }
          throw error
        }
      }

      if (verdict.status === 'inconclusive' && attempts + 1 >= MAX_MILESTONE_VERIFICATION_ATTEMPTS) {
        verdict = {
          ...verdict,
          status: 'blocked',
          confidence: 'high',
          summary: `Milestone verification exhausted after ${MAX_MILESTONE_VERIFICATION_ATTEMPTS} attempts`
        }
      }

      const tx = deps.db.transaction(() => {
        persistVerdict({
          db: deps.db,
          outbox: deps.outbox,
          jobId: input.jobId,
          generation: input.generation,
          scopeType: 'milestone',
          scopeId: input.milestoneId,
          runId: input.runId,
          attemptNumber: attempts + 1,
          bundleHash,
          evidenceBundleJson,
          verdict
        })

        deps.verification.updateMilestoneState(
          input.jobId,
          input.generation,
          input.milestoneId,
          verdict.status === 'passed' ? 'passed' : verdict.status
        )
      })
      tx()
      return verdict
    }
  }
}

async function runMilestoneVerifierAgent(input: {
  deps: {
    db: Database.Database
    agentRuntime: AgentRuntime
    handles?: RuntimeHandleRegistry
  }
  input: { jobId: string; generation: number; milestoneId: string; runId: string }
  evidenceBundle: MilestoneVerificationEvidenceBundle
  attemptNumber: number
}): Promise<MilestoneVerdict> {
  const { deps, evidenceBundle, attemptNumber } = input
  const jobId = input.input.jobId
  const milestoneId = input.input.milestoneId
  const runId = input.input.runId

  const jobSettings = readJobExecutionSettings(deps.db, jobId)
  const systemPrompt = verifierPromptFromJobSettings(jobSettings, 'milestone')
  const userMcpServers = verificationMcpFromJobSettings(jobSettings)
  const provider = readVerifierProvider(deps.db, jobId, 'milestone')
  const workspaceRoot = readJobWorkspaceRoot(deps.db, jobId)
  const sessionId = `milestone-mcp-${randomUUID()}`
  const turnId = newId('vturn')
  const mcpUrl = buildMilestoneVerifierMcpUrl({ sessionId, jobId, milestoneId })
  const signal = deps.handles?.ensureAbortController(runId).signal

  const verdictWait = startVerdictWait<MilestoneVerdict>({
    sessionId,
    scopeLabel: 'milestone',
    targetId: milestoneId,
    unregister: unregisterMilestoneVerifierMcpSession,
    register: (handlers) => {
      registerMilestoneVerifierMcpSession({
        sessionId,
        jobId,
        milestoneId,
        ...handlers
      })
    }
  })

  const prompt = buildMilestoneEvidencePrompt(evidenceBundle)
  const abortVerdictWait = (): void => {
    verdictWait.cancel('Milestone verifier aborted by Job control')
  }
  signal?.addEventListener('abort', abortVerdictWait, { once: true })
  deps.handles?.setTurnId(runId, turnId)

  try {
    for await (const event of deps.agentRuntime.runTurn({
      role: 'milestone-verifier',
      capabilityProfile: 'verifier-sandbox',
      provider,
      workspaceRoot,
      prompt,
      systemPrompt,
      userMcpServers,
      ...(mcpUrl
        ? {
            mcpServers: [
              {
                name: 'codeteam-milestone-verifier',
                url: mcpUrl,
                headers: { Accept: MCP_HTTP_ACCEPT_HEADER_VALUE }
              }
            ]
          }
        : {}),
      scopeId: `job:${jobId}:run:${runId}:verify:milestone:${milestoneId}:${attemptNumber}`,
      turnId,
      signal,
      workspaceAccess: 'live-read'
    })) {
      if (event.type === 'tool_call' && event.name === 'complete_milestone_verification') {
        try {
          const verdict = parseCompleteMilestoneVerification(event.arguments, { milestoneId })
          verdictWait.settleWith(verdict)
        } catch (error) {
          verdictWait.cancel(
            error instanceof Error
              ? error.message
              : 'Invalid complete_milestone_verification payload'
          )
        }
        continue
      }
      if (event.type === 'failed') {
        verdictWait.cancel(event.message)
        break
      }
      if (event.type === 'completed') {
        verdictWait.resetTimeout(VERIFIER_VERDICT_GRACE_MS)
        break
      }
    }
  } catch (error) {
    verdictWait.cancel(
      error instanceof Error ? error.message : 'Milestone verifier agent failed'
    )
  }

  try {
    const verdict = await verdictWait.promise
    if (signal?.aborted) throw new VerificationTurnAbortedError()
    return verdict
  } catch (error) {
    if (signal?.aborted) throw new VerificationTurnAbortedError()
    return {
      status: 'inconclusive',
      confidence: 'low',
      summary:
        error instanceof Error
          ? error.message
          : 'Timed out waiting for complete_milestone_verification',
      requirementTrace: [],
      sliceAssessments: [],
      repairTasks: []
    }
  } finally {
    signal?.removeEventListener('abort', abortVerdictWait)
    deps.handles?.setTurnId(runId, null)
  }
}

export function createVerifyTaskEvidenceService(): {
  verify(evidenceValid: boolean): boolean
} {
  return {
    verify(evidenceValid: boolean): boolean {
      return evidenceValid
    }
  }
}

/** Re-export domain stubs for unit tests. */
export { evaluateSliceVerdict, evaluateMilestoneVerdict }
