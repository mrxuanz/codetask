import {
  controlCommandDedup,
  controlJobFailures,
  controlJobRuns,
  controlJobs,
  controlJobTasks,
  controlOutboxEvents,
  controlPlanMilestones,
  controlPlanRevisions,
  controlPlanSlices,
  controlPlanTasks,
  controlResourceSlots,
  controlSchemaMeta,
  controlTaskAttempts,
  controlVerifications
} from './schema'

export type ControlJob = typeof controlJobs.$inferSelect
export type NewControlJob = typeof controlJobs.$inferInsert

export type ControlJobRun = typeof controlJobRuns.$inferSelect
export type NewControlJobRun = typeof controlJobRuns.$inferInsert

export type ControlJobTask = typeof controlJobTasks.$inferSelect
export type NewControlJobTask = typeof controlJobTasks.$inferInsert

export type ControlTaskAttempt = typeof controlTaskAttempts.$inferSelect
export type NewControlTaskAttempt = typeof controlTaskAttempts.$inferInsert

export type ControlVerification = typeof controlVerifications.$inferSelect
export type NewControlVerification = typeof controlVerifications.$inferInsert

export type ControlOutboxEvent = typeof controlOutboxEvents.$inferSelect
export type NewControlOutboxEvent = typeof controlOutboxEvents.$inferInsert

export type ControlCommandDedup = typeof controlCommandDedup.$inferSelect
export type NewControlCommandDedup = typeof controlCommandDedup.$inferInsert

export type ControlResourceSlot = typeof controlResourceSlots.$inferSelect
export type NewControlResourceSlot = typeof controlResourceSlots.$inferInsert

export type ControlJobFailure = typeof controlJobFailures.$inferSelect
export type NewControlJobFailure = typeof controlJobFailures.$inferInsert

export type ControlPlanRevision = typeof controlPlanRevisions.$inferSelect
export type NewControlPlanRevision = typeof controlPlanRevisions.$inferInsert

export type ControlPlanMilestone = typeof controlPlanMilestones.$inferSelect
export type NewControlPlanMilestone = typeof controlPlanMilestones.$inferInsert

export type ControlPlanSlice = typeof controlPlanSlices.$inferSelect
export type NewControlPlanSlice = typeof controlPlanSlices.$inferInsert

export type ControlPlanTask = typeof controlPlanTasks.$inferSelect
export type NewControlPlanTask = typeof controlPlanTasks.$inferInsert

export type ControlSchemaMeta = typeof controlSchemaMeta.$inferSelect
export type NewControlSchemaMeta = typeof controlSchemaMeta.$inferInsert
