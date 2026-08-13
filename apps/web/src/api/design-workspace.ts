import type {
  PlanningSessionViewDto,
  ThreadDraftSummaryDto,
  UserDraftListItemDto
} from '@codetask/contracts'
import { api } from './client'
import {
  getPlanningSession,
  listDesignDrafts,
  listPlanningSessionsForDraft,
  type DesignDraftDto
} from './design'
import { resolveJobsApi } from './jobs-api'
import {
  mapDesignDraftToSummary,
  mapExecutionJobToPlanView,
  mapPlanningSessionToJob
} from './planning-view-mappers'
import type { ApiSuccess } from './types'

export async function listUserDraftViews(options?: {
  q?: string
  completion?: 'all' | 'incomplete' | 'complete'
}): Promise<ApiSuccess<{ drafts: UserDraftListItemDto[] }>> {
  const res = await listDesignDrafts(options)
  const drafts = await Promise.all(
    res.data.map(async (draft): Promise<UserDraftListItemDto> => {
      const sessions = (await listPlanningSessionsForDraft(draft.id)).data
      const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      return {
        messageId: draft.id,
        draftId: draft.id,
        title: draft.title,
        summary: draft.summary,
        status: draft.status,
        linkedPlanId: latest?.id ?? null,
        createdAt: new Date(draft.createdAt).toISOString(),
        plan: latest
          ? { id: latest.publishedJobId ?? latest.id, status: latest.status, title: draft.title }
          : null,
        projectId: draft.projectId,
        projectTitle: '',
        launched: Boolean(latest?.publishedJobId),
        jobId: latest?.publishedJobId ?? null
      }
    })
  )
  return { ...res, data: { drafts } }
}

export type ConversationDesignWorkspace = {
  drafts: ThreadDraftSummaryDto[]
  plans: PlanningSessionViewDto[]
}

export async function loadConversationDesignWorkspace(
  conversationId: string
): Promise<ApiSuccess<ConversationDesignWorkspace>> {
  const conversation = await api<{ projectId: string }>(
    `/api/conversations/${encodeURIComponent(conversationId)}`
  )
  const draftsRes = await listDesignDrafts()
  const drafts = draftsRes.data.filter(
    (draft) => draft.projectId === conversation.data.projectId && draft.status !== 'archived'
  )
  const sessionsByDraft = await Promise.all(
    drafts.map(async (draft) => ({
      draft,
      sessions: (await listPlanningSessionsForDraft(draft.id)).data
    }))
  )

  const draftViews = sessionsByDraft.map(({ draft, sessions }) => {
    const summary = mapDesignDraftToSummary(draft)
    const latest = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!latest) return summary
    return {
      ...summary,
      linkedPlanId: latest.id,
      designSessionId: latest.id,
      launchedJobId: latest.publishedJobId,
      plan: {
        id: latest.publishedJobId ?? latest.id,
        status: latest.status,
        title: draft.title
      }
    }
  })
  const plans = await Promise.all(
    sessionsByDraft.flatMap(({ draft, sessions }) =>
      sessions.map((session) => loadPlanningView(draft, session.id, session.publishedJobId))
    )
  )
  return { ...draftsRes, data: { drafts: draftViews, plans } }
}

async function loadPlanningView(
  draft: DesignDraftDto,
  sessionId: string,
  publishedJobId: string | null
): Promise<PlanningSessionViewDto> {
  if (publishedJobId) {
    try {
      const execution = await resolveJobsApi().fetchJob(publishedJobId)
      return mapExecutionJobToPlanView(execution.data.job)
    } catch {
      // Preserve the frozen Design tree while the Execution read is unavailable.
    }
  }
  const detail = await getPlanningSession(sessionId)
  return mapPlanningSessionToJob(detail.data.session, detail.data.tree, draft)
}

export async function loadLatestConversationPlan(
  conversationId: string
): Promise<ApiSuccess<{ job: PlanningSessionViewDto | null }>> {
  const workspace = await loadConversationDesignWorkspace(conversationId)
  const job =
    [...workspace.data.plans].sort((a, b) => {
      const aAt = Date.parse(String(a.updatedAt ?? a.createdAt ?? 0))
      const bAt = Date.parse(String(b.updatedAt ?? b.createdAt ?? 0))
      return bAt - aAt
    })[0] ?? null
  return { ...workspace, data: { job } }
}
