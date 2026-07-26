/**
 * Legacy API Guard
 *
 * After cutover to cutover_blocked, legacy write APIs return 410 Gone.
 */

import type { CutoverMarker } from './cutover-marker'

export function createLegacyApiGuard(marker: CutoverMarker): {
  isBlocked(): boolean
  assertNotBlocked(): void
} {
  return {
    isBlocked(): boolean {
      return marker.value === 'cutover_blocked'
    },

    assertNotBlocked(): void {
      if (marker.value === 'cutover_blocked') {
        throw new LegacyApiBlockedError()
      }
    }
  }
}

export class LegacyApiBlockedError extends Error {
  readonly statusCode = 410
  readonly code = 'api.legacy_blocked'

  constructor() {
    super('Legacy API is blocked after cutover to cutover_blocked')
    this.name = 'LegacyApiBlockedError'
  }
}
