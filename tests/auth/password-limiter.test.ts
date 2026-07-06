import assert from 'node:assert/strict'
import test from 'node:test'
import { acquirePasswordSlot } from '../../src/server/auth/password-limiter'

test('acquirePasswordSlot rejects when queue is full', async () => {
  const releases: Array<() => void> = []
  const pending: Promise<() => void>[] = []

  for (let i = 0; i < 68; i++) {
    pending.push(
      acquirePasswordSlot().then((release) => {
        releases.push(release)
        return release
      })
    )
  }

  await Promise.resolve()

  let rejected = false
  try {
    await acquirePasswordSlot()
  } catch (err) {
    rejected = true
    assert.match(String(err), /queue full/i)
  }

  assert.equal(rejected, true)

  for (const release of releases) {
    release()
  }
  await Promise.allSettled(pending)
})
