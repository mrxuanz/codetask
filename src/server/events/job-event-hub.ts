import type { HubEnvelope, HubEvent, HubTopic } from '@shared/contracts/job-event-hub'
import {
  jobIdFromTopic,
  jobTopic,
  threadIdFromTopic,
  threadTopic,
  turnIdFromTopic,
  turnTopic
} from '@shared/contracts/job-event-hub'
import { jobHubTerminalStatus } from '@shared/job-realtime'
import { getAppContext } from '../bootstrap'

interface HubConnection {
  username: string
  connectionId: string
  subscribedTopics: Set<HubTopic>
  unsubByTopic: Map<HubTopic, () => void>
  queue: HubEnvelope[]
  recent: HubEnvelope[]
  nextSeq: number
  droppedSinceOverflowWarn: number
  lastOverflowWarnAt: number
  resolveWait: (() => void) | null
  closed: boolean
}

const MAX_QUEUE_SIZE = 256
const MAX_RECENT_SIZE = 256
const RECENT_LINGER_MS = 60_000
const OVERFLOW_WARN_INTERVAL_MS = 10_000
const NON_DROPPABLE_EVENTS = new Set<HubEvent['event']>(['job_done', 'error', 'resync'])
const connections = new Map<string, Map<string, HubConnection>>()

interface LingerBuffer {
  recent: HubEnvelope[]
  nextSeq: number
  expiresAt: number
}

/** Survives brief disconnects so Last-Event-ID can replay. */
const lingerByKey = new Map<string, LingerBuffer>()

function connectionKey(username: string, connectionId: string): string {
  return `${username}::${connectionId}`
}

function pruneLinger(): void {
  const now = Date.now()
  for (const [key, buf] of lingerByKey) {
    if (buf.expiresAt <= now) lingerByKey.delete(key)
  }
}

function saveLinger(conn: HubConnection): void {
  pruneLinger()
  lingerByKey.set(connectionKey(conn.username, conn.connectionId), {
    recent: [...conn.recent],
    nextSeq: conn.nextSeq,
    expiresAt: Date.now() + RECENT_LINGER_MS
  })
}

function takeLinger(username: string, connectionId: string): LingerBuffer | undefined {
  pruneLinger()
  const key = connectionKey(username, connectionId)
  const buf = lingerByKey.get(key)
  if (!buf) return undefined
  lingerByKey.delete(key)
  return buf
}

function teardownSubscriptions(conn: HubConnection): void {
  for (const unsub of conn.unsubByTopic.values()) {
    unsub()
  }
  conn.unsubByTopic.clear()
  conn.subscribedTopics.clear()
}

function notify(conn: HubConnection): void {
  conn.resolveWait?.()
  conn.resolveWait = null
}

function isCoalescableSnapshot(event: HubEvent): boolean {
  return (
    event.event === 'job_snapshot' ||
    event.event === 'plan_progress' ||
    event.event === 'task_progress' ||
    event.event === 'thread_snapshot' ||
    event.event === 'turn_snapshot'
  )
}

function replaceQueuedSnapshot(conn: HubConnection, topic: HubTopic, event: HubEvent): boolean {
  if (!isCoalescableSnapshot(event)) return false

  for (let index = conn.queue.length - 1; index >= 0; index -= 1) {
    const current = conn.queue[index]
    if (!current || current.topic !== topic || current.event !== event.event) continue

    const replacement = { topic, seq: current.seq, ...event } as HubEnvelope
    conn.queue[index] = replacement
    const recentIndex = conn.recent.findIndex((item) => item.seq === current.seq)
    if (recentIndex >= 0) conn.recent[recentIndex] = replacement
    notify(conn)
    return true
  }
  return false
}

function warnQueueOverflow(conn: HubConnection, topic: HubTopic): void {
  conn.droppedSinceOverflowWarn += 1
  const now = Date.now()
  if (now - conn.lastOverflowWarnAt < OVERFLOW_WARN_INTERVAL_MS) return

  console.warn(
    '[event-hub] queue overflow, dropped messages',
    conn.username,
    topic,
    `count=${conn.droppedSinceOverflowWarn}`
  )
  conn.droppedSinceOverflowWarn = 0
  conn.lastOverflowWarnAt = now
}

