import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAssignedReferencesMarkdown,
  collectMissingReferenceDescriptions,
  referenceRequiresDescription
} from '../../src/shared/draft-references.ts'

test('referenceRequiresDescription requires images', () => {
  assert.equal(referenceRequiresDescription({ id: '1', name: 'ui.png', kind: 'image' }), true)
  assert.equal(referenceRequiresDescription({ id: '2', name: 'notes.md', kind: 'file' }), false)
})

test('collectMissingReferenceDescriptions lists unnamed images', () => {
  const missing = collectMissingReferenceDescriptions([
    { id: '1', name: 'ui.png', kind: 'image', description: '' },
    { id: '2', name: 'ui.png', kind: 'image', description: 'header layout' }
  ])
  assert.deepEqual(missing, ['ui.png'])
})

test('buildAssignedReferencesMarkdown requires localPath when requireLocalPaths is set', () => {
  const markdown = buildAssignedReferencesMarkdown({
    references: [
      {
        id: 'ref-1',
        name: 'home.png',
        kind: 'image',
        description: 'Blog homepage hero',
        assetUrl: '/api/threads/t1/attachments/ref-1'
      }
    ],
    referenceIds: ['ref-1'],
    referenceReason: 'Use for header component',
    requireLocalPaths: true
  })
  assert.match(markdown, /localPath: \(MISSING/)
  assert.doesNotMatch(markdown, /preview:/)
})

test('buildAssignedReferencesMarkdown includes planner note and local path', () => {
  const markdown = buildAssignedReferencesMarkdown({
    references: [
      {
        id: 'ref-1',
        name: 'home.png',
        kind: 'image',
        description: 'Blog homepage hero',
        assetUrl: '/api/threads/t1/attachments/ref-1'
      }
    ],
    referenceIds: ['ref-1'],
    referenceReason: 'Use for header component',
    localPathById: new Map([['ref-1', '/data/attachments/thread/ref-1.png']])
  })
  assert.match(markdown, /Assigned Draft References/)
  assert.match(markdown, /Planner note: Use for header component/)
  assert.match(markdown, /Blog homepage hero/)
  assert.match(markdown, /localPath: \/data\/attachments\/thread\/ref-1\.png/)
})
