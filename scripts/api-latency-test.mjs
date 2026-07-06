import Database from 'better-sqlite3'
import { join } from 'path'

const db = new Database(join('data', 'app.db'), { readonly: true })
const row = db.prepare('select session_token from auth_state limit 1').get()
const token = row?.session_token
if (!token) {
  console.error('No session token in auth_state')
  process.exit(1)
}

const auth = { Authorization: `Bearer ${token}` }

async function timed(label, url, opts = {}) {
  const t = Date.now()
  try {
    const r = await fetch(url, {
      ...opts,
      headers: { ...auth, ...(opts.headers ?? {}) }
    })
    const text = await r.text()
    console.log(`${label}\t${r.status}\t${Date.now() - t}ms\t${text.slice(0, 100)}`)
    return { status: r.status, ms: Date.now() - t, text }
  } catch (e) {
    console.log(`${label}\tERR\t${Date.now() - t}ms\t${e.message}`)
    return null
  }
}

async function testStreamClose(threadId, jobId) {
  const label = `stream:${jobId.slice(0, 8)}`
  const t = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetch(`http://127.0.0.1:3000/api/threads/${threadId}/jobs/${jobId}/stream`, {
      headers: { ...auth, Accept: 'text/event-stream' },
      signal: controller.signal
    })
    const reader = res.body?.getReader()
    if (!reader) {
      console.log(`${label}\tNO_BODY\t${Date.now() - t}ms`)
      return
    }
    let events = 0
    let lastEvent = ''
    const decoder = new TextDecoder()
    let buffer = ''
    while (events < 20) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const ev = part.match(/^event:\s*(.+)$/m)?.[1] ?? '?'
        lastEvent = ev
        events += 1
      }
    }
    clearTimeout(timer)
    console.log(`${label}\tOPEN\t${Date.now() - t}ms\tevents=${events} last=${lastEvent}`)
  } catch (e) {
    clearTimeout(timer)
    const msg = e.name === 'AbortError' ? 'timeout_after_5s_still_open' : e.message
    console.log(`${label}\t${msg}\t${Date.now() - t}ms`)
  }
}

console.log('--- baseline APIs ---')
await timed('bootstrap', 'http://127.0.0.1:3000/api/bootstrap')
await timed('drafts', 'http://127.0.0.1:3000/api/drafts')
await timed('threads', 'http://127.0.0.1:3000/api/threads')
await timed('projects', 'http://127.0.0.1:3000/api/projects')
await timed('jobs', 'http://127.0.0.1:3000/api/jobs?limit=5')

const threadsRes = await timed('threads_json', 'http://127.0.0.1:3000/api/threads')
let threadId = null
let planningJob = null
try {
  const body = JSON.parse(threadsRes?.text ?? '{}')
  const threads = body.data ?? []
  threadId = threads.find((t) => t.threadKind === 'create_task')?.id ?? threads[0]?.id
} catch {
  // Ignore malformed optional probe responses; the baseline timings above are still useful.
}

if (threadId) {
  const plansRes = await timed('plans', `http://127.0.0.1:3000/api/threads/${threadId}/plans`)
  try {
    const body = JSON.parse(plansRes?.text ?? '{}')
    const plans = body.data?.plans ?? []
    planningJob =
      plans.find((p) => p.status === 'planning' || p.status === 'plan_editing') ?? plans[0]
  } catch {
    // Ignore malformed optional probe responses; there may simply be no plan to inspect.
  }
}

if (threadId && planningJob) {
  console.log(`--- SSE test job=${planningJob.id} status=${planningJob.status} ---`)
  await testStreamClose(threadId, planningJob.id)
  console.log('--- APIs after SSE probe ---')
  await timed('drafts_after', 'http://127.0.0.1:3000/api/drafts')
  await timed('threads_after', 'http://127.0.0.1:3000/api/threads')
}
