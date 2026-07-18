import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const tscEntrypoint = resolve(repositoryRoot, 'node_modules/typescript/bin/tsc')

const knownDiagnostics = [
  {
    file: 'src/server/agent-runtime/cursor-acp/acp-shared.ts',
    line: 206,
    column: 11,
    code: 'TS2375'
  },
  {
    file: 'src/server/agent-runtime/providers/claude-sdk.ts',
    line: 36,
    column: 59,
    code: 'TS2379'
  },
  {
    file: 'src/server/agent-runtime/providers/codex-policy.ts',
    line: 57,
    column: 59,
    code: 'TS2379'
  },
  {
    file: 'src/server/agent-runtime/providers/cursor-policy.ts',
    line: 41,
    column: 59,
    code: 'TS2379'
  },
  {
    file: 'src/server/agent-runtime/providers/opencode-sdk.ts',
    line: 58,
    column: 59,
    code: 'TS2379'
  },
  {
    file: 'src/server/agent-runtime/providers/opencode-sdk.ts',
    line: 390,
    column: 59,
    code: 'TS2379'
  },
  {
    file: 'src/server/agent-runtime/runner.ts',
    line: 252,
    column: 53,
    code: 'TS2379'
  },
  {
    file: 'src/server/conversation/service.ts',
    line: 372,
    column: 50,
    code: 'TS2379'
  }
]

function diagnosticKey(diagnostic) {
  return [diagnostic.file, diagnostic.line, diagnostic.column, diagnostic.code].join('\u0000')
}

function annotation(kind, diagnostic, title) {
  const location = `file=${diagnostic.file},line=${diagnostic.line},col=${diagnostic.column}`
  return `::${kind} ${location},title=${title}::${diagnostic.code}: ${diagnostic.message}`
}

const result = spawnSync(
  process.execPath,
  [tscEntrypoint, '--noEmit', '-p', 'tsconfig.control-plane.json', '--pretty', 'false'],
  {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  }
)

if (result.error) {
  throw result.error
}

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
const diagnosticPattern = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm
const actualDiagnostics = [...output.matchAll(diagnosticPattern)].map((match) => ({
  file: match[1],
  line: Number(match[2]),
  column: Number(match[3]),
  code: match[4],
  message: match[5]
}))

const knownByKey = new Map(
  knownDiagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic])
)
const actualByKey = new Map(
  actualDiagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic])
)
const unexpectedDiagnostics = actualDiagnostics.filter(
  (diagnostic) => !knownByKey.has(diagnosticKey(diagnostic))
)
const staleAllowances = knownDiagnostics.filter(
  (diagnostic) => !actualByKey.has(diagnosticKey(diagnostic))
)

for (const diagnostic of actualDiagnostics) {
  if (knownByKey.has(diagnosticKey(diagnostic))) {
    console.log(annotation('warning', diagnostic, 'BUSINESS-003 known control-plane type error'))
  }
}

for (const diagnostic of unexpectedDiagnostics) {
  console.error(annotation('error', diagnostic, 'Unexpected control-plane type error'))
}

for (const diagnostic of staleAllowances) {
  console.error(
    `Stale typecheck baseline: ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.code}`
  )
}

const hasUnparsedFailure = result.status !== 0 && actualDiagnostics.length === 0
if (hasUnparsedFailure) {
  console.error(output.trim() || `TypeScript exited with status ${result.status}`)
}

const hasUnexpectedTermination =
  result.signal !== null || (result.status !== 0 && result.status !== 2)
if (hasUnexpectedTermination && !hasUnparsedFailure) {
  console.error(
    `TypeScript terminated unexpectedly (status=${result.status}, signal=${result.signal ?? 'none'})`
  )
}

console.log(
  `Control-plane typecheck baseline: ${actualDiagnostics.length}/${knownDiagnostics.length} known diagnostic(s)`
)

if (
  unexpectedDiagnostics.length > 0 ||
  staleAllowances.length > 0 ||
  hasUnparsedFailure ||
  hasUnexpectedTermination
) {
  process.exitCode = 1
}
