import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, join, relative } from 'path'

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.cursor',
  '.codegraph',
  '__pycache__',
  '.venv',
  'venv'
])

const SNIPPET_FILES = [
  'package.json',
  'README.md',
  'README',
  'readme.md',
  'tsconfig.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod'
] as const

const MAX_TREE_ENTRIES = 48
const MAX_SNIPPET_CHARS = 2_400
const MAX_TOTAL_CHARS = 12_000

interface TreeEntry {
  path: string
  kind: 'file' | 'dir'
}

function listTreeEntries(workspaceRoot: string, maxDepth: number): TreeEntry[] {
  const entries: TreeEntry[] = []

  function walk(dir: string, depth: number): void {
    if (entries.length >= MAX_TREE_ENTRIES || depth > maxDepth) return

    let dirents
    try {
      dirents = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    dirents.sort((a, b) => {
      const aDir = a.isDirectory()
      const bDir = b.isDirectory()
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    for (const dirent of dirents) {
      if (entries.length >= MAX_TREE_ENTRIES) return
      const name = dirent.name
      if (!name || name.startsWith('.')) continue

      const absolute = join(dir, name)
      const rel = relative(workspaceRoot, absolute).replace(/\\/g, '/')

      if (dirent.isDirectory()) {
        if (SKIP_DIR_NAMES.has(name)) {
          entries.push({ path: `${rel}/`, kind: 'dir' })
          continue
        }
        entries.push({ path: `${rel}/`, kind: 'dir' })
        walk(absolute, depth + 1)
      } else if (dirent.isFile()) {
        entries.push({ path: rel, kind: 'file' })
      }
    }
  }

  walk(workspaceRoot, 0)
  return entries
}

function readSnippet(workspaceRoot: string, fileName: string): string | null {
  const absolute = join(workspaceRoot, fileName)
  if (!existsSync(absolute)) return null
  try {
    const stats = statSync(absolute)
    if (!stats.isFile() || stats.size > 64_000) return null
    const raw = readFileSync(absolute, 'utf8').trim()
    if (!raw) return null
    if (raw.length <= MAX_SNIPPET_CHARS) return raw
    return `${raw.slice(0, MAX_SNIPPET_CHARS)}\n…(truncated)`
  } catch {
    return null
  }
}

export function buildWorkspaceSnapshot(workspaceRoot: string): string {
  const rootLabel = workspaceRoot.replace(/\\/g, '/')
  const lines = [
    '## Workspace snapshot (authoritative, read-only)',
    `folder: ${rootLabel}`,
    `folder_name: ${basename(workspaceRoot)}`,
    '',
    'Use this snapshot to understand what already exists before asking requirements questions.',
    'Do not claim you inspected files that are not listed here.'
  ]

  if (!existsSync(workspaceRoot)) {
    lines.push('', 'The workspace folder does not exist or is not accessible.')
    return lines.join('\n')
  }

  try {
    const stats = statSync(workspaceRoot)
    if (!stats.isDirectory()) {
      lines.push('', 'The workspace path is not a directory.')
      return lines.join('\n')
    }
  } catch {
    lines.push('', 'The workspace folder is not accessible.')
    return lines.join('\n')
  }

  const tree = listTreeEntries(workspaceRoot, 2)
  lines.push('', '### Top-level layout')
  if (tree.length === 0) {
    lines.push('(empty folder)')
  } else {
    for (const entry of tree) {
      lines.push(`- ${entry.path}`)
    }
    if (tree.length >= MAX_TREE_ENTRIES) {
      lines.push('…(listing truncated)')
    }
  }

  const snippets: string[] = []
  for (const fileName of SNIPPET_FILES) {
    const snippet = readSnippet(workspaceRoot, fileName)
    if (!snippet) continue
    snippets.push(`### ${fileName}\n\`\`\`\n${snippet}\n\`\`\``)
  }

  if (snippets.length > 0) {
    lines.push('', '### Key file excerpts')
    lines.push(...snippets)
  }

  let body = lines.join('\n')
  if (body.length > MAX_TOTAL_CHARS) {
    body = `${body.slice(0, MAX_TOTAL_CHARS)}\n…(workspace snapshot truncated)`
  }
  return body
}
