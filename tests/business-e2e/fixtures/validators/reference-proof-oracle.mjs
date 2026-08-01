#!/usr/bin/env node
/**
 * Node file oracle for draft-reference-path-job.
 * Usage: node reference-proof-oracle.mjs --workspace <path>
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const EXPECTED = 'Dream of 1000 Cats'
const SENTINELS = {
  overview: 'DESIGN_OVERVIEW_731',
  api: 'DESIGN_API_842',
  constraints: 'DESIGN_CONSTRAINT_953'
}

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function fail(message) {
  process.stderr.write(`reference-proof-oracle: ${message}\n`)
  process.exit(1)
}

function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
}

function main(argv = process.argv.slice(2)) {
  const workspaceArg = readArg(argv, '--workspace')
  if (!workspaceArg) fail('--workspace <path> required')
  const workspace = resolve(workspaceArg)
  const proofPath = join(workspace, 'reference-proof.json')
  if (!existsSync(proofPath)) fail(`missing ${proofPath}`)

  let proof
  try {
    proof = JSON.parse(readFileSync(proofPath, 'utf8'))
  } catch (error) {
    fail(`invalid_json:${error}`)
  }

  const imageText = proof.imageText ?? proof.image_text
  if (!normalize(imageText).includes(normalize(EXPECTED))) {
    fail(`imageText_mismatch:${JSON.stringify(imageText)}`)
  }

  const objectCandidates = [proof.documents, proof.designInfo].filter(
    (item) => item && typeof item === 'object' && !Array.isArray(item)
  )
  const directObjectMatch = objectCandidates.some((item) =>
    Object.entries(SENTINELS).every(([key, token]) => String(item[key] ?? '').includes(token))
  )

  const rowCandidates = [proof.designData, proof.design_docs].filter(Array.isArray)
  for (const item of objectCandidates) {
    if (Array.isArray(item.files)) rowCandidates.push(item.files)
  }
  const designRowsMatch = rowCandidates.some((rows) => {
    const byPath = new Map(
      rows
        .filter((item) => item && typeof item === 'object')
        .map((item) => [String(item.path ?? '').replaceAll('\\', '/'), String(item.content ?? '')])
    )
    return (
      String(byPath.get('overview.md') ?? '').includes(SENTINELS.overview) &&
      String(byPath.get('api.md') ?? '').includes(SENTINELS.api) &&
      String(byPath.get('nested/constraints.md') ?? '').includes(SENTINELS.constraints)
    )
  })

  if (!directObjectMatch && !designRowsMatch) {
    fail('design_references_missing_or_malformed')
  }
  process.stdout.write('reference-proof-oracle: ok\n')
}

main()
