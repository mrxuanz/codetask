import type Database from 'better-sqlite3'
import type { DraftAbility, DraftReference, ExecutionProfile } from '@codetask/contracts'
import type { DraftRecord } from '../domain/draft.ts'
import type { DraftRepository } from '../application/ports.ts'
import { DesignConflictError } from '../../shared.ts'
import { isActivePlanningStatus } from '../../planning/domain/planning.ts'
import type { PlanningSessionStatus } from '@codetask/contracts'

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

type DraftRow = {
  id: string
  actor_id: string
  project_id: string
  title: string
  summary: string
  user_flow: string
  tech_stack: string
  nfr_json: string
  acceptance_json: string
  verification_json: string
  out_of_scope_json: string
  assumptions_json: string
  requirements_markdown: string
  requirements_status: 'pending' | 'confirmed'
  locked_sections_json: string
  execution_profile_json: string | null
  workspace_root: string
  status: DraftRecord['status']
  lock_revision: number
  created_at: number
  updated_at: number
}

export class SqliteDraftRepository implements DraftRepository {
  constructor(private readonly db: Database.Database) {}

  async list(input: {
    actorId: string
    q?: string
    completion?: 'all' | 'incomplete' | 'complete'
  }): Promise<DraftRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM drafts WHERE actor_id = ? ORDER BY updated_at DESC LIMIT 500`
      )
      .all(input.actorId) as DraftRow[]
    let drafts = rows.map((row) => this.hydrate(row))
    if (input.q?.trim()) {
      const q = input.q.trim().toLowerCase()
      drafts = drafts.filter(
        (d) =>
          d.title.toLowerCase().includes(q) ||
          d.summary.toLowerCase().includes(q)
      )
    }
    if (input.completion === 'incomplete') {
      drafts = drafts.filter((d) => d.status !== 'confirmed' && d.status !== 'archived')
    } else if (input.completion === 'complete') {
      drafts = drafts.filter((d) => d.status === 'confirmed')
    }
    return drafts
  }

  async getById(draftId: string): Promise<DraftRecord | null> {
    const row = this.db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(draftId) as
      | DraftRow
      | undefined
    return row ? this.hydrate(row) : null
  }

  async insert(draft: DraftRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO drafts (
          id, actor_id, project_id, title, summary, user_flow, tech_stack,
          nfr_json, acceptance_json, verification_json, out_of_scope_json, assumptions_json,
          requirements_markdown, requirements_status, locked_sections_json, execution_profile_json,
          workspace_root, status, lock_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        draft.id,
        draft.actorId,
        draft.projectId,
        draft.title,
        draft.summary,
        draft.userFlow,
        draft.techStack,
        JSON.stringify(draft.nfr),
        JSON.stringify(draft.acceptance),
        JSON.stringify(draft.verification),
        JSON.stringify(draft.outOfScope),
        JSON.stringify(draft.assumptions),
        draft.requirementsMarkdown,
        draft.requirementsStatus,
        JSON.stringify(draft.lockedSections),
        draft.executionProfile ? JSON.stringify(draft.executionProfile) : null,
        draft.workspaceRoot,
        draft.status,
        draft.lockRevision,
        draft.createdAt,
        draft.updatedAt
      )
  }

  async update(draft: DraftRecord, expectedRevision: number): Promise<DraftRecord> {
    const result = this.db
      .prepare(
        `UPDATE drafts SET
          title = ?, summary = ?, user_flow = ?, tech_stack = ?,
          nfr_json = ?, acceptance_json = ?, verification_json = ?,
          out_of_scope_json = ?, assumptions_json = ?,
          requirements_markdown = ?, requirements_status = ?, locked_sections_json = ?,
          execution_profile_json = ?, workspace_root = ?, status = ?,
          lock_revision = ?, updated_at = ?
        WHERE id = ? AND lock_revision = ?`
      )
      .run(
        draft.title,
        draft.summary,
        draft.userFlow,
        draft.techStack,
        JSON.stringify(draft.nfr),
        JSON.stringify(draft.acceptance),
        JSON.stringify(draft.verification),
        JSON.stringify(draft.outOfScope),
        JSON.stringify(draft.assumptions),
        draft.requirementsMarkdown,
        draft.requirementsStatus,
        JSON.stringify(draft.lockedSections),
        draft.executionProfile ? JSON.stringify(draft.executionProfile) : null,
        draft.workspaceRoot,
        draft.status,
        draft.lockRevision,
        draft.updatedAt,
        draft.id,
        expectedRevision
      )
    if (result.changes !== 1) throw new DesignConflictError()
    return (await this.getById(draft.id))!
  }

  async replaceAbilities(draftId: string, abilities: DraftAbility[]): Promise<void> {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM draft_abilities WHERE draft_id = ?`).run(draftId)
      const insert = this.db.prepare(
        `INSERT INTO draft_abilities (
          draft_id, ability_code, label, description, reason, recommended_core_code, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      abilities.forEach((ability, index) => {
        insert.run(
          draftId,
          ability.abilityCode,
          ability.label,
          ability.description,
          ability.reason,
          ability.recommendedCoreCode,
          ability.sortOrder ?? index
        )
      })
    })
    tx()
  }

  async replaceReferences(draftId: string, references: DraftReference[]): Promise<void> {
    const now = Date.now()
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM design_draft_references WHERE draft_id = ?`).run(draftId)
      const insert = this.db.prepare(
        `INSERT INTO design_draft_references (
          id, draft_id, source, name, kind, mime_type, description,
          attachment_id, local_path, resolved_path, asset_url, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      references.forEach((ref, index) => {
        insert.run(
          ref.id,
          draftId,
          ref.source ?? null,
          ref.name,
          ref.kind,
          ref.mimeType ?? null,
          ref.description,
          ref.attachmentId ?? null,
          ref.localPath ?? null,
          ref.resolvedPath ?? null,
          ref.assetUrl ?? null,
          ref.sortOrder ?? index,
          now,
          now
        )
      })
    })
    tx()
  }

  async setExecutionProfile(draftId: string, profile: ExecutionProfile | null): Promise<void> {
    this.db
      .prepare(`UPDATE drafts SET execution_profile_json = ? WHERE id = ?`)
      .run(profile ? JSON.stringify(profile) : null, draftId)
  }

  async delete(draftId: string): Promise<void> {
    this.db.prepare(`DELETE FROM drafts WHERE id = ?`).run(draftId)
  }

  async countActivePlanningSessions(draftId: string): Promise<number> {
    const rows = this.db
      .prepare(`SELECT status FROM planning_sessions WHERE source_draft_id = ?`)
      .all(draftId) as Array<{ status: PlanningSessionStatus }>
    return rows.filter((r) => isActivePlanningStatus(r.status)).length
  }

  private hydrate(row: DraftRow): DraftRecord {
    const abilities = this.db
      .prepare(
        `SELECT ability_code, label, description, reason, recommended_core_code, sort_order
         FROM draft_abilities WHERE draft_id = ? ORDER BY sort_order ASC`
      )
      .all(row.id) as Array<{
      ability_code: string
      label: string
      description: string
      reason: string
      recommended_core_code: string
      sort_order: number
    }>
    const references = this.db
      .prepare(
        `SELECT * FROM design_draft_references WHERE draft_id = ? ORDER BY sort_order ASC`
      )
      .all(row.id) as Array<{
      id: string
      source: string | null
      name: string
      kind: DraftReference['kind']
      mime_type: string | null
      description: string
      attachment_id: string | null
      local_path: string | null
      resolved_path: string | null
      asset_url: string | null
      sort_order: number
    }>

    return {
      id: row.id,
      actorId: row.actor_id,
      projectId: row.project_id,
      title: row.title,
      summary: row.summary,
      userFlow: row.user_flow,
      techStack: row.tech_stack,
      nfr: parseJson(row.nfr_json, []),
      acceptance: parseJson(row.acceptance_json, []),
      verification: parseJson(row.verification_json, []),
      outOfScope: parseJson(row.out_of_scope_json, []),
      assumptions: parseJson(row.assumptions_json, []),
      requirementsMarkdown: row.requirements_markdown,
      requirementsStatus: row.requirements_status,
      lockedSections: parseJson(row.locked_sections_json, {}),
      executionProfile: row.execution_profile_json
        ? parseJson<ExecutionProfile | null>(row.execution_profile_json, null)
        : null,
      workspaceRoot: row.workspace_root,
      status: row.status,
      lockRevision: row.lock_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      abilities: abilities.map((a) => ({
        abilityCode: a.ability_code,
        label: a.label,
        description: a.description,
        reason: a.reason,
        recommendedCoreCode: a.recommended_core_code,
        sortOrder: a.sort_order
      })),
      references: references.map((r) => ({
        id: r.id,
        source: r.source ?? undefined,
        name: r.name,
        kind: r.kind,
        mimeType: r.mime_type ?? undefined,
        description: r.description,
        attachmentId: r.attachment_id ?? undefined,
        localPath: r.local_path ?? undefined,
        resolvedPath: r.resolved_path ?? undefined,
        assetUrl: r.asset_url ?? undefined,
        sortOrder: r.sort_order
      }))
    }
  }
}
