import { MAX_REPAIR_PER_SCOPE } from '../../verification/domain/verification-policy.ts'

export function canInjectRepair(existingCount: number): boolean {
  return existingCount < MAX_REPAIR_PER_SCOPE
}
