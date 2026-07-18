import type { ConversationMessageDto, ConversationStateDto } from './conversation'
import type { PlanProgressDto, TaskProgressDto, ThreadJobDto } from './jobs'
import type { SavedJobPlan } from './plan'
import type { ThreadDto } from './threads'

import type { TurnErrorDto } from './turn-errors'

export type ChatSseEvent =
  | { event: 'user_message'; data: { message: ConversationMessageDto } }
  | { event: 'assistant_start'; data: { messageId: string } }
  | { event: 'thinking_delta'; data: { content: string } }
  | { event: 'delta'; data: { content: string } }
  | { event: 'draft_message'; data: { message: ConversationMessageDto } }
  | { event: 'draft_updated'; data: { message: ConversationMessageDto } }
  | { event: 'plan_updated'; data: { job: ThreadJobDto } }
  | { event: 'assistant_message'; data: { message: ConversationMessageDto } }
  | { event: 'done'; data: { thread: ThreadDto; state: ConversationStateDto } }
  | { event: 'thread_updated'; data: { thread: ThreadDto } }
  | { event: 'heartbeat'; data: { ts: number } }
  | { event: 'error'; data: { message?: string; error?: TurnErrorDto } }

export type JobSseEvent =
  | { event: 'job_snapshot'; data: { job: ThreadJobDto } }
  | { event: 'plan_progress'; data: { planProgress: PlanProgressDto; plan?: SavedJobPlan | null } }
  | { event: 'task_progress'; data: { taskProgress: TaskProgressDto } }
  | { event: 'job_done'; data: { job: ThreadJobDto } }
  | { event: 'error'; data: { message?: string; error?: TurnErrorDto } }
