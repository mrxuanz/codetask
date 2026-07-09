#!/usr/bin/env node
/**
 * Reset launched thread_jobs back to design-session plan_editing (执行树确认阶段).
 *
 * Usage:
 *   node scripts/reset-jobs-to-plan-edit.mjs [jobId ...]
 *
 * With no args, resets the three jobs from the 2026-07-05 session.
 * Uses the sqlite3 CLI (no native Node bindings required).
 */

import { spawnSync } from 'child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const dbPath = join(__dirname, '../data/db/app.db')

const DEFAULT_JOB_IDS = [
  'job-4d995b51-c763-4656-8553-295a1236e766',
  'job-5fa43ba1-38cb-420d-8c54-39db36ee3fd5',
  'job-0e16a059-31d8-48c7-8b24-7015cf9e9db5'
]

const jobIds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_JOB_IDS
const quotedIds = jobIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ')

const sql = `
SELECT j.id, j.title, j.design_session_id, j.thread_id, j.draft_message_id
FROM thread_jobs j
WHERE j.id IN (${quotedIds});
`

const lookup = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' })
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
  console.log('No matching thread_jobs rows found (already reset?)')
  process.exit(0)
}

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

const apply = spawnSync('sqlite3', [dbPath], { input: statements.join('\n'), encoding: 'utf8' })
if (apply.status !== 0) {
  console.error(apply.stderr || 'sqlite3 apply failed')
  process.exit(apply.status ?? 1)
}

console.log(`Reset ${rows.length} job(s) to plan_editing:\n`)
for (const row of rows) {
  console.log(`  ✓ ${row.title}`)
  console.log(`      design session: ${row.dsId}`)
  console.log(`      removed job:    ${row.jobId}`)
}
console.log('\nRestart the Electron app, then continue each draft at step 3 (执行树).')
