/**
 * Legacy API Guard
 *
 * After cutover to v3_authoritative, legacy write APIs return 410 Gone.
 */

import type { CutoverMarker } from './cutover-marker'

export function createLegacyApiGuard(marker: CutoverMarker): {
  isBlocked(): boolean
  assertNotBlocked(): void
} {
  return {
    isBlocked(): boolean {
      return marker.value === 'v3_authoritative'
    },

    assertNotBlocked(): void {
      if (marker.value === 'v3_authoritative') {
        throw new LegacyApiBlockedError()
      }
    }
  }
}

export class LegacyApiBlockedError extends Error {
  readonly statusCode = 410
  readonly code = 'api.legacy_blocked'

  constructor() {
    super('Legacy API is blocked after cutover to v3_authoritative')
    this.name = 'LegacyApiBlockedError'
  }
}
