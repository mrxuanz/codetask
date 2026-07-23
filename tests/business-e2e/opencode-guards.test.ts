import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  assertNoTimeoutAllowed,
  resolveCaseWorkerBudget,
  resolveOpencodeBudgets,
  TIMEOUTS
} from './config/timeouts.ts'
import {
  classifyDriverCatchError,
  classifyOpencodePromptError,
  extractPromptFailure,
  extractPromptText,
  isRetryablePromptError
} from './drivers/opencode-errors.ts'
import { buildOpencodeHarnessConfig, waitForCapabilityReport } from './drivers/opencode-prompt.ts'

test('extractPromptFailure reads top-level SDK error', () => {
  const failure = extractPromptFailure({
    error: { name: 'FetchError', message: 'network down' },
    data: undefined
  })
  assert.equal((failure as { name: string }).name, 'FetchError')
})

test('extractPromptFailure reads nested data.info.error', () => {
  const failure = extractPromptFailure({
    error: false,
    data: {
      info: {
        error: {
          name: 'APIError',
          data: {
            message: 'No provider available',
            statusCode: 401,
            isRetryable: false
          }
        }
      }
    }
  })
  assert.ok(failure)
  assert.equal(classifyOpencodePromptError(failure), 'provider_unavailable')
})

test('classify ProviderAuthError as provider_auth_missing', () => {
  assert.equal(
    classifyOpencodePromptError({
      name: 'ProviderAuthError',
      data: { message: 'missing key', statusCode: 401 }
    }),
    'provider_auth_missing'
  )
})

test('extractPromptText reads assistant text parts', () => {
  assert.equal(
    extractPromptText({
      data: {
        parts: [
          { type: 'text', text: 'CANARY_' },
          { type: 'tool', name: 'ignored' },
          { type: 'text', text: 'OK' }
        ]
      }
    }),
    'CANARY_OK'
  )
})

test('classify retryable assistant error as provider_transport', () => {
  const err = {
    name: 'APIError',
    data: { message: 'temporary blip', statusCode: 503, isRetryable: true }
  }
  assert.equal(isRetryablePromptError(err), true)
  assert.equal(classifyOpencodePromptError(err), 'provider_transport')
})

test('classify other assistant error as agent_failed', () => {
  assert.equal(
    classifyOpencodePromptError({
      name: 'MessageAbortedError',
      data: { message: 'aborted by user' }
    }),
    'agent_failed'
  )
})

test('classifyDriverCatchError maps prompt failure JSON', () => {
  const payload = JSON.stringify({
    name: 'APIError',
    data: { message: 'No provider available', statusCode: 401, isRetryable: false }
  })
  assert.equal(
    classifyDriverCatchError(new Error(`opencode_prompt_failed:${payload}`)),
    'provider_unavailable'
  )
})

test('classifyDriverCatchError maps agent_no_report and mcp failures', () => {
  assert.equal(classifyDriverCatchError(new Error('agent_no_report:null')), 'agent_no_report')
  assert.equal(classifyDriverCatchError(new Error('mcp_unreachable:boom')), 'mcp_failed')
  assert.equal(classifyDriverCatchError(new Error('timeout:opencode_prompt')), 'timeout')
  assert.equal(classifyDriverCatchError(new TypeError('fetch failed')), 'provider_transport')
  assert.equal(
    classifyDriverCatchError(new Error('opencode_provider_unavailable:not_installed')),
    'provider_unavailable'
  )
})

test('timeoutMs 0 resolves to staged defaults (never infinite)', () => {
  const budgets = resolveOpencodeBudgets({ timeoutMs: 0 })
  assert.equal(budgets.noTimeout, false)
  assert.equal(budgets.startupMs, TIMEOUTS.agentStartupMs)
  assert.equal(budgets.promptMs, TIMEOUTS.opencodePromptMs)
  assert.equal(budgets.capabilityReportMs, TIMEOUTS.capabilityReportMs)
  assert.equal(budgets.workerMs, TIMEOUTS.caseWorkerMs)
  assert.ok(Number.isFinite(budgets.capabilityReportMs))
  assert.ok(budgets.capabilityReportMs <= 30_000)
})

