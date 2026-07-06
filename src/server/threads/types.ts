export const DEFAULT_THREAD_TITLE = 'New thread'
export const THREAD_STATUS_DRAFT = 'draft'
export const DEFAULT_CORE_CODE = 'codex'
export const RUNTIME_STATUS_IDLE = 'idle'
export const RUNTIME_STATUS_RUNNING = 'running'
export const RUNTIME_STATUS_ERROR = 'error'
export const TITLE_SOURCE_AUTO = 'auto'
export const TITLE_SOURCE_MANUAL = 'manual'
export const THREAD_KIND_CHAT = 'chat'
export const THREAD_KIND_CREATE_TASK = 'create_task'

export type TitleSource = typeof TITLE_SOURCE_AUTO | typeof TITLE_SOURCE_MANUAL
export type ThreadKind = typeof THREAD_KIND_CHAT | typeof THREAD_KIND_CREATE_TASK

export type { ThreadDto } from '@shared/contracts/threads'
export type { WizardPhase } from '../wizard/types'
export type { CoreRuntimeMap } from '../wizard/core-runtime'
