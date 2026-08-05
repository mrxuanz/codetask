/**
 * Architecture 06 DoD checklist — HTTP + single-window Fetch SSE cutover.
 * @see docs/架构收口/06-前后端交互与实时通信.md §26
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_APP_CONFIG } from '../../src/server/config/app-config.ts'
import {
  MAX_REALTIME_TOPICS_PER_CONNECTION,
  SETTINGS_SELF_TOPIC,
  parseRealtimeTopic
} from '../../packages/contracts/src/events.ts'

const root = join(import.meta.dirname, '../..')

function exists(rel: string): boolean {
  try {
    const st = statSync(join(root, rel))
    return st.isFile() || st.isDirectory()
  } catch {
    return false
  }
}

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|vue|mjs)$/.test(name)) files.push(full)
  }
  return files
}

describe('architecture 06 DoD', () => {
  it('realtime module and durable event log exist', () => {
    assert.equal(exists('packages/server-core/src/modules/realtime'), true)
    assert.equal(exists('packages/server-core/src/modules/realtime/event-log.ts'), true)
    assert.equal(exists('packages/server-core/src/modules/realtime/dispatcher.ts'), true)
    assert.equal(exists('packages/server-core/src/modules/realtime/live-fanout.ts'), true)
    assert.equal(exists('packages/database/src/migrations/realtime-events.ts'), true)
    assert.equal(exists('packages/database/src/migrations/realtime-events.ts'), true)
    const index = readFileSync(join(root, 'packages/database/src/migrations/all.ts'), 'utf8')
    assert.match(index, /migration054RealtimeEvents/)
  })

  it('API mounts only /api/realtime (no /events dual mount or job aliases)', () => {
    const api = readFileSync(join(root, 'src/server/routes/api.ts'), 'utf8')
    assert.match(api, /createRealtimeRoutes/)
    assert.match(api, /route\('\/realtime'/)
    assert.doesNotMatch(api, /route\('\/events'/)
    assert.doesNotMatch(api, /createEventsRoutes/)
    assert.doesNotMatch(api, /createJobRoutes|createDesignSessionRoutes/)
    assert.equal(exists('src/server/routes/jobs.ts'), false)
    assert.equal(exists('src/server/routes/design-sessions.ts'), false)

    const realtime = readFileSync(join(root, 'src/server/routes/realtime.ts'), 'utf8')
    assert.match(realtime, /\/subscriptions/)
    assert.match(realtime, /\/stream/)
    assert.doesNotMatch(realtime, /jobs\/stream|jobs\/subscriptions/)
    assert.match(realtime, /X-Realtime-Connection-Id|REALTIME_CONNECTION_ID_HEADER/)
    assert.doesNotMatch(realtime, /job_snapshot|thread_snapshot|turn_snapshot|pushJobSnapshots/)
  })

  it('topic whitelist matches §19 including settings:self', () => {
    assert.equal(SETTINGS_SELF_TOPIC, 'settings:self')
    assert.equal(parseRealtimeTopic('settings:self'), 'settings:self')
    assert.equal(parseRealtimeTopic('job:abc'), 'job:abc')
    assert.equal(parseRealtimeTopic('conversation:c1'), 'conversation:c1')
    assert.equal(parseRealtimeTopic('conversation-turn:t1'), 'conversation-turn:t1')
    assert.equal(parseRealtimeTopic('planning-session:p1'), 'planning-session:p1')
    assert.equal(parseRealtimeTopic('thread:legacy'), null)
    assert.equal(parseRealtimeTopic('turn:legacy'), null)
    assert.ok(MAX_REALTIME_TOPICS_PER_CONNECTION >= 1)
  })

  it('JSON request timeout is 30 seconds', () => {
    assert.equal(DEFAULT_APP_CONFIG.http.requestTimeoutMs, 30_000)
  })

  it('SSE bypass path is only /realtime/stream', () => {
    const limits = readFileSync(join(root, 'src/server/middleware/http-limits.ts'), 'utf8')
    assert.match(limits, /\/realtime\/stream/)
    assert.doesNotMatch(limits, /\/events\/stream/)
  })

  it('legacy hub snapshot-on-subscribe and linger are gone', () => {
    const ownership = readFileSync(
      join(root, 'src/server/events/realtime-job-ownership.ts'),
      'utf8'
    )
    assert.match(ownership, /getOwnedRealtimeJob/)
    assert.doesNotMatch(
      ownership,
      /tryReplayFromLastEventId|pushJobSnapshots|lingerByKey|getRealtimeJobSnapshot/
    )
    assert.match(ownership, /authorize topic subscription|never pushes business snapshots/i)
    assert.equal(exists('src/server/events/job-event-hub.ts'), false)
    assert.equal(exists('src/server/events/sse-session-registry.ts'), false)
    assert.equal(exists('src/server/routes/events.ts'), false)
    assert.equal(exists('src/server/context/event-bus.ts'), false)
    assert.equal(exists('src/shared/contracts/job-event-hub.ts'), false)
    const types = readFileSync(join(root, 'src/server/context/types.ts'), 'utf8')
    assert.doesNotMatch(types, /eventBus/)
    const connection = readFileSync(
      join(root, 'packages/server-core/src/modules/realtime/connection.ts'),
      'utf8'
    )
    assert.match(connection, /Does NOT push business snapshots on subscribe/)
  })

  it('frontend uses unified realtime client with header connection id', () => {
    assert.equal(exists('apps/web/src/api/realtime.ts'), true)
    assert.equal(exists('apps/web/src/realtime/reducer.ts'), true)
    const client = readFileSync(join(root, 'apps/web/src/api/realtime.ts'), 'utf8')
    assert.match(client, /REALTIME_CONNECTION_ID_HEADER/)
    assert.match(client, /Value\.Check\(RealtimeEnvelopeSchema/)
    assert.doesNotMatch(client, /connectionId=\$\{|x-hub-connection-id/)
    assert.doesNotMatch(client, /onEnvelope\(envelope as RealtimeEnvelope\)/)
    const hub = readFileSync(join(root, 'apps/web/src/composables/useRealtimeGateway.ts'), 'utf8')
    assert.match(hub, /putRealtimeSubscriptions|connectRealtimeStream/)
    assert.doesNotMatch(hub, /HubEnvelope|toHubEnvelope|onAnyEvent|useJobRealtimeWatch|JobEventHub/)
    assert.equal(exists('apps/web/src/composables/useJobEventHub.ts'), false)
    assert.equal(exists('src/shared/contracts/sse.ts'), false)
    assert.equal(exists('apps/web/src/components/create/ReferenceCorpusPanel.vue'), false)
    const jobsStore = readFileSync(
      join(root, 'apps/web/src/composables/useControlPlaneJobsStore.ts'),
      'utf8'
    )
    assert.match(jobsStore, /startRealtimePolling|handleRealtimeEvent/)
    assert.doesNotMatch(jobsStore, /startHubPolling|handleHubEvent/)
    const apiClient = readFileSync(join(root, 'apps/web/src/api/client.ts'), 'utf8')
    assert.match(apiClient, /Value\.Check|schema/)
    const homeChat = readFileSync(join(root, 'apps/web/src/composables/useHomeChat.ts'), 'utf8')
    assert.match(homeChat, /conversationTurnTopic|conversationTopic/)
    assert.doesNotMatch(
      homeChat,
      /turn_snapshot|user_message|assistant_start|thinking_delta|assistant_message|job_done|draft_updated/
    )
  })

  it('settings realtime stays on settings:self minimal events', () => {
    const settings = readFileSync(join(root, 'src/server/settings/service.ts'), 'utf8')
    assert.match(settings, /settings:self/)
    assert.match(settings, /publishDurable/)
    assert.match(settings, /settings\.changed|event\.type/)
  })

  it('no WebSocket / Long Polling /api/v3/events business surface', () => {
    for (const file of walk(join(root, 'src/server/routes'))) {
      const source = readFileSync(file, 'utf8')
      assert.doesNotMatch(source, /\/api\/v3\/events|new WebSocket|EventSource\(/)
    }
    for (const file of walk(join(root, 'apps/web/src'))) {
      const source = readFileSync(file, 'utf8')
      assert.doesNotMatch(source, /new WebSocket\(|new EventSource\(/)
    }
  })

  it('Electron has no business IPC query/command proxy in renderer', () => {
    for (const file of walk(join(root, 'apps/web/src'))) {
      const source = readFileSync(file, 'utf8')
      assert.doesNotMatch(source, /ipcRenderer\.(invoke|send)|window\.electronAPI/)
    }
  })

  it('retention janitor drains expired realtime_events', () => {
    const lifecycle = readFileSync(join(root, 'src/server/retention/lifecycle.ts'), 'utf8')
    assert.match(lifecycle, /realtime\.janitorOnce|expiredRealtimeEvents/)
  })

  it('live fanout enforces byte+count bounds and progress coalesce', () => {
    const fanout = readFileSync(
      join(root, 'packages/server-core/src/modules/realtime/live-fanout.ts'),
      'utf8'
    )
    assert.match(fanout, /MAX_QUEUE_BYTES/)
    assert.match(fanout, /MAX_QUEUE_EVENTS/)
    assert.match(fanout, /assistant\.text\.delta|assistant\.thinking\.delta/)
    assert.match(fanout, /realtime\.resync-required/)
  })

  it('service can start from source via dev:service', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    assert.match(String(pkg.scripts?.['dev:service'] ?? ''), /dev-service/)
    assert.equal(exists('scripts/dev-service.mjs'), true)
  })

  it('logout closes realtime sessions', () => {
    const auth = readFileSync(join(root, 'src/server/routes/auth.ts'), 'utf8')
    assert.match(auth, /closeRealtimeForSession|closeRealtimeForUser/)
  })

  it('entity revision gate lives in client RealtimeReducer', () => {
    const reducer = readFileSync(join(root, 'apps/web/src/realtime/reducer.ts'), 'utf8')
    assert.match(reducer, /entityRevision/)
    assert.match(reducer, /lastEventId/)
  })
})
