import type { Migration } from './types'
import {
  createThreadMessagePointerTriggers,
  repairMissingThreadMessagesTable,
  rebuildThreadMessagesKindConstraint,
  tableExists,
  threadMessagesAllowsWizardHandoff
} from './thread-message-pointer-triggers'

export const migration011RepairThreadMessagesTable: Migration = {
  version: 11,
  name: 'repair_thread_messages_table',
  up(db) {
    if (!tableExists(db, 'thread_messages')) {
      repairMissingThreadMessagesTable(db)
    }

    if (!threadMessagesAllowsWizardHandoff(db) && tableExists(db, 'thread_messages')) {
      rebuildThreadMessagesKindConstraint(db)
      return
    }

    createThreadMessagePointerTriggers(db)
  }
}
