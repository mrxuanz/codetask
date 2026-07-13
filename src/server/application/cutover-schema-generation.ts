/**
 * Schema generation reader for legacy cutover guards.
 *
 * Delegates to cutover-state (DB meta + in-memory test override).
 * Defaults to `preparing` so legacy-only DBs and non-cutover runtimes stay open.
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
