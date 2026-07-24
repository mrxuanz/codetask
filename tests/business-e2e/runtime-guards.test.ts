import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { PublicApiClient } from './api/client.ts'
import { waitJobTerminal, waitTurnTerminal } from './api/operations.ts'
import { resolveSelection } from './cases/selection.ts'

test('unknown --case values fail instead of reporting a skipped SUCCESS', () => {
  assert.throws(() => resolveSelection({ caseId: 'settings-mcp' }), /unknown_case:settings-mcp/)
  assert.deepEqual(resolveSelection({ caseId: 'settings-mcp-probe' }).caseIds, ['SETTINGS-MCP-001'])
})

test('terminal polling survives a transient SUT fetch failure', async () => {
  let calls = 0
  const client = {
    async request() {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return {
        status: 200,
        data: { turn: { id: 'turn-1', status: 'completed' } },
        raw: {}
      }
    }
  } as unknown as PublicApiClient

  const turn = await waitTurnTerminal(client, 'thread-1', 'turn-1', 2_000)
  assert.equal(turn.status, 'completed')
  assert.equal(calls, 2)
})

test('terminal polling without timeoutMs waits until CodeTask API terminal', async () => {
  let calls = 0
  const client = {
    async request() {
      calls += 1
      if (calls < 3) {
        return {
          status: 200,
          data: { turn: { id: 'turn-1', status: 'running' } },
          raw: {}
        }
      }
      return {
        status: 200,
        data: { turn: { id: 'turn-1', status: 'completed' } },
        raw: {}
      }
    }
  } as unknown as PublicApiClient

  const turn = await waitTurnTerminal(client, 'thread-1', 'turn-1')
  assert.equal(turn.status, 'completed')
  assert.equal(calls, 3)
})

test('terminal polling with short timeoutMs still fails for probes', async () => {
  const client = {
    async request() {
      return {
        status: 200,
        data: { id: 'job-1', status: 'running' },
        raw: {}
      }
    }
  } as unknown as PublicApiClient

  await assert.rejects(waitJobTerminal(client, 'thread-1', 'job-1', 50), /timeout:job_job-1/)
})

test('terminal polling does not hide non-transport API failures', async () => {
  let calls = 0
  const client = {
    async request() {
      calls += 1
      return {
        status: 500,
        data: undefined,
        raw: { message: 'broken contract' }
      }
    }
  } as unknown as PublicApiClient

  await assert.rejects(
    waitJobTerminal(client, 'thread-1', 'job-1', 2_000),
    /job\.get_failed:500:broken contract/
  )
  assert.equal(calls, 1)
})

test('E2E source has no model, executable-path, HOME, or HTML-simulation switches', () => {
  const promptSource = readFileSync(
    new URL('./drivers/opencode-prompt.ts', import.meta.url),
    'utf8'
  )
  const driverSource = readFileSync(new URL('./drivers/opencode.ts', import.meta.url), 'utf8')
  const canarySource = readFileSync(
    new URL('./drivers/opencode-canary.ts', import.meta.url),
    'utf8'
  )
  const fakeSource = readFileSync(new URL('./drivers/fake.ts', import.meta.url), 'utf8')
  const opencodeSources = `${promptSource}\n${driverSource}\n${canarySource}`

  assert.doesNotMatch(opencodeSources, /BUSINESS_OPENCODE_MODEL|CODETASK_OPENCODE_BIN|OPENCODE_BIN/)
  assert.doesNotMatch(promptSource, /\bHOME\s*:/)
  assert.doesNotMatch(promptSource, /\bmodel\s*:\s*input\./)
  assert.doesNotMatch(fakeSource, /BUSINESS_E2E_REQUIRE_AGENT_HTML|created-by=fake-driver/)
})
