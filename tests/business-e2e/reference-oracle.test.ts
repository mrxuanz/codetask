import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { extractPlanReferenceEvidence, recognizesReferenceProof } from './oracles/image-attachment'

const designDataProof = {
  imageText: 'Dream of 1000 Cats',
  designData: [
    { path: 'overview.md', content: 'DESIGN_OVERVIEW_731' },
    { path: 'api.md', content: 'DESIGN_API_842' },
    { path: 'nested/constraints.md', content: 'DESIGN_CONSTRAINT_953' }
  ]
}

const snakeCaseProof = {
  image_text: 'Dream of 1000 Cats',
  design_docs: designDataProof.designData
}

const designInfoProof = {
  imageText: 'Dream of 1000 Cats',
  designInfo: {
    overview: 'DESIGN_OVERVIEW_731',
    api: 'DESIGN_API_842',
    constraints: 'DESIGN_CONSTRAINT_953'
  }
}

const nestedDesignInfoProof = {
  imageText: 'Dream of 1000 Cats',
  designInfo: {
    files: designDataProof.designData
  }
}

test('reference proof accepts strict documents and designData schemas', () => {
  assert.equal(recognizesReferenceProof(designDataProof), true)
  assert.equal(recognizesReferenceProof(snakeCaseProof), true)
  assert.equal(recognizesReferenceProof(designInfoProof), true)
  assert.equal(recognizesReferenceProof(nestedDesignInfoProof), true)
  assert.equal(
    recognizesReferenceProof({
      imageText: 'Dream of 1000 Cats',
      documents: {
        overview: 'DESIGN_OVERVIEW_731',
        api: 'DESIGN_API_842',
        constraints: 'DESIGN_CONSTRAINT_953'
      }
    }),
    true
  )
  assert.equal(
    recognizesReferenceProof({
      ...designDataProof,
      designData: designDataProof.designData.slice(0, 2)
    }),
    false
  )
})

test('planner evidence uses the launched job canonical plan and manifest', () => {
  const assignedTask = {
    id: 'task-1',
    referenceIds: ['attachment-1', 'directory-1'],
    referenceReason: 'Read both references'
  }
  const evidence = extractPlanReferenceEvidence({
    planRecord: { plan: { milestones: [] } },
    launchedJob: {
      referenceManifest: {
        references: [{ id: 'attachment-1' }, { id: 'directory-1' }]
      },
      plan: {
        tasks: [assignedTask],
        milestones: [{ slices: [{ tasks: [assignedTask] }] }]
      }
    },
    attachmentId: 'attachment-1',
    directoryReferenceId: 'directory-1'
  })

  assert.deepEqual(evidence.manifestIds, ['attachment-1', 'directory-1'])
  assert.equal(evidence.tasks.length, 1)
  assert.deepEqual(evidence.taskReferenceIds, ['attachment-1', 'directory-1'])
  assert.equal(evidence.taskWithBoth?.id, 'task-1')
})

test('planner task evidence may cover references across separate justified tasks', () => {
  const evidence = extractPlanReferenceEvidence({
    planRecord: null,
    launchedJob: {
      plan: {
        tasks: [
          {
            id: 'image-task',
            referenceIds: ['attachment-1'],
            referenceReason: 'Read the image'
          },
          {
            id: 'corpus-task',
            referenceIds: ['directory-1'],
            referenceReason: 'Read the design corpus'
          }
        ]
      }
    },
    attachmentId: 'attachment-1',
    directoryReferenceId: 'directory-1'
  })

  assert.deepEqual(evidence.taskReferenceIds, ['attachment-1', 'directory-1'])
  assert.equal(evidence.taskWithBoth, null)
})

test('node reference proof oracle accepts generated designData output', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'business-e2e-reference-proof-'))
  try {
    writeFileSync(join(workspace, 'reference-proof.json'), JSON.stringify(designDataProof))
    const validator = resolve('tests/business-e2e/fixtures/validators/reference-proof-oracle.mjs')
    const result = spawnSync(process.execPath, [validator, '--workspace', workspace], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /reference-proof-oracle: ok/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('node reference proof oracle accepts equivalent snake_case output', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'business-e2e-reference-proof-'))
  try {
    writeFileSync(join(workspace, 'reference-proof.json'), JSON.stringify(snakeCaseProof))
    const validator = resolve('tests/business-e2e/fixtures/validators/reference-proof-oracle.mjs')
    const result = spawnSync(process.execPath, [validator, '--workspace', workspace], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /reference-proof-oracle: ok/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('node reference proof oracle accepts equivalent designInfo output', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'business-e2e-reference-proof-'))
  try {
    writeFileSync(join(workspace, 'reference-proof.json'), JSON.stringify(designInfoProof))
    const validator = resolve('tests/business-e2e/fixtures/validators/reference-proof-oracle.mjs')
    const result = spawnSync(process.execPath, [validator, '--workspace', workspace], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /reference-proof-oracle: ok/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('node reference proof oracle accepts equivalent designInfo.files output', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'business-e2e-reference-proof-'))
  try {
    writeFileSync(join(workspace, 'reference-proof.json'), JSON.stringify(nestedDesignInfoProof))
    const validator = resolve('tests/business-e2e/fixtures/validators/reference-proof-oracle.mjs')
    const result = spawnSync(process.execPath, [validator, '--workspace', workspace], {
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /reference-proof-oracle: ok/u)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
