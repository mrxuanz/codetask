import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createProviderRegistry } from '../../../src/server/composition/create-provider-registry.ts'
import {
  PROVIDER_ADAPTER_CODES,
  type ProviderAdapter,
  type ProviderAdapterCode,
  type ProviderEvent
} from '../../../src/server/adapters/providers/index.ts'

const PROVIDER_CODES: readonly ProviderAdapterCode[] = PROVIDER_ADAPTER_CODES

function getAdapter(code: ProviderAdapterCode): ProviderAdapter {
  const registry = createProviderRegistry()
  const adapter = registry.get(code)
  assert.ok(adapter, `expected adapter for ${code}`)
  return adapter
}

async function collectEvents(
  adapter: ProviderAdapter,
  prompt = `hello ${adapter.code}`
): Promise<ProviderEvent[]> {
  const turn = await adapter.runTurn({ prompt })
  const events: ProviderEvent[] = []
  for await (const event of turn.stream()) {
    events.push(event)
  }
  await turn.close()
  return events
}

describe('provider adapter contract', () => {
  for (const code of PROVIDER_CODES) {
    describe(code, () => {
      it('exposes stable code and discover/preflight contract', async () => {
        const adapter = getAdapter(code)
        assert.equal(adapter.code, code)

        const availability = await adapter.discover()
        assert.equal(typeof availability.available, 'boolean')
        assert.equal(availability.available, true)

        const preflight = await adapter.preflight({ skipAuthProbe: true })
        assert.equal(typeof preflight.ok, 'boolean')
        assert.equal(preflight.ok, true)

        if (code === 'fake') {
          assert.equal(adapter.stubMode, false)
          assert.equal(availability.stub, undefined)
        } else {
          assert.equal(adapter.stubMode, true)
          assert.equal(availability.stub, true)
          assert.equal(preflight.stub, true)
        }
      })

      it('runTurn streams normalized ProviderEvent values then closes', async () => {
        const adapter = getAdapter(code)
        const events = await collectEvents(adapter)
        assert.ok(events.length >= 2, `${code} should emit multiple events`)

        for (const event of events) {
          assert.equal(typeof event.type, 'string')
          assert.ok(
            [
              'text_delta',
              'reasoning_delta',
              'tool_started',
              'tool_finished',
              'progress',
              'usage',
              'result',
              'error'
            ].includes(event.type),
            `unexpected event type ${event.type}`
          )
        }

        const result = events.find((event) => event.type === 'result')
        assert.ok(result, `${code} should emit a result event`)
        if (result?.type === 'result') {
          assert.equal(typeof result.result.reply, 'string')
          assert.ok(result.result.reply.length > 0)
        }
      })

      it('cancel and close are idempotent on a turn handle', async () => {
        const adapter = getAdapter(code)
        const turn = await adapter.runTurn({ prompt: 'cancel me' })
        await turn.cancel('test-cancel')
        await turn.cancel('test-cancel-again')
        await turn.close()
        await turn.close()
      })

      it('classifyError returns provider-scoped ProviderError', () => {
        const adapter = getAdapter(code)
        const auth = adapter.classifyError(new Error('unauthorized api key'))
        assert.equal(auth.category, 'auth')
        assert.ok(auth.code.startsWith(`${code}.`))

        const cancelled = adapter.classifyError(new Error('aborted by user cancel'))
        assert.equal(cancelled.category, 'cancelled')

        const timeout = adapter.classifyError(new Error('request timed out'))
        assert.equal(timeout.category, 'timeout')
        assert.equal(timeout.retryable, true)

        const unknown = adapter.classifyError('boom')
        assert.equal(unknown.category, 'unknown')
        assert.equal(unknown.message, 'boom')
      })
    })
  }

  it('composition registry registers all five adapters', () => {
    const registry = createProviderRegistry()
    assert.deepEqual([...registry.codes()], [...PROVIDER_CODES])
    assert.equal(registry.list().length, 5)
    for (const code of PROVIDER_CODES) {
      assert.equal(registry.has(code), true)
      assert.equal(registry.get(code)?.code, code)
    }
  })

  it('fake adapter fully emits rich event types', async () => {
    const adapter = getAdapter('fake')
    const events = await collectEvents(adapter, 'full fake stream')
    const types = new Set(events.map((event) => event.type))
    assert.ok(types.has('progress'))
    assert.ok(types.has('reasoning_delta'))
    assert.ok(types.has('text_delta'))
    assert.ok(types.has('tool_started'))
    assert.ok(types.has('tool_finished'))
    assert.ok(types.has('usage'))
    assert.ok(types.has('result'))
  })
})
