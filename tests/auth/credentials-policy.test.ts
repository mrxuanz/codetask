import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateSetupCredentials,
  validateSetupPassword,
  validateSetupUsername
} from '../../src/shared/auth/credentials-policy'
import { assertSetupCredentialsAllowed } from '../../src/server/auth/credentials-policy'
import { AppError } from '../../src/server/error'

test('rejects reserved and malformed usernames', () => {
  assert.equal(validateSetupUsername('admin')?.code, 'auth.username_reserved')
  assert.equal(validateSetupUsername('root')?.code, 'auth.username_reserved')
  assert.equal(validateSetupUsername('ab')?.code, 'auth.username_length_invalid')
  assert.equal(validateSetupUsername('1user')?.code, 'auth.username_format_invalid')
  assert.equal(validateSetupUsername('user name')?.code, 'auth.username_format_invalid')
  assert.equal(validateSetupUsername('ops_user'), null)
})

test('requires enterprise-style passwords', () => {
  assert.equal(validateSetupPassword('short1!')?.code, 'auth.password_too_short')
  assert.equal(validateSetupPassword('alllowercase1!')?.code, 'auth.password_missing_uppercase')
  assert.equal(validateSetupPassword('ALLUPPERCASE1!')?.code, 'auth.password_missing_lowercase')
  assert.equal(validateSetupPassword('NoDigits!@')?.code, 'auth.password_missing_digit')
  assert.equal(validateSetupPassword('NoSymbols1A')?.code, 'auth.password_missing_symbol')
  assert.equal(validateSetupPassword('Has space1!')?.code, 'auth.password_invalid_chars')
  assert.equal(validateSetupPassword('ValidPass1!'), null)
})

test('desktop and server share the same setup policy', () => {
  assert.equal(validateSetupCredentials('admin', 'ValidPass1!')?.code, 'auth.username_reserved')
  assert.equal(validateSetupCredentials('ops_user', '123')?.code, 'auth.password_too_short')
  assert.equal(validateSetupCredentials('ops_user', 'ValidPass1!'), null)
})

test('assertSetupCredentialsAllowed throws structured auth errors', () => {
  try {
    assertSetupCredentialsAllowed('root', 'ValidPass1!')
    assert.fail('expected reserved username rejection')
  } catch (error) {
    assert.ok(error instanceof AppError)
    assert.equal(error.data.turnErrorCode, 'auth.username_reserved')
  }
})
