import type { Migration } from './types.ts'
import {
  rebuildThreadMessagesKindConstraint,
  repairMissingThreadMessagesTable,
  tableExists,
  threadMessagesAllowsWizardHandoff
} from './thread-message-pointer-triggers.ts'

export const migration010WizardHandoffMessageKind: Migration = {
  version: 10,
  name: 'wizard_handoff_message_kind',
  up(db) {
    if (threadMessagesAllowsWizardHandoff(db)) return

    if (!tableExists(db, 'thread_messages')) {
      repairMissingThreadMessagesTable(db)
    }

    if (!threadMessagesAllowsWizardHandoff(db)) {
      rebuildThreadMessagesKindConstraint(db)
    }
  }
}
