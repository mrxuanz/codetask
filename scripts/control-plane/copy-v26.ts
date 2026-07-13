#!/usr/bin/env node
/**
 * Copy legacy job snapshots via mapLegacyJob; write conflict report JSON.
 *
 * Usage:
 *   node --import tsx scripts/control-plane/copy-v26.ts --jobs <jobs.json> --report <report.json>
 *   node --import tsx scripts/control-plane/copy-v26.ts --db <app.db> --report <report.json>
 */

import { existsSync, readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import {
  mapLegacyJobs,
  parseArgs,
  parseLegacyJobSnapshots,
  requireArg,
  writeReport,
  type LegacyJobSnapshot
} from './migration-lib'

interface ThreadJobRow {
  readonly id: string
  readonly status: string
  readonly plan_status: string
  readonly plan_revision: number
  readonly plan_confirmed_at: number | null
}

function loadJobsFromDb(dbPath: string): LegacyJobSnapshot[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const rows = db
      .prepare(
        `SELECT id, status, plan_status, plan_revision, plan_confirmed_at
         FROM thread_jobs`
      )
      .all() as ThreadJobRow[]

    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      planProgress: { status: row.plan_status },
      currentPlanRevision: row.plan_confirmed_at != null ? row.plan_revision : null
    }))
  } finally {
    db.close()
  }
}

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

  const jobs = jobsPath ? loadJobsFromJson(jobsPath) : loadJobsFromDb(dbPath!)
  const report = mapLegacyJobs(jobs)
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
