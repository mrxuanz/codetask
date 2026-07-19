import assert from 'node:assert/strict'
import test from 'node:test'
import { searchNotes } from '../src/search-notes.mjs'

test('empty query returns empty array', () => {
  assert.deepEqual(searchNotes(''), [])
  assert.deepEqual(searchNotes('   '), [])
})

test('single keyword matches title or body (case-insensitive)', () => {
  const results = searchNotes('ALPHA')
  assert.ok(results.length >= 1, 'expected at least one match for ALPHA')
  for (const item of results) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.title, 'string')
    assert.equal(typeof item.summary, 'string')
    assert.ok(item.id.length > 0)
    assert.ok(item.title.length > 0)
    assert.ok(item.summary.length > 0)
  }
})

test('multi-keyword query uses AND semantics', () => {
  const results = searchNotes('alpha beta')
  assert.ok(results.length >= 1, 'expected AND match for alpha beta')
  const ids = results.map((item) => item.id)
  assert.ok(ids.includes('note-1'), 'note-1 should match both alpha and beta')
})

test('results stay stable across repeated queries', () => {
  const first = searchNotes('gamma')
  const second = searchNotes('gamma')
  assert.deepEqual(first, second)
})
