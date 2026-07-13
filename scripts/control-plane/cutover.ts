#!/usr/bin/env node
/**
 * Upgrade cutover marker preparing → copied → v3_authoritative.
 * Blocks when the copy report has conflicts.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/cutover.ts --marker <marker.json> --target copied|v3_authoritative [--report <report.json>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  createInitialMarker,
  upgradeMarker,
  type CutoverMarker,
  type SchemaGeneration
} from './cutover-marker'
import { parseArgs, readReport, requireArg } from './migration-lib'

function isSchemaGeneration(value: string): value is SchemaGeneration {
  return value === 'copied' || value === 'v3_authoritative' || value === 'preparing'
}

function readMarker(path: string): CutoverMarker {
  if (!existsSync(path)) {
    return createInitialMarker()
  }
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('migration.marker_invalid')
  }
  const row = parsed as Record<string, unknown>
  if (
    row.key !== 'control_schema_generation' ||
    typeof row.value !== 'string' ||
    !isSchemaGeneration(row.value) ||
    typeof row.sourceMigration !== 'number' ||
    typeof row.updatedAtMs !== 'number'
  ) {
    throw new Error('migration.marker_invalid')
  }
  return {
    key: 'control_schema_generation',
    value: row.value,
    sourceMigration: row.sourceMigration,
    copyReportHash: typeof row.copyReportHash === 'string' ? row.copyReportHash : null,
    backupId: typeof row.backupId === 'string' ? row.backupId : null,
    updatedAtMs: row.updatedAtMs
  }
}

function writeMarker(path: string, marker: CutoverMarker): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const markerPath = requireArg(args, 'marker')
  const targetRaw = requireArg(args, 'target')
  if (targetRaw !== 'copied' && targetRaw !== 'v3_authoritative') {
    throw new Error('migration.invalid_target: use copied|v3_authoritative')
  }
  const target: SchemaGeneration = targetRaw

  const reportPath = typeof args.report === 'string' ? args.report : null
  let hasConflicts = false
  let copyReportHash: string | null = null

  if (reportPath) {
    const report = readReport(reportPath)
    hasConflicts = report.hasConflicts
    copyReportHash = report.reportHash
  }

  const current = readMarker(markerPath)
  const result = upgradeMarker(current, target, {
    hasConflicts,
    ...(copyReportHash !== null ? { copyReportHash } : {})
  })

  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, reason: result.reason, marker: current }, null, 2))
    process.exit(1)
  }

  writeMarker(markerPath, result.marker)
  console.log(JSON.stringify({ ok: true, marker: result.marker }, null, 2))
}

main()
