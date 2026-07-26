export type {
  ArtifactRetentionKind,
  RetainedArtifact,
  RetentionPolicy
} from './types'
export { DEFAULT_RETENTION_POLICY } from './types'
export {
  computeExpiryMs,
  isExpiredArtifactEligible,
  selectEligibleArtifacts,
  ttlMsForKind
} from './eligibility'
