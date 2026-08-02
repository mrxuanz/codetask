import type { AgentRuntime, AgentTurnInput } from '@codetask/agent-runtime'
import type Database from 'better-sqlite3'
import { newId, nowMs, stableHash } from '../../shared.ts'
import { WorkRepository } from '../infrastructure/work-repository.ts'
import { defaultCompletedEvidence } from '../../verification/domain/task-evidence.ts'
import { handleReportTaskResult } from '../mcp/task-result-tool.ts'
import {
  readJobExecutionSettings,
  taskMcpFromJobSettings
} from '../../job/application/job-settings-snapshot.ts'

export function createExecuteWorkService(deps: {
  db: Database.Database
  work: WorkRepository
  agentRuntime: AgentRuntime
  acceptResult: ReturnType<typeof import('./accept-work-result.ts').createAcceptWorkResultService>
}) {
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
        .prepare(`UPDATE work_attempts SET status = 'running', provider_started_at = ? WHERE id = ?`)
        .run(nowMs(), attemptId)

      const jobSettings = readJobExecutionSettings(deps.db, input.jobId)
      const userMcpServers = taskMcpFromJobSettings(jobSettings)

      const turnInput: AgentTurnInput = {
        role: 'task-worker',
        provider: work.providerCode,
        workspaceRoot: input.workspaceRoot,
        capabilityProfile: 'task-sandbox',
        prompt: work.description,
        systemPrompt: work.contextMarkdown,
        userMcpServers,
        scopeId: `job:${input.jobId}:run:${input.runId}:work:${input.workId}:attempt:${attemptId}`,
        turnId: attemptId
      }

      let completed = false
      let acceptedViaMcp = false
      for await (const event of deps.agentRuntime.runTurn(turnInput)) {
        if (event.type === 'tool_call' && event.name === 'report_task_result') {
          const evidence = handleReportTaskResult({ evidence: event.arguments })
          deps.acceptResult.accept({
            jobId: input.jobId,
            workId: input.workId,
            attemptId,
            evidence
          })
          acceptedViaMcp = true
          completed = true
          continue
        }
        if (event.type === 'completed') {
          completed = true
          break
        }
        if (event.type === 'failed') {
          deps.db
            .prepare(
              `UPDATE work_attempts SET status = 'interrupted', ended_at = ?, error_json = ? WHERE id = ?`
            )
            .run(nowMs(), JSON.stringify({ message: event.message }), attemptId)
          const current = deps.work.requireWork(input.jobId, input.workId)
          deps.work.casWorkState({
            jobId: input.jobId,
            workId: input.workId,
            expectedRevision: current.stateRevision,
            nextState: 'failed',
            updatedAt: nowMs()
          })
          return
        }
      }

      if (completed && !acceptedViaMcp) {
        deps.acceptResult.accept({
          jobId: input.jobId,
          workId: input.workId,
          attemptId,
          evidence: defaultCompletedEvidence(work.title)
        })
      }
    }
  }
}

export type ExecuteWorkService = ReturnType<typeof createExecuteWorkService>
