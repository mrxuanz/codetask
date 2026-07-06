import assert from 'node:assert/strict'
import test from 'node:test'
import { signAssetUrl, stripAssetUrlAuthTokens } from '../../src/server/auth/sign-asset-url'

test('stripAssetUrlAuthTokens removes asset and session query tokens only', () => {
  assert.equal(
    stripAssetUrlAuthTokens(
      '/api/threads/thread-1/attachments/att-1?asset_token=old&view=1&access_token=session#preview'
    ),
    '/api/threads/thread-1/attachments/att-1?view=1#preview'
  )
})

test('signAssetUrl refreshes stale asset_token instead of preserving it', () => {
  const signed = signAssetUrl(
    'test-secret',
    '/api/threads/thread-1/attachments/att-1?asset_token=old-token&access_token=session&view=1#preview'
  )
  const parsed = new URL(signed, 'http://codetask.local')

  assert.equal(parsed.pathname, '/api/threads/thread-1/attachments/att-1')
  assert.equal(parsed.searchParams.get('view'), '1')
  assert.ok(parsed.searchParams.get('asset_token'))
  assert.equal(parsed.hash, '#preview')
  assert.doesNotMatch(signed, /old-token/)
  assert.doesNotMatch(signed, /access_token=/)
})
