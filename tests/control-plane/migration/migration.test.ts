import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  mapLegacyJob,
  mapLegacyJobs,
  hashFile,
  writeReport,
  readReport,
  validateCopyReport,
  backupDatabase,
  restoreDatabase,
  runPreflight,
  summarizeReport
} from '../../../scripts/control-plane/migration-lib'
import {
  canUpgradeTo,
  createInitialMarker,
  upgradeMarker,
  isAuthoritative
} from '../../../scripts/control-plane/cutover-marker'
import {
  createLegacyApiGuard,
  LegacyApiBlockedError
} from '../../../scripts/control-plane/legacy-api-guard'

describe('Migration copy', () => {
  it('should map legacy running job to failed/recoverable', () => {
    const result = mapLegacyJob({ id: 'job-1', status: 'running' })
    assert.equal(result.kind, 'mapped')
    if (result.kind === 'mapped') {
      assert.equal(result.value.state, 'failed')
      assert.ok(result.warnings.some((w) => w.includes('active execution')))
    }
  })

  it('should handle pausing jobs', () => {
    const result = mapLegacyJob({
      id: 'job-2',
      status: 'pausing',
      currentPlanRevision: 2,
      planConfirmedAt: 1
    })
    assert.equal(result.kind, 'mapped')
    if (result.kind === 'mapped') {
      assert.equal(result.value.state, 'paused')
      assert.equal(result.value.resumeTarget, 'execution_queued')
      assert.ok(result.warnings.length > 0)
    }
  })

  it('should detect conflicts', () => {
    const result = mapLegacyJob({
      id: 'job-3',
      status: 'completed',
      planProgress: { status: 'running' }
    })
    assert.equal(result.kind, 'conflict')
    if (result.kind === 'conflict') {
      assert.equal(result.code, 'migration.job_status_conflict')
    }
  })
})

describe('Migration CLI helpers', () => {
  it('should hash, write, and read reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-report-'))
    const reportPath = join(dir, 'report.json')
    const report = mapLegacyJobs([
      { id: 'job-a', status: 'paused' },
      { id: 'job-b', status: 'running' }
    ])
    assert.equal(report.hasConflicts, false)
    assert.equal(report.mappedCount, 2)

    const fileHash = writeReport(reportPath, report)
    assert.equal(fileHash, hashFile(reportPath))

    const loaded = readReport(reportPath)
    assert.equal(loaded.reportHash, report.reportHash)
    assert.equal(loaded.mappedCount, 2)

    const validation = validateCopyReport(loaded)
    assert.equal(validation.ok, true)
    assert.ok(summarizeReport(loaded).includes('reportHash:'))
  })

  it('should fail validate-copy when conflicts exist', () => {
    const report = mapLegacyJobs([
      {
        id: 'job-conflict',
        status: 'completed',
        planProgress: { status: 'running' }
      }
    ])
    assert.equal(report.hasConflicts, true)
    const validation = validateCopyReport(report)
    assert.equal(validation.ok, false)
    assert.ok(validation.errors.some((e) => e.includes('migration.has_conflicts')))
  })

  it('should backup and restore with sha256', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migration-backup-'))
    const dbPath = join(dir, 'app.db')
    const backupPath = join(dir, 'app.db.bak')
    const restoredPath = join(dir, 'app.restored.db')
    writeFileSync(dbPath, 'sqlite-bytes-fixture')

    const preflight = runPreflight(dbPath)
    assert.equal(preflight.ok, true)

    const backup = backupDatabase(dbPath, backupPath)
    assert.ok(existsSync(backup.sha256Path))
    assert.equal(backup.sha256, hashFile(backupPath))

    restoreDatabase(backupPath, restoredPath)
    assert.equal(readFileSync(restoredPath, 'utf8'), 'sqlite-bytes-fixture')
  })

  it('should fail preflight when db is missing', () => {
    const result = runPreflight(join(tmpdir(), 'missing-control-plane.db'))
    assert.equal(result.ok, false)
  })
})

describe('Cutover marker', () => {
  it('should allow preparing -> copied -> authoritative after validation', () => {
    const preparing = createInitialMarker()
    assert.equal(canUpgradeTo(preparing, 'copied'), true)
    assert.equal(canUpgradeTo(preparing, 'v3_authoritative'), false)

    const copied = upgradeMarker(preparing, 'copied', { hasConflicts: false })
    assert.equal(copied.ok, true)
    if (copied.ok) {
      assert.equal(copied.marker.value, 'copied')
      assert.equal(canUpgradeTo(copied.marker, 'v3_authoritative'), true)
      const authoritative = upgradeMarker(copied.marker, 'v3_authoritative', {
        hasConflicts: false
      })
      assert.equal(authoritative.ok, true)
    }
  })

  it('should block on conflicts', () => {
    const preparing = createInitialMarker()
    const blocked = upgradeMarker(preparing, 'copied', { hasConflicts: true })
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.equal(blocked.reason, 'migration.has_conflicts')
    }

    const copied = upgradeMarker(preparing, 'copied', { hasConflicts: false })
    assert.equal(copied.ok, true)
    if (copied.ok) {
      const blockedAuthoritative = upgradeMarker(copied.marker, 'v3_authoritative', {
        hasConflicts: true
      })
      assert.equal(blockedAuthoritative.ok, false)
    }
  })

  it('conflict-blocks-marker: report conflicts prevent cutover upgrade', () => {
    const report = mapLegacyJobs([
      {
        id: 'job-x',
        status: 'failed',
        planProgress: { status: 'running' }
      }
    ])
    assert.equal(report.hasConflicts, true)

    const preparing = createInitialMarker()
    const blocked = upgradeMarker(preparing, 'copied', {
      hasConflicts: report.hasConflicts,
      copyReportHash: report.reportHash
    })
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.equal(blocked.reason, 'migration.has_conflicts')
    }
  })

  it('should prevent duplicate cutover to v3_authoritative', () => {
    const preparing = createInitialMarker()
    const direct = upgradeMarker(preparing, 'v3_authoritative', { hasConflicts: false })
    assert.equal(direct.ok, false)
  })
})

describe('Legacy API', () => {
  it('should return 410 after cutover', () => {
    const preparing = createInitialMarker()
    const copied = upgradeMarker(preparing, 'copied', { hasConflicts: false })
    assert.equal(copied.ok, true)
    if (!copied.ok) return

    const authoritative = upgradeMarker(copied.marker, 'v3_authoritative', { hasConflicts: false })
    assert.equal(authoritative.ok, true)
    if (!authoritative.ok) return

    assert.equal(isAuthoritative(authoritative.marker), true)

    const guard = createLegacyApiGuard(authoritative.marker)
    assert.equal(guard.isBlocked(), true)
    assert.throws(() => guard.assertNotBlocked(), LegacyApiBlockedError)
    try {
      guard.assertNotBlocked()
    } catch (error) {
      assert.ok(error instanceof LegacyApiBlockedError)
      assert.equal(error.statusCode, 410)
      assert.equal(error.code, 'api.legacy_blocked')
    }
  })
})
