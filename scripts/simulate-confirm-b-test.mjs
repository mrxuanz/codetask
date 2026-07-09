#!/usr/bin/env node
/**
 * Prepare "confirm task B" concurrency test:
 *   1. Launch task A (王也道长) via API
 *   2. Expire A's execution lease (simulate 30min timeout)
 *   3. You click「确认执行树并入队」on task B (文档凝练PPT) in the UI
 *
 * Usage:
 *   node scripts/simulate-confirm-b-test.mjs
 *   node scripts/simulate-confirm-b-test.mjs --expire-only   # skip launch if A already running
 *
 * Requires: Electron app running (default http://127.0.0.1:8080)
 */

import { spawnSync } from 'child_process'
import { join } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const dbPath = join(__dirname, '../data/db/app.db')
const baseUrl = process.env.CODETASK_URL ?? 'http://127.0.0.1:8080'

const TASK_A = {
  label: '任务 A（王也道长）',
  designSessionId: 'ds-b442bcc6-0bb8-4fa3-a060-f5283cfa46bc',
  threadId: 'dcf037e7-eb6f-4682-8fc7-8f1c61742901'
}

const TASK_B = {
  label: '任务 B（文档凝练PPT）',
  designSessionId: 'ds-abc60d26-1118-4f6a-9143-d9e187255496',
  threadId: '300740ff-d11b-4093-9a5f-14e6b93d5b89'
}

const expireOnly = process.argv.includes('--expire-only')

function sqlite(sql) {
  const res = spawnSync('sqlite3', [dbPath, sql], { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(res.stderr?.trim() || 'sqlite3 failed')
  }
  return res.stdout.trim()
}

async function api(path, init = {}) {
  const token = sqlite('SELECT session_token FROM auth_state WHERE id = 1;')
  if (!token) throw new Error('No session token in auth_state — log in to the app first')

  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {})
    }
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.success === false) {
    throw new Error(body.message || `HTTP ${res.status} ${path}`)
  }
  return body.data
}

async function main() {
  try {
    await fetch(`${baseUrl}/api/health`)
  } catch {
    console.error(`App not reachable at ${baseUrl}`)
    console.error('Start Electron first: npm run dev')
    process.exit(1)
  }

  let running = sqlite(`
    SELECT id, title FROM thread_jobs WHERE status = 'running' LIMIT 1;
  `)

  if (!expireOnly && !running) {
    console.log(`Launching ${TASK_A.label}…`)
    const data = await api(
      `/api/threads/${TASK_A.threadId}/design-sessions/${TASK_A.designSessionId}/launch`,
      { method: 'POST' }
    )
    const job = data?.job
    console.log(`  → job ${job?.id} status=${job?.status}`)
    await new Promise((r) => setTimeout(r, 800))
    running = sqlite(`SELECT id, title FROM thread_jobs WHERE status = 'running' LIMIT 1;`)
  }

  if (!running) {
    console.error('No running job found. Launch task A in the UI, or run without --expire-only.')
    process.exit(1)
  }

  const [jobId, jobTitle] = running.split('|')
  const before = sqlite(`
    SELECT execution_lease_expires_at FROM thread_jobs WHERE id = '${jobId.replace(/'/g, "''")}';
  `)

  sqlite(`
    UPDATE thread_jobs
    SET execution_lease_expires_at = strftime('%s','now') - 120,
        updated_at = strftime('%s','now')
    WHERE id = '${jobId.replace(/'/g, "''")}' AND status = 'running';
  `)

  const after = sqlite(`
    SELECT execution_lease_expires_at FROM thread_jobs WHERE id = '${jobId.replace(/'/g, "''")}';
  `)

  console.log('')
  console.log('=== Ready for confirm-B test ===')
  console.log(`Running:  ${jobTitle} (${jobId})`)
  console.log(`Lease:    ${before} → ${after} (expired)`)
  console.log('')
  console.log('Now in the app:')
  console.log('  1. 创建任务 → 草案列表')
  console.log(`  2. 打开「${TASK_B.label.replace('任务 B（', '').replace('）', '')}」`)
  console.log('  3. 步骤 3 · 执行树 → 点击「确认执行树并入队」')
  console.log('')
  console.log('Expected (with fix): B stays pending, only A is running.')
  console.log('Verify:')
  console.log(
    `  sqlite3 ${dbPath} "SELECT id, title, status FROM thread_jobs WHERE status IN ('running','pending');"`
  )
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
