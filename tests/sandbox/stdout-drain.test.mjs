import test from 'node:test'
import assert from 'node:assert/strict'

function drainStdoutBuffer(buffer) {
  const lines = []
  let rest = buffer
  let newline = rest.indexOf('\n')
  while (newline !== -1) {
    const line = rest.slice(0, newline).trim()
    rest = rest.slice(newline + 1)
    if (line) lines.push(line)
    newline = rest.indexOf('\n')
  }
  return { lines, rest }
}

test('drainStdoutBuffer splits JSONL lines', () => {
  const first = drainStdoutBuffer('{"type":"delta"}\n{"type":"completed"}\n')
  assert.deepEqual(first.lines, ['{"type":"delta"}', '{"type":"completed"}'])
  assert.equal(first.rest, '')
})

test('drainStdoutBuffer keeps partial line in rest', () => {
  const partial = drainStdoutBuffer('{"type":"delta"}\n{"partial":')
  assert.deepEqual(partial.lines, ['{"type":"delta"}'])
  assert.equal(partial.rest, '{"partial":')
})

test('drainStdoutBuffer handles chunked append', () => {
  let buffer = ''
  let all = []
  for (const chunk of ['{"a":1}\n{"b":', '2}\n']) {
    const drained = drainStdoutBuffer(buffer + chunk)
    buffer = drained.rest
    all = all.concat(drained.lines)
  }
  assert.deepEqual(all, ['{"a":1}', '{"b":2}'])
})
