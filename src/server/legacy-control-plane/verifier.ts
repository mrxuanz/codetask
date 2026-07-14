import { randomUUID } from 'crypto'
import type { SliceVerificationRecordDto } from '@shared/contracts/evidence'
import type { SavedJobPlan } from '../planner/plan-types'
import { ensureCoreAvailable, type SupportedCoreCode } from '../conversation/cores'
import { ensureJobTaskRuntimeRoot, streamAgentTurn } from '../agent-runtime/runner'
import { resolveCoreModel } from '../conversation/models'
import {
  resolveSliceVerifierCoreCode,
  resolveMilestoneVerifierCoreCode
} from '../settings/control-plane'
import {
  buildMilestoneVerifierSystemPrompt,
  buildSliceVerifierSystemPrompt
} from '../verification/prompts'
import type { GateMilestoneState, GateSliceState } from './execution-gate'
import type { TaskProgressItemDto, TaskProgressSliceDto } from './types'
import type { MilestoneVerificationVerdict, SliceVerificationVerdict } from './verification/types'
import {
  registerSliceVerifierMcpSession,
  unregisterSliceVerifierMcpSession
} from './mcp/slice-session'
import { buildSliceVerifierMcpUrl } from './mcp/slice-url'
import {
  registerMilestoneVerifierMcpSession,
  unregisterMilestoneVerifierMcpSession
} from './mcp/milestone-session'
import { buildMilestoneVerifierMcpUrl } from './mcp/milestone-url'
import { getAppContext } from '../bootstrap'
import { createTurnError } from '../../shared/turn-errors/turn-error.ts'
import {
  buildMilestoneVerifierEvidenceBundle,
  buildSliceVerifierEvidenceBundle,
  toSliceVerificationRecord
} from './evidence/bundle'
import { VERIFIER_VERDICT_GRACE_MS } from './recovery-limits'

export function initJobVerifier(): void {
  getAppContext()
}

function sliceVerdictsFromProgress(
  slices?: TaskProgressSliceDto[]
): Record<string, SliceVerificationRecordDto> {
  const out: Record<string, SliceVerificationRecordDto> = {}
  for (const slice of slices ?? []) {
    if (slice.verdict) out[slice.id] = slice.verdict
  }
  return out
}

function startVerdictWait<T>(input: {
  sessionId: string
  scopeLabel: string
  targetId: string
  signal: AbortSignal
  register: (handlers: { resolve: (value: T) => void; reject: (error: Error) => void }) => void
  unregister: (sessionId: string) => void
  /** Optional initial arm. Production omits — timer starts only via resetTimeout after turn complete. */
  initialTimeoutMs?: number | null
}): {
  promise: Promise<T>
  resetTimeout: (timeoutMs: number) => void
  cancel: () => void
} {
  // Same policy as task evidence wait: do not wall-clock kill an active verifier turn.
  // ProgressGuard handles mid-turn stall; grace arms only after the turn completes.
  const initialTimeoutMs = input.initialTimeoutMs ?? null
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  let rejectPromise: ((error: Error) => void) | undefined
  let settled = false

  const cleanup = (): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) input.signal.removeEventListener('abort', onAbort)
    input.unregister(input.sessionId)
  }

  const scheduleTimeout = (timeoutMs: number): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      cleanup()
      rejectPromise?.(
        createTurnError('task.verifier_evidence_timeout', {
          params: { scope: input.scopeLabel, id: input.targetId },
          detail: 'Timed out waiting for verifier completion after turn completed'
        })
      )
    }, timeoutMs)
  }

  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject
    if (initialTimeoutMs != null) {
      scheduleTimeout(initialTimeoutMs)
    }

    onAbort = (): void => {
      if (settled) return
      cleanup()
      reject(createTurnError('job.cancelled'))
    }
    input.signal.addEventListener('abort', onAbort, { once: true })

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

  const resetTimeout = (timeoutMs: number): void => {
    if (settled) return
    scheduleTimeout(timeoutMs)
  }

  const cancel = (): void => {
    if (settled) return
    cleanup()
    rejectPromise?.(
      createTurnError('task.verifier_evidence_timeout', {
        params: { scope: input.scopeLabel, id: input.targetId },
        detail: 'Verifier wait cancelled by executor'
      })
    )
  }

  return { promise, resetTimeout, cancel }
}

