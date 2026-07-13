/**
 * Thin adapter: legacy job controls can call V3 Command Service when
 * control-plane tables are authoritative. Memory control state is no longer
 * the source of truth for pause/cancel after cutover.
 */
import { randomUUID } from 'crypto'
import { getControlPlaneServices, type ControlPlaneAppContext } from './control-plane-services'
import { LEGACY_RESUME_RUNNING_DISABLED } from './legacy-resume-running-disabled'

export { LEGACY_RESUME_RUNNING_DISABLED }

export async function pauseJobViaCommand(
  ctx: ControlPlaneAppContext,
  username: string,
  jobId: string,
  expectedRevision: number
): Promise<{ id: string; state: string; stateRevision: number }> {
  const { commandService } = getControlPlaneServices(ctx)
  const result = await commandService.requestPause({
    actor: { username, requestId: randomUUID() },
    jobId,
    expectedRevision,
    idempotencyKey: randomUUID()
  })
  return result.job
}

export async function cancelJobViaCommand(
  ctx: ControlPlaneAppContext,
  username: string,
  jobId: string,
  expectedRevision: number,
  reasonCode = 'user_cancelled'
): Promise<{ id: string; state: string; stateRevision: number; runIdToStop: string | null }> {
  const { commandService } = getControlPlaneServices(ctx)
  const result = await commandService.cancelJob({
    actor: { username, requestId: randomUUID() },
    jobId,
    expectedRevision,
    idempotencyKey: randomUUID(),
    payload: { reasonCode }
  })
  return { ...result.job, runIdToStop: result.runIdToStop }
}

export async function continueJobViaCommand(
  ctx: ControlPlaneAppContext,
  username: string,
  jobId: string,
  expectedRevision: number
): Promise<{ id: string; state: string; stateRevision: number }> {
  const { commandService } = getControlPlaneServices(ctx)
  const result = await commandService.continueJob({
    actor: { username, requestId: randomUUID() },
    jobId,
    expectedRevision,
    idempotencyKey: randomUUID()
  })
  return result.job
}

export async function restartJobViaCommand(
  ctx: ControlPlaneAppContext,
  username: string,
  jobId: string,
  expectedRevision: number
): Promise<{ id: string; state: string; stateRevision: number }> {
  const { commandService } = getControlPlaneServices(ctx)
  const result = await commandService.restartExecution({
    actor: { username, requestId: randomUUID() },
    jobId,
    expectedRevision,
    idempotencyKey: randomUUID(),
    payload: {}
  })
  return result.job
}
