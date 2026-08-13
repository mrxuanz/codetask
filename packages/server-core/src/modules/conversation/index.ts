export {
  composeConversationModule,
  type ConversationModule,
  type ConversationModuleDeps
} from './composition.ts'
export { ConversationApplication } from './application/conversation-application.ts'
export {
  assertAttachmentOwnerId,
  assertFrozenAttachmentId,
  assertFrozenThreadId,
  FrozenIdError,
  type FrozenIdKind
} from './domain/attachment-ids.ts'
export {
  ConversationConflictError,
  ConversationForbiddenError,
  ConversationNotFoundError,
  ConversationValidationError,
  type Actor
} from './shared.ts'