test('every case worker receives a finite default budget', () => {
  assert.equal(resolveCaseWorkerBudget({ timeoutMs: 0 }), TIMEOUTS.caseWorkerMs)
  assert.equal(resolveCaseWorkerBudget({ timeoutMs: 12_345 }), 12_345)
  assert.equal(resolveCaseWorkerBudget({ timeoutMs: 0, noTimeout: true }), Number.MAX_SAFE_INTEGER)
})

test('positive timeoutMs shrinks stages under overall budget', () => {
  const budgets = resolveOpencodeBudgets({ timeoutMs: 45_000 })
  assert.equal(budgets.workerMs, 45_000)
  assert.ok(budgets.startupMs <= 45_000)
  assert.ok(budgets.promptMs <= 45_000)
  assert.ok(budgets.capabilityReportMs <= 45_000)
})

test('noTimeout is forbidden in CI', () => {
  const prev = process.env.CI
  process.env.CI = 'true'
  try {
    assert.throws(() => assertNoTimeoutAllowed(true), /no_timeout_forbidden_in_ci/)
  } finally {
    if (prev === undefined) delete process.env.CI
    else process.env.CI = prev
  }
})

test('OpenCode harness config adds only MCP restrictions and does not choose a model', () => {
  const config = buildOpencodeHarnessConfig('http://127.0.0.1:4567/mcp', 'cap-1')
  assert.equal(Object.hasOwn(config, 'model'), false)
  assert.deepEqual(config.permission, {
    edit: 'deny',
    bash: 'deny',
    webfetch: 'deny'
  })
  assert.deepEqual(config.mcp, {
    'codetask-business-test': {
      type: 'remote',
      url: 'http://127.0.0.1:4567/mcp',
      enabled: true,
      headers: {
        Accept: 'application/json, text/event-stream',
        'X-Business-Capability': 'cap-1'
      }
    }
  })
})

test('OpenCode harness config preserves host defaults instead of replacing them', () => {
  const config = buildOpencodeHarnessConfig(
    'http://127.0.0.1:4567/mcp',
    'cap-2',
    JSON.stringify({
      model: 'host/default-model',
      permission: { read: 'allow' },
      mcp: { existing: { type: 'local', command: ['existing'] } }
    })
  )
  assert.equal(config.model, 'host/default-model')
  assert.deepEqual(config.permission, {
    read: 'allow',
    edit: 'deny',
    bash: 'deny',
    webfetch: 'deny'
  })
  assert.ok((config.mcp as Record<string, unknown>).existing)
  assert.ok((config.mcp as Record<string, unknown>)['codetask-business-test'])
})

test('waitForCapabilityReport returns null on timeout when prompt succeeded but no report', async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/capability-report')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ report: null }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`
  try {
    const started = Date.now()
    const report = await waitForCapabilityReport(mcpUrl, 'cap-missing', 200, { pollMs: 50 })
    assert.equal(report, null)
    assert.ok(Date.now() - started >= 200)
    assert.ok(Date.now() - started < 2_000)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('waitForCapabilityReport returns completed report', async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ report: { status: 'completed', summary: 'ok' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`
  try {
    const report = await waitForCapabilityReport(mcpUrl, 'cap-ok', 1_000, { pollMs: 50 })
    assert.deepEqual(report, { status: 'completed', summary: 'ok' })
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('waitForCapabilityReport treats timeoutMs 0 as immediate miss (not infinite)', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ report: null }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`
  try {
    const started = Date.now()
    const report = await waitForCapabilityReport(mcpUrl, 'cap-zero', 0, { pollMs: 50 })
    assert.equal(report, null)
    assert.ok(Date.now() - started < 500)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

test('MCP server exit surfaces as mcp_failed after bounded retries', async () => {
  const started = Date.now()
  await assert.rejects(
    waitForCapabilityReport('http://127.0.0.1:9/mcp', 'cap-down', 150, {
      pollMs: 40
    }),
    (error: unknown) => {
      assert.equal(classifyDriverCatchError(error), 'mcp_failed')
      return true
    }
  )
  assert.ok(Date.now() - started >= 150)
})