export async function runSliceVerification(input: {
  jobId: string
  threadId: string
  workspacePath: string
  plan: SavedJobPlan
  slice: GateSliceState
  taskItems: TaskProgressItemDto[]
  signal: AbortSignal
}): Promise<{
  ok: boolean
  message: string
  verdict?: SliceVerificationVerdict
  infraMiss?: boolean
}> {
  const coreCode = await resolveSliceVerifierCoreCode()
  const core = await ensureCoreAvailable(coreCode)
  const runtimeRoot = ensureJobTaskRuntimeRoot(
    getAppContext().dataDir,
    input.threadId,
    input.jobId,
    `verify-${input.slice.id}`,
    core.code
  )
  const model = resolveCoreModel(core.code as SupportedCoreCode)
  const sessionId = `slice-mcp-${randomUUID()}`
  const mcpUrl = buildSliceVerifierMcpUrl({
    sessionId,
    jobId: input.jobId,
    sliceId: input.slice.id
  })
  const verdictWait = startVerdictWait<SliceVerificationVerdict>({
    sessionId,
    scopeLabel: 'slice',
    targetId: input.slice.id,
    signal: input.signal,
    unregister: unregisterSliceVerifierMcpSession,
    register: (handlers) => {
      registerSliceVerifierMcpSession({
        sessionId,
        jobId: input.jobId,
        sliceId: input.slice.id,
        ...handlers
      })
    }
  })

  const prompt = buildSliceVerifierEvidenceBundle({
    workspacePath: input.workspacePath,
    plan: input.plan,
    sliceId: input.slice.id,
    taskItems: input.taskItems
  })

  try {
    for await (const chunk of streamAgentTurn({
      role: 'slice-verifier',
      provider: core.code as SupportedCoreCode,
      workspaceRoot: input.workspacePath,
      runtimeRoot,
      prompt,
      model,
      systemPrompt: buildSliceVerifierSystemPrompt(),
      mcpUrl,
      signal: input.signal
    })) {
      if (chunk.type === 'completed') {
        verdictWait.resetTimeout(VERIFIER_VERDICT_GRACE_MS)
        break
      }
    }
  } catch (error) {
    verdictWait.cancel()
    const message = error instanceof Error ? error.message : 'Slice verifier agent failed'
    return { ok: false, message, infraMiss: true }
  }

  try {
    const verdict = await verdictWait.promise
    if (verdict.status === 'progress-ok') {
      return { ok: true, message: verdict.summary, verdict }
    }
    return {
      ok: false,
      message: `${verdict.status}: ${verdict.summary}`,
      verdict
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Timed out waiting for complete_slice_verification'
    return { ok: false, message, infraMiss: true }
  }
}

export async function runMilestoneVerification(input: {
  jobId: string
  threadId: string
  workspacePath: string
  plan: SavedJobPlan
  milestone: GateMilestoneState
  slices: GateSliceState[]
  taskItems: TaskProgressItemDto[]
  progressSlices?: TaskProgressSliceDto[] | undefined
  signal: AbortSignal
}): Promise<{
  ok: boolean
  message: string
  verdict?: MilestoneVerificationVerdict | undefined
  infraMiss?: boolean | undefined
}> {
  const coreCode = await resolveMilestoneVerifierCoreCode()
  const core = await ensureCoreAvailable(coreCode)
  const runtimeRoot = ensureJobTaskRuntimeRoot(
    getAppContext().dataDir,
    input.threadId,
    input.jobId,
    `verify-${input.milestone.id}`,
    core.code
  )
  const model = resolveCoreModel(core.code as SupportedCoreCode)
  const sessionId = `milestone-mcp-${randomUUID()}`
  const mcpUrl = buildMilestoneVerifierMcpUrl({
    sessionId,
    jobId: input.jobId,
    milestoneId: input.milestone.id
  })
  const verdictWait = startVerdictWait<MilestoneVerificationVerdict>({
    sessionId,
    scopeLabel: 'milestone',
    targetId: input.milestone.id,
    signal: input.signal,
    unregister: unregisterMilestoneVerifierMcpSession,
    register: (handlers) => {
      registerMilestoneVerifierMcpSession({
        sessionId,
        jobId: input.jobId,
        milestoneId: input.milestone.id,
        ...handlers
      })
    }
  })

  const prompt = buildMilestoneVerifierEvidenceBundle({
    workspacePath: input.workspacePath,
    plan: input.plan,
    milestone: input.milestone,
    slices: input.slices,
    taskItems: input.taskItems,
    sliceVerdicts: sliceVerdictsFromProgress(input.progressSlices)
  })

  try {
    for await (const chunk of streamAgentTurn({
      role: 'milestone-verifier',
      provider: core.code as SupportedCoreCode,
      workspaceRoot: input.workspacePath,
      runtimeRoot,
      prompt,
      model,
      systemPrompt: buildMilestoneVerifierSystemPrompt(),
      mcpUrl,
      signal: input.signal
    })) {
      if (chunk.type === 'completed') {
        verdictWait.resetTimeout(VERIFIER_VERDICT_GRACE_MS)
        break
      }
    }
  } catch (error) {
    verdictWait.cancel()
    const message = error instanceof Error ? error.message : 'Milestone verifier agent failed'
    return { ok: false, message, infraMiss: true }
  }

  try {
    const verdict = await verdictWait.promise
    if (verdict.status === 'passed') {
      return { ok: true, message: verdict.summary, verdict }
    }
    return {
      ok: false,
      message: `${verdict.status}: ${verdict.summary}`,
      verdict
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Timed out waiting for complete_milestone_verification'
    return { ok: false, message, infraMiss: true }
  }
}

export { toSliceVerificationRecord }
