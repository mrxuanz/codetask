/**
 * Schema generation reader for legacy cutover guards.
 *
 * Delegates to cutover-state (strict DB read + in-memory test override).
 */

import {
  getCutoverMarker,
  isV3Authoritative,
  setCutoverMarkerForTests,
  type SchemaGeneration
} from './cutover-state'

export type { SchemaGeneration }

export function getSchemaGeneration(): SchemaGeneration {
  return getCutoverMarker()
}

export function setSchemaGeneration(value: SchemaGeneration): void {
  setCutoverMarkerForTests(value)
}

export function resetSchemaGeneration(): void {
  setCutoverMarkerForTests(null)
}

export { isV3Authoritative }
