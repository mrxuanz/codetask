import { getMessage } from '../conversation/messages'
import type { TaskLaunchDraftPayload, TaskLaunchDraftReference } from '../conversation/draft/types'
import type { ThreadJobDto } from './types'

export function mergeDraftReferences(payload: TaskLaunchDraftPayload): TaskLaunchDraftReference[] {
  const refs = [...payload.references]
  const seen = new Set(refs.map((item) => item.id))
  for (const attachment of payload.sourceAttachments ?? []) {
    if (seen.has(attachment.id)) continue
    seen.add(attachment.id)
    refs.push({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      kind: attachment.kind,
      assetUrl: attachment.assetUrl,
      description: '',
      source: 'message'
    })
  }
  return refs
}

export async function loadJobDraftReferences(
  username: string,
  job: Pick<ThreadJobDto, 'threadId' | 'draftMessageId'>
): Promise<TaskLaunchDraftReference[]> {
  const message = await getMessage(username, job.threadId, job.draftMessageId, {
    signAssets: false
  })
  if (!message || message.kind !== 'task-launch-draft') return []
  const payload = message.payload as TaskLaunchDraftPayload | undefined
  if (!payload?.draftId) return []
  return mergeDraftReferences(payload)
}
