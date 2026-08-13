import assert from 'node:assert/strict'
import test from 'node:test'
import { renderMarkdownPreview } from '../../apps/web/src/lib/markdownPreview'

test('MarkdownEditor preview escapes malicious HTML and attribute payloads', () => {
  const html = renderMarkdownPreview(
    '# <img src=x onerror=alert(1)>\n<script>alert(2)</script>\n- <svg onclick=alert(3)>',
    'default'
  )
  assert.doesNotMatch(html, /<(?:img|script|svg)\b/i)
  assert.match(html, /&lt;img/)
  assert.match(html, /&lt;script/)
  assert.match(html, /&lt;svg/)
})

test('contract preview preserves a subordinate heading hierarchy', () => {
  const html = renderMarkdownPreview('# Contract\nBody\n## Scope\nText', 'contract')
  assert.doesNotMatch(html, /<h1/i)
  assert.match(html, /<h2/i)
  assert.match(html, /<h3/i)
})
