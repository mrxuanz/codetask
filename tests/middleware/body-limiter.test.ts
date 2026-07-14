import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_FORM_BODY_BYTES,
  MAX_JSON_BODY_BYTES,
  resolveBodyLimit
} from '../../src/server/middleware/body-limiter'

test('resolveBodyLimit separates json and form defaults', () => {
  assert.equal(resolveBodyLimit('application/json'), MAX_JSON_BODY_BYTES)
  assert.equal(resolveBodyLimit('application/json; charset=utf-8'), MAX_JSON_BODY_BYTES)
  assert.equal(resolveBodyLimit('application/x-www-form-urlencoded'), MAX_FORM_BODY_BYTES)
  assert.equal(resolveBodyLimit('multipart/form-data; boundary=x'), MAX_FORM_BODY_BYTES)
})

test('resolveBodyLimit honors explicit override', () => {
  assert.equal(resolveBodyLimit('application/json', 99), 99)
})
