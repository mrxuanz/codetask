import { getDb } from '../db'
import { SqliteAuthStore } from './store'

const INTERVAL_MS = 60_000
let timer: ReturnType<typeof setInterval> | null = null

export function startAuthJanitor(): void {
  if (timer) return
  void runAuthJanitorPass().catch((error) => {
    console.warn('[auth-janitor] startup pass failed', error)
  })
  timer = setInterval(() => {
    void runAuthJanitorPass().catch((error) => {
      console.warn('[auth-janitor] pass failed', error)
    })
  }, INTERVAL_MS)
  timer.unref?.()
}

export function stopAuthJanitor(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export async function runAuthJanitorPass(): Promise<void> {
  new SqliteAuthStore(getDb()).cleanup(Date.now())
}
