import type Database from 'better-sqlite3'
import { RealtimeDispatcher } from './dispatcher.ts'
import { RealtimeEventLog } from './event-log.ts'
import { LiveFanout } from './live-fanout.ts'
import { openRealtimeStream } from './connection.ts'

export type RealtimeModule = {
  log: RealtimeEventLog
  fanout: LiveFanout
  dispatcher: RealtimeDispatcher
  openStream: typeof openRealtimeStream extends (input: infer I) => infer R
    ? (input: Omit<I, 'fanout' | 'log'>) => R
    : never
  closeForSession: (actorId: string, sessionId: string) => void
  closeForActor: (actorId: string) => void
  janitorOnce: () => number
  activeKeys: () => IterableIterator<string>
}

export function composeRealtimeModule(deps: { db: Database.Database }): RealtimeModule {
  const log = new RealtimeEventLog(deps.db)
  const fanout = new LiveFanout()
  const dispatcher = new RealtimeDispatcher(log, fanout)

  return {
    log,
    fanout,
    dispatcher,
    openStream(input) {
      return openRealtimeStream({ ...input, fanout, log })
    },
    closeForSession(actorId, sessionId) {
      fanout.closeForSession(actorId, sessionId)
    },
    closeForActor(actorId) {
      fanout.closeForActor(actorId)
    },
    janitorOnce() {
      return log.deleteExpired()
    },
    activeKeys() {
      return fanout.activeKeys()
    }
  }
}

export { RealtimeEventLog } from './event-log.ts'
export { LiveFanout } from './live-fanout.ts'
export { RealtimeDispatcher } from './dispatcher.ts'
export { openRealtimeStream } from './connection.ts'