function pushEnvelope(conn: HubConnection, topic: HubTopic, event: HubEvent): void {
  if (conn.closed) return
  if (replaceQueuedSnapshot(conn, topic, event)) return

  const envelope: HubEnvelope = {
    topic,
    seq: conn.nextSeq++,
    ...event
  }
  if (conn.queue.length >= MAX_QUEUE_SIZE) {
    const dropIndex = conn.queue.findIndex((item) => !NON_DROPPABLE_EVENTS.has(item.event))
    conn.queue.splice(dropIndex >= 0 ? dropIndex : 0, 1)
    warnQueueOverflow(conn, topic)
  }
  conn.queue.push(envelope)
  conn.recent.push(envelope)
  while (conn.recent.length > MAX_RECENT_SIZE) {
    conn.recent.shift()
  }
  notify(conn)
}

function getUserConnectionMap(username: string): Map<string, HubConnection> {
  let userMap = connections.get(username)
  if (!userMap) {
    userMap = new Map()
    connections.set(username, userMap)
  }
  return userMap
}

function closeConnection(conn: HubConnection): void {
  if (conn.closed) return
  conn.closed = true
  saveLinger(conn)
  teardownSubscriptions(conn)
  const map = connections.get(conn.username)
  if (map) {
    map.delete(conn.connectionId)
    if (map.size === 0) {
      connections.delete(conn.username)
    }
  }
  notify(conn)
}

async function pushJobSnapshots(
  conn: HubConnection,
  topic: HubTopic,
  jobId: string
): Promise<'live' | 'terminal' | 'missing'> {
  const job = await getRealtimeJobSnapshot(conn.username, jobId)
  if (!job) return 'missing'

  pushEnvelope(conn, topic, { event: 'job_snapshot', data: { job } })
  pushEnvelope(conn, topic, {
    event: 'plan_progress',
    data: { planProgress: job.planProgress }
  })
  pushEnvelope(conn, topic, {
    event: 'task_progress',
    data: { taskProgress: job.taskProgress }
  })

  if (jobHubTerminalStatus(job.status)) {
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      pushEnvelope(conn, topic, { event: 'job_done', data: { job } })
    }
    return 'terminal'
  }
  return 'live'
}

/** Resolve the authoritative snapshot for both Legacy and V3 control-plane generations. */
export async function getRealtimeJobSnapshot(
  username: string,
  jobId: string
): Promise<import('../../shared/contracts/jobs.ts').ThreadJobDto | null> {
  const ctx = getAppContext()
  const { isV3Authoritative } = await import('../application/cutover-state')
  if (isV3Authoritative(ctx.db)) {
    const { getControlPlaneRuntime } = await import('../application/control-plane-runtime')
    return getControlPlaneRuntime(ctx).queryService.getTaskJob(jobId, { username })
  }
  const { getUserJob } = await import('../legacy-control-plane/service')
  return getUserJob(username, jobId)
}

async function pushThreadSnapshot(
  conn: HubConnection,
  topic: HubTopic,
  threadId: string
): Promise<boolean> {
  const { getThread } = await import('../threads/service')
  const thread = await getThread(conn.username, threadId)
  if (!thread) return false
  pushEnvelope(conn, topic, { event: 'thread_snapshot', data: { thread } })
  return true
}

/**
 * Replay buffered envelopes after Last-Event-ID.
 * Returns true if the gap was covered (or no lastEventId); false if client must resync via snapshots.
 */
function tryReplayFromLastEventId(
  conn: HubConnection,
  source: { recent: HubEnvelope[]; nextSeq: number } | undefined,
  lastEventId: number | null | undefined
): boolean {
  if (typeof lastEventId !== 'number' || lastEventId <= 0) {
    return true
  }
  if (!source) {
    return false
  }

  conn.nextSeq = source.nextSeq

  // Exactly at the tip — nothing to replay.
  if (lastEventId + 1 === source.nextSeq) {
    return true
  }

  // Client is ahead of our counter (stale linger / wrong connection) → resync.
  if (lastEventId + 1 > source.nextSeq) {
    return false
  }

  const oldest = source.recent[0]?.seq
  if (oldest == null || lastEventId + 1 < oldest) {
    return false
  }

  for (const item of source.recent) {
    if (item.seq <= lastEventId) continue
    conn.queue.push(item)
    conn.recent.push(item)
  }
  return true
}

