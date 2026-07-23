#!/usr/bin/env node
/**
 * Reset launched thread_jobs back to design-session plan_editing.
 *
 * Usage:
 *   node scripts/reset-jobs-to-plan-edit.mjs --db <path> --job <jobId> [--job <jobId> ...] --apply
 *
 * Dry-run (default): omit --apply to only list matching rows.
 * Always requires explicit --db and at least one --job. Creates a .bak copy before write.
 */

import { copyFileSync, existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { resolve } from 'path'

function printUsage() {
  console.error(`Usage:
  node scripts/reset-jobs-to-plan-edit.mjs --db <path> --job <jobId> [--job <jobId> ...] [--apply]

Options:
  --db <path>   SQLite database path (required)
  --job <id>    Job id to reset (required, repeatable)
  --apply       Perform the write (creates <db>.bak first). Without --apply, dry-run only.
`)
}

function parseArgs(argv) {
  const jobIds = []
  let dbPath = null
  let apply = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') {
      apply = true
      continue
    }
    if (arg === '--db') {
      dbPath = argv[++i]
      continue
    }
    if (arg === '--job') {
      const id = argv[++i]
      if (id) jobIds.push(id)
      continue
    }
    if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    }
    console.error(`Unknown argument: ${arg}`)
    printUsage()
    process.exit(1)
  }

  return { dbPath, jobIds, apply }
}

const { dbPath, jobIds, apply } = parseArgs(process.argv.slice(2))

if (!dbPath || jobIds.length === 0) {
  printUsage()
  process.exit(1)
}

const resolvedDb = resolve(dbPath)
if (!existsSync(resolvedDb)) {
  console.error(`Database not found: ${resolvedDb}`)
  process.exit(1)
}

const quotedIds = jobIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')

const sql = `
SELECT j.id, j.title, j.design_session_id, j.thread_id, j.draft_message_id
FROM thread_jobs j
WHERE j.id IN (${quotedIds});
`

const lookup = spawnSync('sqlite3', [resolvedDb, sql], { encoding: 'utf8' })
if (lookup.status !== 0) {
  console.error(lookup.stderr || 'sqlite3 lookup failed')
  process.exit(lookup.status ?? 1)
}

const rows = lookup.stdout
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [jobId, title, dsId, threadId, draftMessageId] = line.split('|')
    return { jobId, title, dsId, threadId, draftMessageId }
  })

if (rows.length === 0) {
  console.log('No matching thread_jobs rows found')
  process.exit(0)
}

console.log(`${apply ? 'Will reset' : 'Dry-run'} ${rows.length} job(s):\n`)
for (const row of rows) {
  console.log(`  - ${row.title}`)
  console.log(`      design session: ${row.dsId}`)
  console.log(`      job:            ${row.jobId}`)
}

if (!apply) {
  console.log('\nRe-run with --apply to write changes (a .bak backup will be created).')
  process.exit(0)
}

const backupPath = `${resolvedDb}.bak`
copyFileSync(resolvedDb, backupPath)
console.log(`\nBackup written: ${backupPath}`)

const now = "strftime('%s','now')"
const statements = ['BEGIN;']

for (const row of rows) {
  if (!row.dsId) {
    console.error(`Skip ${row.jobId}: missing design_session_id`)
    continue
  }
  const ds = row.dsId.replace(/'/g, "''")
  const thread = row.threadId.replace(/'/g, "''")
  const draft = row.draftMessageId.replace(/'/g, "''")
  const job = row.jobId.replace(/'/g, "''")

  statements.push(`DELETE FROM thread_jobs WHERE id = '${job}';`)
  statements.push(`
UPDATE design_sessions SET
  status = 'plan_editing',
  phase = 'plan_edit',
  launched_job_id = NULL,
  task_phase = 'idle',
  task_status = 'pending',
  task_current_index = 0,
  task_current_task_id = NULL,
  task_message = NULL,
  task_meta_json = '{}',
  last_error = NULL,
  updated_at = ${now}
WHERE id = '${ds}';`)
  statements.push(`
UPDATE threads SET
  active_plan_id = '${ds}',
  wizard_phase = 'plan_edit',
  updated_at = ${now}
WHERE id = '${thread}';`)
  statements.push(`
UPDATE thread_messages SET
  payload_json = json_set(payload_json, '$.linkedPlanId', '${ds}')
WHERE id = '${draft}';`)
}

statements.push('COMMIT;')

const applyResult = spawnSync('sqlite3', [resolvedDb], {
  input: statements.join('\n'),
  encoding: 'utf8'
})
if (applyResult.status !== 0) {
  console.error(applyResult.stderr || 'sqlite3 apply failed')
  process.exit(applyResult.status ?? 1)
}

console.log(`\nReset ${rows.length} job(s) to plan_editing.`)
console.log('Restart the Electron app, then continue each draft at step 3 (执行树).')
