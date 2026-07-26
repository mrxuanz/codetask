import assert from 'node:assert/strict'
import test from 'node:test'
import {
  validateSetupCredentials,
  validateSetupPassword,
  validateSetupUsername
} from '../../src/shared/auth/credentials-policy'
import {
  validateAuthPassword,
  validateAuthUsername
} from '../../src/server/core/domain/auth/credentials'

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
  assert.equal(validateSetupPassword('NoDigitsHere!@')?.code, 'auth.password_missing_digit')
  assert.equal(validateSetupPassword('NoSymbolsHere1A')?.code, 'auth.password_missing_symbol')
  assert.equal(validateSetupPassword('Has Spaces1!A'), null)
  assert.equal(validateSetupPassword('ValidPass-42!'), null)
})

test('desktop and server share the same setup policy', () => {
  assert.equal(validateSetupCredentials('admin', 'ValidPass-42!')?.code, 'auth.username_reserved')
  assert.equal(validateSetupCredentials('ops_user', '123')?.code, 'auth.password_too_short')
  assert.equal(validateSetupCredentials('ops_user', 'ValidPass-42!'), null)
})

test('renderer and core credential policies agree on accepted credentials', () => {
  assert.equal(validateAuthUsername('ops_user'), null)
  assert.equal(validateAuthPassword('ops_user', 'ValidPass-42!'), null)
  assert.equal(validateAuthPassword('ops_user', 'Ops_User-42!'), 'password_contains_username')
  assert.equal(
    validateSetupCredentials('ops_user', 'Ops_User-42!')?.code,
    'auth.password_contains_username'
  )
})
