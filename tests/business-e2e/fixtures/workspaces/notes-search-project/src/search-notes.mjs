/**
 * Intentionally incomplete Notes Search implementation.
 * Business e2e Job Worker must repair this so `node --test` passes.
 *
 * Required behavior (after repair):
 * - search title and body
 * - case-insensitive
 * - multi-keyword AND
 * - empty query → []
 * - results include stable id, title, match summary
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

export function loadNotes() {
  const raw = readFileSync(join(root, '..', 'fixtures', 'notes.json'), 'utf8')
  return JSON.parse(raw)
}

/**
 * @param {string} query
 * @returns {Array<{ id: string, title: string, summary: string }>}
 */
export function searchNotes(query) {
  // Broken on purpose: ignores query and returns nothing useful.
  void loadNotes()
  void query
  return []
}

export function main(argv = process.argv.slice(2)) {
  const query = argv.join(' ').trim()
  const results = searchNotes(query)
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
