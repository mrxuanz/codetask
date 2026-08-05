import type { AgentRuntime, AgentTurnInput } from '@codetask/agent-runtime'
import { CODETASK_MANAGER_MCP_SERVER, MCP_HTTP_ACCEPT_HEADER_VALUE } from '@codetask/agent-runtime'
import type { TaskEvidence } from '@codetask/contracts'
import type Database from 'better-sqlite3'
import { newId, nowMs, stableHash } from '../../shared.ts'
import { WorkRepository } from '../infrastructure/work-repository.ts'
import { handleReportTaskResult } from '../mcp/task-result-tool.ts'
import { registerTaskMcpSession, unregisterTaskMcpSession } from '../mcp/task-session.ts'
import { tryBuildTaskWorkerMcpUrl } from '../mcp/task-url.ts'
import {
  readJobExecutionSettings,
  taskMcpFromJobSettings
} from '../../job/application/job-settings-snapshot.ts'
import type { RuntimeHandleRegistry } from '../../pool/infrastructure/runtime-handle-registry.ts'

/** Post-complete grace waiting for HTTP MCP report_task_result (legacy parity). */
export const TASK_EVIDENCE_GRACE_MS = 3 * 60 * 1000

export type ExecuteWorkService = {
  dispatch(input: {
    jobId: string
    workId: string
    runId: string
    workspaceRoot: string
  }): Promise<void>
}

