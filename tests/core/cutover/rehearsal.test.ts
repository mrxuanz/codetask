import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CUTOVER_SCRIPTS = join(REPO_ROOT, 'scripts/cutover')
const FIXTURE_REPORT = join(
  REPO_ROOT,
  'docs/refactor/fixtures/cutover/rehearsal-report.md'
)

function runCutoverScript(name: string, args: string[]): {
  status: number
  stdout: string
  stderr: string
  json: Record<string, unknown> | null
} {
  const script = join(CUTOVER_SCRIPTS, name)
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  let json: Record<string, unknown> | null = null
  const trimmed = stdout.trim()
  if (trimmed.startsWith('{')) {
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      json = null
    }
  }
  return {
    status: result.status ?? 1,
    stdout,
    stderr,
    json
  }
}

function buildLegacyFixture(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      title TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      active_draft_id TEXT,
      active_plan_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE thread_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE thread_jobs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      plan_revision INTEGER NOT NULL DEFAULT 0,
      draft_message_id TEXT,
      plan_confirmed_at INTEGER,
      plan_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER
    );
    CREATE TABLE job_tasks (
      job_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (job_id, task_id)
    );
  `)

  const now = 1_700_000_000_000
  db.prepare(
    `INSERT INTO projects(id, username, title, workspace_root, created_at, updated_at)
     VALUES ('proj-sample-001', 'user-sample', 'Demo', '$WORKSPACE/demo', ?, ?)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO threads(id, username, project_id, title, status, active_draft_id, created_at, updated_at)
     VALUES ('thread-sample-001', 'user-sample', 'proj-sample-001', 'Hello', 'active', 'draft-sample-001', ?, ?)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO thread_messages(id, thread_id, username, role, kind, content, payload_json, created_at)
     VALUES ('draft-sample-001', 'thread-sample-001', 'user-sample', 'assistant', 'draft', 'Build a notes app', '{}', ?)`
  ).run(String(now))
  db.prepare(
    `INSERT INTO thread_jobs(
       id, thread_id, status, plan_revision, draft_message_id, plan_confirmed_at,
       created_at, updated_at, terminal_at
     ) VALUES ('job-sample-001', 'thread-sample-001', 'queued', 1, 'draft-sample-001', NULL, ?, ?, NULL)`
  ).run(now, now)
  db.prepare(
    `INSERT INTO job_tasks(job_id, task_id, title, sort_order, status)
     VALUES ('job-sample-001', 'task-sample-001', 'Scaffold', 0, 'pending')`
  ).run()
  db.close()
}

function buildEmptyLegacyDb(path: string): void {
  const db = new Database(path)
  db.close()
}

function writeArchivedReport(input: {
  emptyCounts: Record<string, number>
  fixtureCounts: Record<string, number>
  fixtureHash: string
}): void {
  mkdirSync(dirname(FIXTURE_REPORT), { recursive: true })
  const body = `# Cutover rehearsal report (sample)

Sanitized archive of a successful Wave 9 fixture rehearsal.
Paths below use placeholders — this file must stay machine-independent.

## Environment

- Mode: fixture / temp dirs only (no production user data)
- Data dir: \`$DATA_DIR/cutover-rehearsal\`
- Legacy DB (empty): \`$DATA_DIR/legacy-empty.sqlite\`
- Legacy DB (fixture): \`$DATA_DIR/legacy-fixture.sqlite\`
- Artifact manifest: \`$DATA_DIR/artifact-manifest.json\`
- Backup out: \`$DATA_DIR/backup\`
- Core targets: \`$DATA_DIR/core-empty.sqlite\`, \`$DATA_DIR/core-fixture.sqlite\`

## Steps

| Step | Result |
| --- | --- |
| stop-intake | ok (\`cutover.lock\` written) |
| backup | ok (db + artifact manifest copied) |
| migrate (empty) | ok |
| migrate (fixture) | ok |
| validate (empty) | ok (0 orphans) |
| validate (fixture) | ok (0 orphans) |
| boot-new | ok (\`createApplication\` smoke) |
| open-intake | ok (\`cutover.lock\` removed) |

## Migration counts

### Empty source

\`\`\`json
${JSON.stringify(input.emptyCounts, null, 2)}
\`\`\`

### Tiny fixture

\`\`\`json
${JSON.stringify(input.fixtureCounts, null, 2)}
\`\`\`

Fixture migration hash (sha256): \`${input.fixtureHash}\`

## Notes

- Rehearsal does **not** perform production cutover.
- Rollback policy: restore old binary + pre-migration backup; never reverse-write
  old schema from new (\`scripts/cutover/rollback.md\`).
- Generated/updated by \`tests/core/cutover/rehearsal.test.ts\`.
`
  writeFileSync(FIXTURE_REPORT, body, 'utf8')
}

