import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  asProviderPort,
  asProviderRegistryPort,
  createFakeProviderAdapter,
  PROVIDER_ADAPTER_CODES
} from '../../../src/server/adapters/providers/index.ts'
import { createProviderRegistry } from '../../../src/server/composition/create-provider-registry.ts'

describe('provider port bridge', () => {
  it('asProviderPort maps discover/preflight/runTurn from Fake adapter', async () => {
    const port = asProviderPort(createFakeProviderAdapter())
    assert.equal(port.code, 'fake')

    const availability = await port.discover()
    assert.equal(availability.available, true)

    const preflight = await port.preflight({ skipAuthProbe: true })
    assert.equal(preflight.ok, true)

    const { turnId } = await port.runTurn({ prompt: 'hello' })
    assert.match(turnId, /^fake-turn-/)
  })

  it('executeTask succeeds and hashes reply (live Fake, not stub)', async () => {
    const port = asProviderPort(createFakeProviderAdapter())
    const title = 'bridge success prompt'
    const outcome = await port.executeTask({
      jobId: 'job-1',
      taskId: 'task-1',
      attemptId: 'attempt-1',
      title
    })

    assert.equal(outcome.kind, 'succeeded')
    if (outcome.kind === 'succeeded') {
      assert.equal(outcome.resultHash, createHash('sha256').update(title).digest('hex'))
      assert.equal((outcome.raw as { reply?: string } | undefined)?.reply, title)
    }
  })

  it('executeTask maps cancelled stream errors', async () => {
    const port = asProviderPort(createFakeProviderAdapter())
    const controller = new AbortController()
    controller.abort()
    const outcome = await port.executeTask({
      jobId: 'job-c',
      taskId: 'task-c',
      attemptId: 'attempt-c',
      abortSignal: controller.signal
    })
    assert.equal(outcome.kind, 'cancelled')
  })

  it('asProviderRegistryPort resolves fake + createProviderRegistry codes', () => {
    const registryPort = asProviderRegistryPort(createProviderRegistry())
    for (const code of PROVIDER_ADAPTER_CODES) {
      const port = registryPort.get(code)
      assert.ok(port, `expected ProviderPort for ${code}`)
      assert.equal(port.code, code)
    }
    assert.equal(registryPort.get('missing'), undefined)
  })

  it('A6: Fake via createProviderRegistry bridge executes executeTask successfully', async () => {
    const registry = createProviderRegistry()
    const adapter = registry.get('fake')
    assert.ok(adapter)
    assert.equal(adapter.stubMode, false)

    const port = asProviderRegistryPort(registry).get('fake')
    assert.ok(port)

    const outcome = await port.executeTask({
      jobId: 'job-a6',
      taskId: 'task-a6',
      attemptId: 'attempt-a6',
      title: 'unstub fake path'
    })
    assert.equal(outcome.kind, 'succeeded')
    if (outcome.kind === 'succeeded') {
      assert.equal(typeof outcome.resultHash, 'string')
      assert.equal(outcome.resultHash.length, 64)
    }
  })
})