export function registerJobHubConnection(
  username: string,
  connectionId?: string,
  options?: { lastEventId?: number | null }
): {
  connectionId: string
  setSubscriptions: (topics: HubTopic[]) => Promise<void>
  stream: AsyncGenerator<HubEnvelope>
  close: () => void
} {
  const connId = connectionId?.trim() || `conn-${Math.random().toString(36).slice(2, 10)}`
  const userMap = getUserConnectionMap(username)
  const prior = userMap.get(connId)
  const linger = takeLinger(username, connId)
  const replaySource =
    prior && !prior.closed ? { recent: prior.recent, nextSeq: prior.nextSeq } : linger

  const conn: HubConnection = {
    username,
    connectionId: connId,
    subscribedTopics: new Set(),
    unsubByTopic: new Map(),
    queue: [],
    recent: [],
    nextSeq: replaySource?.nextSeq ?? 1,
    droppedSinceOverflowWarn: 0,
    lastOverflowWarnAt: 0,
    resolveWait: null,
    closed: false
  }

  const replayOk = tryReplayFromLastEventId(conn, replaySource, options?.lastEventId)
  if (prior && !prior.closed) {
    // Replacing a live connection — don't linger the old one (already copied).
    prior.closed = true
    teardownSubscriptions(prior)
    notify(prior)
  }

  if (!replayOk) {
    // Control event: clients re-PUT subscriptions to receive fresh snapshots.
    pushEnvelope(conn, jobTopic('resync'), { event: 'resync', data: { reason: 'gap' } })
  }

  userMap.set(connId, conn)

  const setSubscriptions = async (topics: HubTopic[]): Promise<void> => {
    if (conn.closed) return

    const next = new Set(topics)
    for (const topic of [...conn.subscribedTopics]) {
      if (!next.has(topic)) {
        conn.unsubByTopic.get(topic)?.()
        conn.unsubByTopic.delete(topic)
        conn.subscribedTopics.delete(topic)
      }
    }

    const bus = getAppContext().eventBus

    for (const topic of next) {
      if (conn.subscribedTopics.has(topic)) continue

      const jobId = jobIdFromTopic(topic)
      if (jobId) {
        if (jobId === 'resync') continue
        const state = await pushJobSnapshots(conn, topic, jobId)
        if (state === 'missing') continue
        conn.subscribedTopics.add(topic)
        if (state === 'terminal') continue

        const unsub = bus.subscribe(topic, (payload) => {
          pushEnvelope(conn, topic, payload)
          if (payload.event === 'job_snapshot' || payload.event === 'job_done') {
            const status = payload.data.job.status
            if (jobHubTerminalStatus(status)) {
              conn.unsubByTopic.get(topic)?.()
              conn.unsubByTopic.delete(topic)
              conn.subscribedTopics.delete(topic)
            }
          }
        })
        conn.unsubByTopic.set(topic, unsub)
        continue
      }

      const threadId = threadIdFromTopic(topic)
      if (threadId) {
        const ok = await pushThreadSnapshot(conn, topic, threadId)
        if (!ok) continue
        conn.subscribedTopics.add(topic)
        const unsub = bus.subscribe(topic, (payload) => {
          pushEnvelope(conn, topic, payload)
        })
        conn.unsubByTopic.set(topic, unsub)
        continue
      }

      const turnId = turnIdFromTopic(topic)
      if (turnId) {
        const { getTurn } = await import('../conversation/turn-queue')
        const turn = await getTurn(conn.username, turnId)
        if (!turn) continue
        pushEnvelope(conn, topic, { event: 'turn_snapshot', data: { turn } })
        conn.subscribedTopics.add(topic)
        const unsub = bus.subscribe(topic, (payload) => {
          pushEnvelope(conn, topic, payload)
        })
        conn.unsubByTopic.set(topic, unsub)
      }
    }
  }

  async function* stream(): AsyncGenerator<HubEnvelope> {
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
      closeConnection(conn)
    }
  }

  return {
    connectionId: connId,
    setSubscriptions,
    stream: stream(),
    close: () => closeConnection(conn)
  }
}

export { jobTopic, threadTopic, turnTopic }