describe('Wave 9 cutover rehearsal', () => {
  it('runs stop → backup → migrate → validate → boot → open on temp dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'codetask-cutover-rehearsal-'))
    const dataDir = join(root, 'data')
    const backupDir = join(root, 'backup')
    const emptySource = join(root, 'legacy-empty.sqlite')
    const fixtureSource = join(root, 'legacy-fixture.sqlite')
    const emptyTarget = join(root, 'core-empty.sqlite')
    const fixtureTarget = join(root, 'core-fixture.sqlite')
    const artifacts = join(root, 'artifact-manifest.json')

    try {
      mkdirSync(dataDir, { recursive: true })
      writeFileSync(
        artifacts,
        `${JSON.stringify(
          {
            version: 1,
            artifacts: [
              {
                id: 'art-sample-001',
                kind: 'job_log',
                relativePath: 'blobs/artifacts/jobs/ab/abcd.json.gz'
              }
            ]
          },
          null,
          2
        )}\n`
      )
      buildEmptyLegacyDb(emptySource)
      buildLegacyFixture(fixtureSource)

      const stop = runCutoverScript('stop-intake.mjs', ['--data-dir', dataDir])
      assert.equal(stop.status, 0, stop.stderr || stop.stdout)
      assert.equal(stop.json?.ok, true)
      const lockPath = join(dataDir, 'cutover.lock')
      assert.equal(existsSync(lockPath), true)

      const backup = runCutoverScript('backup.mjs', [
        '--db',
        fixtureSource,
        '--artifacts',
        artifacts,
        '--out',
        backupDir
      ])
      assert.equal(backup.status, 0, backup.stderr || backup.stdout)
      assert.equal(backup.json?.ok, true)
      assert.equal(existsSync(join(backupDir, 'legacy-fixture.sqlite')), true)
      assert.equal(existsSync(join(backupDir, 'artifact-manifest.json')), true)
      assert.equal(existsSync(join(backupDir, 'backup-manifest.json')), true)

      const migrateEmpty = runCutoverScript('migrate.mjs', [
        '--source',
        emptySource,
        '--target',
        emptyTarget
      ])
      assert.equal(migrateEmpty.status, 0, migrateEmpty.stderr || migrateEmpty.stdout)
      assert.equal(migrateEmpty.json?.ok, true)
      const emptyCounts = (migrateEmpty.json?.counts ?? {}) as Record<string, number>
      assert.equal(emptyCounts.threads, 0)
      assert.equal(emptyCounts.jobs, 0)

      const migrateFixture = runCutoverScript('migrate.mjs', [
        '--source',
        fixtureSource,
        '--target',
        fixtureTarget
      ])
      assert.equal(
        migrateFixture.status,
        0,
        migrateFixture.stderr || migrateFixture.stdout
      )
      assert.equal(migrateFixture.json?.ok, true)
      const fixtureCounts = (migrateFixture.json?.counts ?? {}) as Record<string, number>
      assert.equal(fixtureCounts.projects, 1)
      assert.equal(fixtureCounts.threads, 1)
      assert.equal(fixtureCounts.drafts, 1)
      assert.equal(fixtureCounts.plans, 1)
      assert.equal(fixtureCounts.jobs, 1)
      assert.equal(fixtureCounts.tasks, 1)
      const fixtureHash = String(migrateFixture.json?.hash ?? '')
      assert.match(fixtureHash, /^[a-f0-9]{64}$/)

      const validateEmpty = runCutoverScript('validate.mjs', ['--db', emptyTarget])
      assert.equal(validateEmpty.status, 0, validateEmpty.stderr || validateEmpty.stdout)
      assert.equal(validateEmpty.json?.ok, true)
      assert.equal(validateEmpty.json?.totalOrphans, 0)

      const validateFixture = runCutoverScript('validate.mjs', ['--db', fixtureTarget])
      assert.equal(
        validateFixture.status,
        0,
        validateFixture.stderr || validateFixture.stdout
      )
      assert.equal(validateFixture.json?.ok, true)
      assert.equal(validateFixture.json?.totalOrphans, 0)

      const boot = runCutoverScript('boot-new.mjs', [])
      assert.equal(boot.status, 0, boot.stderr || boot.stdout)
      assert.equal(boot.json?.ok, true)

      const open = runCutoverScript('open-intake.mjs', ['--data-dir', dataDir])
      assert.equal(open.status, 0, open.stderr || open.stdout)
      assert.equal(open.json?.ok, true)
      assert.equal(existsSync(lockPath), false)

      const tmpReport = join(root, 'rehearsal-report.md')
      writeFileSync(
        tmpReport,
        `# temp rehearsal\nempty=${JSON.stringify(emptyCounts)}\nfixture=${JSON.stringify(fixtureCounts)}\nhash=${fixtureHash}\n`,
        'utf8'
      )
      assert.equal(existsSync(tmpReport), true)

      writeArchivedReport({ emptyCounts, fixtureCounts, fixtureHash })
      const archived = readFileSync(FIXTURE_REPORT, 'utf8')
      assert.match(archived, /Cutover rehearsal report/)
      assert.match(archived, /\$DATA_DIR/)
      assert.doesNotMatch(archived, /\/home\//)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
