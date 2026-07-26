import type { SqliteDatabase } from '../migrate-core'
import type {
  CasResult,
  CorePlanEdgeRecord,
  CorePlanNodeRecord,
  CorePlanRecord,
  PlanRepository
} from '../ports'

type PlanRow = {
  id: string
  project_id: string
  thread_id: string
  draft_id: string | null
  status: string
  revision: number
  execution_generation: number
  payload_json: string
  created_at_ms: number
  updated_at_ms: number
}

type NodeRow = {
  id: string
  plan_id: string
  kind: string
  title: string
  parent_id: string | null
  sort_order: number
  payload_json: string
  created_at_ms: number
  updated_at_ms: number
}

type EdgeRow = {
  plan_id: string
  from_node_id: string
  to_node_id: string
}

function mapPlan(row: PlanRow): CorePlanRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    threadId: row.thread_id,
    draftId: row.draft_id,
    status: row.status,
    revision: row.revision,
    executionGeneration: row.execution_generation,
    payloadJson: row.payload_json,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  }
}

function mapNode(row: NodeRow): CorePlanNodeRecord {
  return {
    id: row.id,
    planId: row.plan_id,
    kind: row.kind,
    title: row.title,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    payloadJson: row.payload_json,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms
  }
}

export class SqlitePlanRepository implements PlanRepository {
  constructor(private readonly db: SqliteDatabase) {}

  get(id: string): CorePlanRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, thread_id, draft_id, status, revision, execution_generation,
                payload_json, created_at_ms, updated_at_ms
         FROM core_plans WHERE id = ?`
      )
      .get(id) as PlanRow | undefined
    return row ? mapPlan(row) : null
  }

  save(row: CorePlanRecord): void {
    this.db
      .prepare(
        `INSERT INTO core_plans(
           id, project_id, thread_id, draft_id, status, revision, execution_generation,
           payload_json, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           thread_id = excluded.thread_id,
           draft_id = excluded.draft_id,
           status = excluded.status,
           revision = excluded.revision,
           execution_generation = excluded.execution_generation,
           payload_json = excluded.payload_json,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(
        row.id,
        row.projectId,
        row.threadId,
        row.draftId,
        row.status,
        row.revision,
        row.executionGeneration,
        row.payloadJson,
        row.createdAtMs,
        row.updatedAtMs
      )
  }

  replaceGraph(input: {
    readonly plan: CorePlanRecord
    readonly nodes: readonly CorePlanNodeRecord[]
    readonly edges: readonly CorePlanEdgeRecord[]
  }): void {
    const replace = this.db.transaction(() => {
      this.save(input.plan)
      this.db.prepare(`DELETE FROM core_plan_edges WHERE plan_id = ?`).run(input.plan.id)
      this.db.prepare(`DELETE FROM core_plan_nodes WHERE plan_id = ?`).run(input.plan.id)
      const insertNode = this.db.prepare(
        `INSERT INTO core_plan_nodes(
           id, plan_id, kind, title, parent_id, sort_order, payload_json,
           created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const node of input.nodes) {
        insertNode.run(
          node.id,
          node.planId,
          node.kind,
          node.title,
          node.parentId,
          node.sortOrder,
          node.payloadJson,
          node.createdAtMs,
          node.updatedAtMs
        )
      }
      const insertEdge = this.db.prepare(
        `INSERT INTO core_plan_edges(plan_id, from_node_id, to_node_id) VALUES (?, ?, ?)`
      )
      for (const edge of input.edges) {
        insertEdge.run(edge.planId, edge.fromNodeId, edge.toNodeId)
      }
    })
    replace()
  }

  listNodes(planId: string): readonly CorePlanNodeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, plan_id, kind, title, parent_id, sort_order, payload_json,
                created_at_ms, updated_at_ms
         FROM core_plan_nodes WHERE plan_id = ? ORDER BY sort_order, id`
      )
      .all(planId) as NodeRow[]
    return rows.map(mapNode)
  }

  listEdges(planId: string): readonly CorePlanEdgeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT plan_id, from_node_id, to_node_id
         FROM core_plan_edges WHERE plan_id = ?`
      )
      .all(planId) as EdgeRow[]
    return rows.map((row) => ({
      planId: row.plan_id,
      fromNodeId: row.from_node_id,
      toNodeId: row.to_node_id
    }))
  }

  compareAndSet(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly next: Omit<CorePlanRecord, 'id' | 'revision' | 'createdAtMs'> & {
      readonly revision?: number
    }
  }): CasResult {
    const newRevision = input.expectedRevision + 1
    const result = this.db
      .prepare(
        `UPDATE core_plans SET
           project_id = ?,
           thread_id = ?,
           draft_id = ?,
           status = ?,
           revision = ?,
           execution_generation = ?,
           payload_json = ?,
           updated_at_ms = ?
         WHERE id = ? AND revision = ?`
      )
      .run(
        input.next.projectId,
        input.next.threadId,
        input.next.draftId,
        input.next.status,
        newRevision,
        input.next.executionGeneration,
        input.next.payloadJson,
        input.next.updatedAtMs,
        input.id,
        input.expectedRevision
      )
    return result.changes === 1
      ? { ok: true, newRevision }
      : { ok: false, reason: 'revision_conflict' }
  }
}
