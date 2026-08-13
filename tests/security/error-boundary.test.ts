import assert from 'node:assert/strict'
import test from 'node:test'
import { AppError, toErrorResponse } from '../../src/server/error'

const SECRET = 'sk-ant-error-boundary-secret-value'
const INTERNAL_PATH = '/Users/private-user/workspace/database.sqlite'

test('internal and database AppErrors keep causes out of public responses', () => {
  for (const error of [
    AppError.internal(new Error(`provider stderr ${SECRET} at ${INTERNAL_PATH}`)),
    AppError.db(new Error(`SQLITE_CORRUPT ${SECRET} at ${INTERNAL_PATH}`))
  ]) {
    const response = JSON.stringify(toErrorResponse(error, 'request-1'))
    assert.doesNotMatch(response, /sk-ant-error-boundary-secret-value/)
    assert.doesNotMatch(response, /private-user/)
    assert.doesNotMatch(response, /SQLITE_CORRUPT/)
    assert.match(response, /request-1/)
  }
})

test('unknown errors expose only the stable internal error envelope', () => {
  const response = toErrorResponse(new Error(`raw ${SECRET}`), 'request-2')
  assert.equal(response.success, false)
  if (response.success) assert.fail('expected an error response')
  assert.equal(response.error.message, 'Internal server error')
  assert.doesNotMatch(JSON.stringify(response), /sk-ant-error-boundary-secret-value/)
})
