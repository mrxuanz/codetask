#!/usr/bin/env node
/**
 * Copy legacy job snapshots via mapLegacyJob; write conflict report JSON.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/copy-v26.ts --jobs <jobs.json> --report <report.json>
 *   node --import tsx scripts/control-plane/copy-v26.ts --db <app.db> --report <report.json>
 */

import { existsSync, readFileSync } from 'node:fs'
import {
  mapLegacyJobs,
  parseArgs,
  parseLegacyJobSnapshots,
  requireArg,
  writeReport
} from './migration-lib'
import { copyLegacyDatabase } from './migration-db'
import type { LegacyJobSnapshot } from './migration-lib'

function loadJobsFromJson(jobsPath: string): LegacyJobSnapshot[] {
  if (!existsSync(jobsPath)) {
    throw new Error(`migration.jobs_missing: ${jobsPath}`)
  }
  const parsed: unknown = JSON.parse(readFileSync(jobsPath, 'utf8'))
  return parseLegacyJobSnapshots(parsed)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const reportPath = requireArg(args, 'report')
  const jobsPath = typeof args.jobs === 'string' ? args.jobs : null
  const dbPath = typeof args.db === 'string' ? args.db : null

  if (!jobsPath && !dbPath) {
    throw new Error('provide --jobs <json> or --db <sqlite>')
  }

  const report = dbPath && !jobsPath ? copyLegacyDatabase(dbPath) : mapLegacyJobs(loadJobsFromJson(jobsPath!))
  const fileHash = writeReport(reportPath, report)
  console.log(
    JSON.stringify(
      {
        reportPath,
        fileHash,
        hasConflicts: report.hasConflicts,
        conflictCount: report.conflictCount,
        mappedCount: report.mappedCount,
        reportHash: report.reportHash
      },
      null,
      2
    )
  )
  if (report.hasConflicts) {
    process.exitCode = 2
  }
}

main()
