import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { scanSourcePatterns } from './source-pattern-scan.mjs'

test('scanSourcePatterns finds matching source lines without external commands', async (t) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'codetask-source-scan-'))
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }))

  await mkdir(join(repositoryRoot, 'src', '.hidden'), { recursive: true })
  await mkdir(join(repositoryRoot, 'src', 'node_modules'), { recursive: true })
  await writeFile(join(repositoryRoot, 'src', 'safe.ts'), 'const value: string = "safe"\n')
  await writeFile(join(repositoryRoot, 'src', 'unsafe.ts'), 'const value: any = "unsafe"\n')
  await writeFile(join(repositoryRoot, 'src', '.hidden', 'ignored.ts'), 'const value: any = 1\n')
  await writeFile(
    join(repositoryRoot, 'src', 'node_modules', 'ignored.ts'),
    'const value: any = 1\n'
  )

  const matches = scanSourcePatterns({
    repositoryRoot,
    scanPaths: ['src', 'missing'],
    patterns: [':\\s*any\\b']
  })

  assert.deepEqual(matches, [
    {
      file: 'src/unsafe.ts',
      line: 1,
      text: 'const value: any = "unsafe"'
    }
  ])
})
