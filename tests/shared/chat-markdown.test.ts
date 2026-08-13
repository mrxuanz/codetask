import assert from 'node:assert/strict'
import test from 'node:test'
import { renderChatMarkdown, stabilizeStreamingMarkdown } from '../../apps/web/src/lib/chatMarkdown'

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

test('renderChatMarkdown rejects active URLs, event handlers, SVG, and MathML', () => {
  const html = renderChatMarkdown(
    [
      '[js](javascript:alert(1))',
      '[data](data:text/html;base64,PHNjcmlwdD4=)',
      '<img src="x" onerror="alert(1)" onclick="alert(2)">',
      '<svg><a href="javascript:alert(3)">x</a></svg>',
      '<math><mtext onclick="alert(4)">x</mtext></math>'
    ].join('\n')
  )
  assert.doesNotMatch(html, /javascript:|data:text|onerror|onclick|<svg|<math/i)
})

test('renderChatMarkdown gives every new-window link noopener and noreferrer', () => {
  const html = renderChatMarkdown('[safe](https://example.test)')
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
})

test('renderChatMarkdown survives malformed nested HTML without restoring active content', () => {
  const html = renderChatMarkdown(
    '<blockquote><p><a href="javascript:alert(1)"><img src=x onerror=x>'
  )
  assert.doesNotMatch(html, /javascript:|onerror/i)
})

test('renderChatMarkdown hard breaks when enabled', () => {
  const html = renderChatMarkdown('line1\nline2', { breaks: true })
  assert.match(html, /<br\s*\/?>/i)
})
