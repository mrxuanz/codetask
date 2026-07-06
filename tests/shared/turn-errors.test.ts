import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTurnError } from '../../src/shared/turn-errors/normalize.ts'
import {
  parseStoredTurnError,
  serializeStoredTurnError
} from '../../src/shared/turn-errors/storage.ts'
import {
  createTurnError,
  TURN_CANCELLED,
  JOB_PAUSED
} from '../../src/shared/turn-errors/turn-error.ts'

test('normalizeTurnError maps Cursor keepalive failures to acp_keepalive_timeout', () => {
  const dto = normalizeTurnError(
    new Error('RetriableError: [internal] HTTP/2 keepalive ping timed out after 5000ms')
  )
  assert.equal(dto.code, 'provider.cursor.acp_keepalive_timeout')
  assert.match(dto.message, /cloud connection timed out/i)
})

test('normalizeTurnError maps AbortError to turn.cancelled', () => {
  const dto = normalizeTurnError(
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  )
  assert.equal(dto.code, 'turn.cancelled')
})

test('TurnError round-trips through storage', () => {
  const original = createTurnError('provider.codex.api_unreachable', {
    params: { url: 'https://api.example.com' }
  }).toDto()
  const raw = serializeStoredTurnError(original)
  const parsed = parseStoredTurnError(raw)
  assert.equal(parsed?.code, 'provider.codex.api_unreachable')
  assert.equal(parsed?.params?.url, 'https://api.example.com')
})

test('parseStoredTurnError no longer maps legacy Chinese workflow strings', () => {
  const parsed = parseStoredTurnError('无就绪子任务，工作流阻塞')
  assert.equal(parsed, null)
})

test('TURN_CANCELLED and JOB_PAUSED have stable codes', () => {
  assert.equal(TURN_CANCELLED.code, 'turn.cancelled')
  assert.equal(JOB_PAUSED.code, 'job.paused')
})
