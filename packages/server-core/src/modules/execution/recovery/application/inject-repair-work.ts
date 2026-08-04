import type Database from 'better-sqlite3'
import type { WorkKind } from '@codetask/contracts'
import { newId, nowMs } from '../../shared.ts'

export type InjectRepairInput = {
  jobId: string
  generation: number
  parentWorkId: string
  kind: WorkKind
  title: string
  description: string
  successCriteria: string
  abilityCode?: string
  providerCode?: string
  verdictId?: string
}

export type InjectRepairWorkService = {
  inject(input: InjectRepairInput): { workId: string; contentHash: string }
}

/**
 * Inject Repair Work as new job_work_items. Never mutates job_snapshots.execution_tree_json.
 */
export function createInjectRepairWorkService(deps: {
  db: Database.Database
}): InjectRepairWorkService {
  return {
    inject(input: InjectRepairInput): { workId: string; contentHash: string } {
      const parent = deps.db
        .prepare(`SELECT * FROM job_work_items WHERE job_id = ? AND id = ? AND generation = ?`)
        .get(input.jobId, input.parentWorkId, input.generation) as
        | Record<string, unknown>
        | undefined
      if (!parent) {
        throw new Error(`Parent work not found: ${input.parentWorkId}`)
      }

      const before = deps.db
        .prepare(`SELECT content_hash, execution_tree_json FROM job_snapshots WHERE job_id = ?`)
        .get(input.jobId) as { content_hash: string; execution_tree_json: string }

      const now = nowMs()
      const workId = newId('work')
      const sortOrder = Number(parent.sort_order) + 1000

      const genRow = deps.db
        .prepare(
          `SELECT COALESCE(MAX(generation_number), 0) AS n FROM repair_generations
           WHERE job_id = ? AND generation = ? AND scope_type = 'work' AND scope_id = ?`
        )
        .get(input.jobId, input.generation, input.parentWorkId) as { n: number }
      const generationNumber = Number(genRow.n) + 1

      const tx = deps.db.transaction(() => {
        deps.db
          .prepare(
            `INSERT INTO job_work_items (
              id, job_id, generation, source_task_id, parent_work_id, milestone_id, slice_id,
              kind, sort_order, title, description, context_markdown, ability_code, provider_code,
              success_criteria, can_run_in_parallel, state, state_revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, 0, 'pending', 0, ?, ?)`
          )
          .run(
            workId,
            input.jobId,
            input.generation,
            String(parent.source_task_id),
            input.parentWorkId,
            String(parent.milestone_id),
            String(parent.slice_id),
            input.kind,
            sortOrder,
            input.title,
            input.description,
            input.abilityCode ?? String(parent.ability_code),
            input.providerCode ?? String(parent.provider_code),
            input.successCriteria,
            now,
            now
          )

        deps.db
          .prepare(
            `INSERT INTO job_work_dependencies (
              job_id, generation, from_work_id, depends_on_work_id, reason
            ) VALUES (?, ?, ?, ?, 'repair')`
          )
          .run(input.jobId, input.generation, workId, input.parentWorkId)

        deps.db
          .prepare(
            `INSERT INTO repair_generations (
              job_id, generation, scope_type, scope_id, generation_number,
              verdict_id, created_work_count, created_at
            ) VALUES (?, ?, 'work', ?, ?, ?, 1, ?)`
          )
          .run(
            input.jobId,
            input.generation,
            input.parentWorkId,
            generationNumber,
            input.verdictId ?? null,
            now
          )
      })
      tx()

      const after = deps.db
        .prepare(`SELECT content_hash, execution_tree_json FROM job_snapshots WHERE job_id = ?`)
        .get(input.jobId) as { content_hash: string; execution_tree_json: string }

      if (
        before.content_hash !== after.content_hash ||
        before.execution_tree_json !== after.execution_tree_json
      ) {
        throw new Error('Repair must not mutate job snapshot tree')
      }

      return { workId, contentHash: after.content_hash }
    }
  }
}
