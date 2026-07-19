import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoSecrets, redactValue } from './redaction'
import type { RoleProviders } from '../config/profiles'

export type FailureClass =
  | 'assertion_failed'
  | 'agent_failed'
  | 'agent_no_report'
  | 'provider_auth_missing'
  | 'provider_unavailable'
  | 'provider_transport'
  | 'mcp_failed'
  | 'http_contract'
  | 'oracle_failed'
  | 'security_violation'
  | 'resource_leak'
  | 'sut_crash'
  | 'runner_crash'
  | 'timeout'
  | 'skipped'
  | 'passed'

export type CaseReport = {
  runId: string
  caseRunId: string
  caseId: string
  driverProvider: string
  roleProviders: RoleProviders
  agentReportedCompleted: boolean
  requiredOperationsObserved: boolean
  oraclePassed: boolean
  noProcessLeak: boolean
  classification: FailureClass
  summary: string
  agentReport?: unknown
  oracleResults?: unknown
  ledgerOps?: unknown
  serverPid?: number
  durationMs: number
  error?: string
}

export type RunSummary = {
  runId: string
  profile: string
  baseUrl: string
  serverPid: number
  startedAt: string
  finishedAt: string
  passed: number
  failed: number
  skipped: number
  cases: Array<{ caseId: string; classification: FailureClass }>
}

export class ReportWriter {
  constructor(private readonly reportsDir: string) {
    mkdirSync(reportsDir, { recursive: true })
  }

  writeCase(report: CaseReport): void {
    const safe = redactValue(report) as CaseReport
    assertNoSecrets(safe, `case_${report.caseId}`)
    writeFileSync(
      join(this.reportsDir, `case-${report.caseId}-${report.caseRunId}.json`),
      JSON.stringify(safe, null, 2),
      'utf8'
    )
  }

  writeSummary(summary: RunSummary): void {
    const safe = redactValue(summary)
    assertNoSecrets(safe, 'run_summary')
    writeFileSync(join(this.reportsDir, 'summary.json'), JSON.stringify(safe, null, 2), 'utf8')
  }

  writeManifest(manifest: unknown): void {
    const safe = redactValue(manifest)
    assertNoSecrets(safe, 'manifest')
    writeFileSync(
      join(this.reportsDir, '..', 'manifest.json'),
      JSON.stringify(safe, null, 2),
      'utf8'
    )
  }
}
