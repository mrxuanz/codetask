import type { PlanningSessionViewStatus } from '@codetask/contracts'

export type {
  PlanProgressDto,
  TaskProgressDto,
  TaskProgressItemDto,
  TaskProgressMilestoneDto,
  TaskProgressSliceDto,
  ThreadDraftSummaryDto,
  ThreadJobAbilityDto,
  PlanningSessionViewDto,
  UserDraftListItemDto,
  PlanningSessionViewStatus
} from '@codetask/contracts'

/** @deprecated Prefer PlanningSessionViewStatus — UI planning status, not Design session status. */
export type PlanningSessionStatus = PlanningSessionViewStatus
