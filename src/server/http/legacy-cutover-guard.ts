/**
 * Legacy write-route cutover guard.
 *
 * When schema generation is `v3_authoritative`, legacy control write APIs return 410 Gone.
 */

import type { MiddlewareHandler } from 'hono'
import {
  createLegacyApiGuard,
  LegacyApiBlockedError
} from '../../../scripts/control-plane/legacy-api-guard'
import { createInitialMarker } from '../../../scripts/control-plane/cutover-marker'
import { getSchemaGeneration } from '../application/cutover-schema-generation'
import { fail } from '../response'

export function createLegacyCutoverGuard(): MiddlewareHandler {
  return async (c, next) => {
    const marker = {
      ...createInitialMarker(),
      value: getSchemaGeneration()
    }
    const guard = createLegacyApiGuard(marker)
    if (!guard.isBlocked()) {
      await next()
      return
    }

    const error = new LegacyApiBlockedError()
    return c.json(fail(41001, error.message, { error: error.message, code: error.code }), 410)
  }
}

export { LegacyApiBlockedError }