export function createExecuteWorkService(deps: {
  db: Database.Database
  work: WorkRepository
  agentRuntime: AgentRuntime
  acceptResult: ReturnType<typeof import('./accept-work-result.ts').createAcceptWorkResultService>
  handles?: RuntimeHandleRegistry
  evidenceGraceMs?: number
}): ExecuteWorkService {
  return {
    async dispatch(input: {
      jobId: string
      workId: string
      runId: string
      workspaceRoot: string
    }): Promise<void> {
      const work = deps.work.requireWork(input.jobId, input.workId)
      if (work.state !== 'pending') return

      const now = nowMs()
      deps.work.casWorkState({
        jobId: input.jobId,
        workId: input.workId,
        expectedRevision: work.stateRevision,
        nextState: 'leased',
        updatedAt: now
      })

      const leased = deps.work.requireWork(input.jobId, input.workId)
      const attemptNumber =
        (
          deps.db
            .prepare(
              `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM work_attempts WHERE work_id = ?`
            )
            .get(input.workId) as { next: number }
        ).next ?? 1

      const attemptId = newId('attempt')
      const idempotencyKey = stableHash(
        `${input.jobId}:${input.workId}:${work.generation}:${work.sourceTaskId}`
      )
      const sessionId = `task-mcp-${attemptId}`

      deps.db
        .prepare(
          `INSERT INTO work_attempts (
            id, job_id, work_id, generation, run_id, attempt_number, idempotency_key,
            status, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', ?)`
        )
        .run(
          attemptId,
          input.jobId,
          input.workId,
          work.generation,
          input.runId,
          attemptNumber,
          idempotencyKey,
          now
        )

      deps.work.casWorkState({
        jobId: input.jobId,
        workId: input.workId,
        expectedRevision: leased.stateRevision,
        nextState: 'running',
        updatedAt: nowMs()
      })

      deps.db
        .prepare(
          `UPDATE work_attempts SET status = 'running', provider_started_at = ? WHERE id = ?`
        )
        .run(nowMs(), attemptId)

      const jobSettings = readJobExecutionSettings(deps.db, input.jobId)
      const userMcpServers = taskMcpFromJobSettings(jobSettings)

      const leaseRow = deps.db
        .prepare(
          `SELECT id AS leaseId FROM workspace_leases
           WHERE owner_type = 'job-run' AND owner_id = ? AND run_id = ?
             AND status = 'active'
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(input.jobId, input.runId) as { leaseId: string } | undefined

      const handle = deps.handles?.ensureAbortController(input.runId)
      const signal = handle?.signal

      let evidenceResolve!: (evidence: TaskEvidence) => void
      let evidenceReject!: (error: Error) => void
      let evidenceSettled = false
      const evidencePromise = new Promise<TaskEvidence>((resolve, reject) => {
        evidenceResolve = resolve
        evidenceReject = reject
      })
      // Prevent unhandled rejection when the wait is cancelled in finally.
      void evidencePromise.catch(() => {})

      registerTaskMcpSession({
        sessionId,
        jobId: input.jobId,
        taskId: work.sourceTaskId,
        idempotencyKey,
        resolve: (packet) => {
          if (evidenceSettled) return
          evidenceSettled = true
          evidenceResolve(packet)
        },
        reject: (error) => {
          if (evidenceSettled) return
          evidenceSettled = true
          evidenceReject(error)
        }
      })

      const mcpUrl = tryBuildTaskWorkerMcpUrl({
        sessionId,
        jobId: input.jobId,
        taskId: work.sourceTaskId,
        idempotencyKey
      })

      const turnInput: AgentTurnInput = {
        role: 'task-worker',
        provider: work.providerCode,
        workspaceRoot: input.workspaceRoot,
        capabilityProfile: 'task-sandbox',
        prompt: work.description,
        systemPrompt: work.contextMarkdown,
        userMcpServers,
        ...(mcpUrl
          ? {
              mcpServers: [
                {
                  name: CODETASK_MANAGER_MCP_SERVER,
                  url: mcpUrl,
                  headers: { Accept: MCP_HTTP_ACCEPT_HEADER_VALUE }
                }
              ]
            }
          : {}),
        scopeId: `job:${input.jobId}:run:${input.runId}:work:${input.workId}:attempt:${attemptId}`,
        turnId: attemptId,
        signal,
        workspaceAccess: 'exclusive-write',
        ...(leaseRow
          ? {
              workspaceLease: {
                leaseId: leaseRow.leaseId,
                ownerKind: 'job-run',
                ownerId: input.jobId
              }
            }
          : {})
      }

      deps.handles?.setTurnId(input.runId, attemptId)

      const failAttempt = (message: string, nextWorkState: 'failed' | 'pending'): void => {
        deps.db
          .prepare(
            `UPDATE work_attempts SET status = 'interrupted', ended_at = ?, error_json = ? WHERE id = ?`
          )
          .run(nowMs(), JSON.stringify({ message }), attemptId)
        const current = deps.work.requireWork(input.jobId, input.workId)
        if (
          current.state === 'running' ||
          current.state === 'leased' ||
          current.state === 'reported'
        ) {
          deps.work.casWorkState({
            jobId: input.jobId,
            workId: input.workId,
            expectedRevision: current.stateRevision,
            nextState: nextWorkState,
            updatedAt: nowMs()
          })
        }
      }

      const acceptEvidence = (evidence: TaskEvidence): void => {
        deps.acceptResult.accept({
          jobId: input.jobId,
          workId: input.workId,
          attemptId,
          evidence
        })
      }

      try {
        let turnCompleted = false
        let acceptedViaSideChannel = false

        for await (const event of deps.agentRuntime.runTurn(turnInput)) {
          if (event.type === 'tool_call' && event.name === 'report_task_result') {
            const evidence = handleReportTaskResult({ evidence: event.arguments })
            if (!evidenceSettled) {
              evidenceSettled = true
              evidenceResolve(evidence)
            }
            acceptEvidence(evidence)
            acceptedViaSideChannel = true
            continue
          }
          if (event.type === 'completed') {
            turnCompleted = true
            break
          }
          if (event.type === 'failed') {
            const aborted = Boolean(signal?.aborted)
            failAttempt(event.message, aborted ? 'pending' : 'failed')
            return
          }
        }

        if (acceptedViaSideChannel) return

        if (signal?.aborted) {
          failAttempt('Turn aborted by control', 'pending')
          return
        }

        if (!turnCompleted) {
          failAttempt('Provider turn ended without completion', 'failed')
          return
        }

        // Turn completed without tool_call — wait for HTTP MCP report_task_result, then fail.
        // Without an MCP URL (unit tests / unbound port), fail immediately.
        const graceMs = deps.evidenceGraceMs ?? (mcpUrl ? TASK_EVIDENCE_GRACE_MS : 0)
        let graceTimer: ReturnType<typeof setTimeout> | undefined
        try {
          const evidence = await Promise.race([
            evidencePromise,
            new Promise<TaskEvidence>((_, reject) => {
              graceTimer = setTimeout(() => {
                reject(new Error('Timed out waiting for report_task_result after turn completed'))
              }, graceMs)
            })
          ])
          acceptEvidence(evidence)
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Missing report_task_result evidence'
          failAttempt(message, 'failed')
        } finally {
          if (graceTimer !== undefined) clearTimeout(graceTimer)
        }
      } finally {
        unregisterTaskMcpSession(sessionId)
        deps.handles?.setTurnId(input.runId, null)
        if (!evidenceSettled) {
          evidenceSettled = true
          evidenceReject(new Error('Evidence wait cancelled by executor'))
        }
      }
    }
  }
}
