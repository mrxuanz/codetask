import type { JobSseEvent } from '../jobs/types'
import { getAppContext } from '../bootstrap'
import { jobHubTerminalStatus } from '@shared/job-realtime'

interface HubConnection {
  username: string
  subscribedJobIds: Set<string>
  unsubByJob: Map<string, () => void>
  queue: JobHubOutbound[]
  resolveWait: (() => void) | null
  closed: boolean
}

export interface JobHubOutbound {
  jobId: string
  payload: JobSseEvent
}

const connections = new Map<string, HubConnection>()

function teardownJobSubscriptions(conn: HubConnection): void {
  for (const unsub of conn.unsubByJob.values()) {
    unsub()
  }
  conn.unsubByJob.clear()
  conn.subscribedJobIds.clear()
}

function notify(conn: HubConnection): void {
  conn.resolveWait?.()
  conn.resolveWait = null
}

function push(conn: HubConnection, message: JobHubOutbound): void {
  if (conn.closed) return
  conn.queue.push(message)
  notify(conn)
}

export function registerJobHubConnection(username: string): {
  setSubscriptions: (jobIds: string[]) => Promise<void>
  stream: AsyncGenerator<JobHubOutbound>
  close: () => void
} {
  const existing = connections.get(username)
  if (existing) {
    existing.closed = true
    teardownJobSubscriptions(existing)
    connections.delete(username)
  }

  const conn: HubConnection = {
    username,
    subscribedJobIds: new Set(),
    unsubByJob: new Map(),
    queue: [],
    resolveWait: null,
    closed: false
  }
  connections.set(username, conn)

  const setSubscriptions = async (jobIds: string[]): Promise<void> => {
    if (conn.closed) return

    const next = new Set(jobIds)
    for (const jobId of [...conn.subscribedJobIds]) {
      if (!next.has(jobId)) {
        conn.unsubByJob.get(jobId)?.()
        conn.unsubByJob.delete(jobId)
        conn.subscribedJobIds.delete(jobId)
      }
    }

    const { getUserJob } = await import('../jobs/service')
    const bus = getAppContext().eventBus

    for (const jobId of next) {
      if (conn.subscribedJobIds.has(jobId)) continue
      const job = await getUserJob(username, jobId)
      if (!job) continue

      conn.subscribedJobIds.add(jobId)
      push(conn, { jobId, payload: { event: 'job_snapshot', data: { job } } })
      push(conn, {
        jobId,
        payload: { event: 'plan_progress', data: { planProgress: job.planProgress } }
      })
      push(conn, {
        jobId,
        payload: { event: 'task_progress', data: { taskProgress: job.taskProgress } }
      })

      if (jobHubTerminalStatus(job.status)) {
        if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
          push(conn, { jobId, payload: { event: 'job_done', data: { job } } })
        }
        conn.subscribedJobIds.delete(jobId)
        continue
      }

      const unsub = bus.subscribe(jobId, (payload) => {
        push(conn, { jobId, payload })
        if (payload.event === 'job_snapshot' || payload.event === 'job_done') {
          const status =
            payload.event === 'job_snapshot' || payload.event === 'job_done'
              ? payload.data.job.status
              : ''
          if (jobHubTerminalStatus(status)) {
            conn.unsubByJob.get(jobId)?.()
            conn.unsubByJob.delete(jobId)
            conn.subscribedJobIds.delete(jobId)
          }
        }
      })
      conn.unsubByJob.set(jobId, unsub)
    }
  }

  async function* stream(): AsyncGenerator<JobHubOutbound> {
    try {
      while (!conn.closed) {
        while (conn.queue.length > 0) {
          yield conn.queue.shift()!
        }
        await new Promise<void>((resolve) => {
          conn.resolveWait = resolve
          setTimeout(resolve, 25_000)
        })
      }
    } finally {
      close()
    }
  }

  const close = (): void => {
    if (conn.closed) return
    conn.closed = true
    teardownJobSubscriptions(conn)
    connections.delete(username)
    notify(conn)
  }

  return { setSubscriptions, stream: stream(), close }
}
