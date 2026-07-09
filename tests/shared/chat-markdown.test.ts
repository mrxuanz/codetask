import assert from 'node:assert/strict'
import test from 'node:test'
import { renderChatMarkdown, stabilizeStreamingMarkdown } from '../../src/renderer/src/lib/chatMarkdown'

test('stabilizeStreamingMarkdown closes an open fence', () => {
  const input = 'before\n```ts\nconst x = 1'
  assert.equal(stabilizeStreamingMarkdown(input), `${input}\n\`\`\``)
})

test('stabilizeStreamingMarkdown leaves closed fences alone', () => {
  const input = '```ts\nconst x = 1\n```'
  assert.equal(stabilizeStreamingMarkdown(input), input)
})

test('renderChatMarkdown renders headings lists and code', () => {
  const html = renderChatMarkdown('# Title\n\n- item\n\n`code`\n\n```js\nconsole.log(1)\n```')
  assert.match(html, /<h1>/)
  assert.match(html, /<li>/)
  assert.match(html, /<code>/)
  assert.match(html, /<pre>/)
})

test('renderChatMarkdown sanitizes script tags', () => {
  const html = renderChatMarkdown('hello <script>alert(1)</script>')
  assert.doesNotMatch(html, /<script/i)
})

test('renderChatMarkdown hard breaks when enabled', () => {
  const html = renderChatMarkdown('line1\nline2', { breaks: true })
  assert.match(html, /<br\s*\/?>/i)
})
