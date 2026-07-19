import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const tscEntrypoint = resolve(repositoryRoot, 'node_modules/typescript/bin/tsc')

const knownDiagnostics = [
  {
    file: 'src/server/agent-runtime/cursor-acp/acp-shared.ts',
    code: 'TS2375',
    sourceLine: 'toolCall: {',
    count: 1
  },
  {
    file: 'src/server/agent-runtime/providers/claude-sdk.ts',
    code: 'TS2379',
    sourceLine: 'const capabilityProfile = resolveInputCapabilityProfile(input)',
    count: 1
  },
  {
    file: 'src/server/agent-runtime/providers/codex-policy.ts',
    code: 'TS2379',
    sourceLine: 'const capabilityProfile = resolveInputCapabilityProfile(input)',
    count: 1
  },
  {
    file: 'src/server/agent-runtime/providers/cursor-policy.ts',
    code: 'TS2379',
    sourceLine: 'const capabilityProfile = resolveInputCapabilityProfile(input)',
    count: 1
  },
  {
    file: 'src/server/agent-runtime/providers/opencode-sdk.ts',
    code: 'TS2379',
    sourceLine: 'const capabilityProfile = resolveInputCapabilityProfile(input)',
    count: 2
  },
  {
    file: 'src/server/agent-runtime/runner.ts',
    code: 'TS2379',
    sourceLine: 'yield* withSandboxLeaseRefresh(sandboxStream, {',
    count: 1
  },
  {
    file: 'src/server/conversation/service.ts',
    code: 'TS2379',
    sourceLine: 'const prepared = await prepareConversationTurn({',
    count: 1
  }
]

function diagnosticKey(diagnostic) {
  return [diagnostic.file, diagnostic.code, diagnostic.sourceLine].join('\u0000')
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
  message: match[5],
  sourceLine:
    readFileSync(resolve(repositoryRoot, match[1]), 'utf8')
      .split(/\r?\n/u)
      [Number(match[2]) - 1]?.trim() ?? ''
}))

const knownByKey = new Map(
  knownDiagnostics.map((diagnostic) => [diagnosticKey(diagnostic), diagnostic])
)
const actualCounts = new Map()
const unexpectedDiagnostics = []
for (const diagnostic of actualDiagnostics) {
  const key = diagnosticKey(diagnostic)
  const count = (actualCounts.get(key) ?? 0) + 1
  actualCounts.set(key, count)
  const known = knownByKey.get(key)
  if (!known || count > known.count) unexpectedDiagnostics.push(diagnostic)
}
const staleAllowances = knownDiagnostics.filter(
  (diagnostic) => (actualCounts.get(diagnosticKey(diagnostic)) ?? 0) < diagnostic.count
)

for (const diagnostic of actualDiagnostics) {
  if (
    knownByKey.has(diagnosticKey(diagnostic)) &&
    (actualCounts.get(diagnosticKey(diagnostic)) ?? 0) <=
      knownByKey.get(diagnosticKey(diagnostic)).count
  ) {
    console.log(annotation('warning', diagnostic, 'BUSINESS-003 known control-plane type error'))
  }
}

for (const diagnostic of unexpectedDiagnostics) {
  console.error(annotation('error', diagnostic, 'Unexpected control-plane type error'))
}

for (const diagnostic of staleAllowances) {
  console.error(
    `Stale typecheck baseline: ${diagnostic.file} ${diagnostic.code} ${JSON.stringify(diagnostic.sourceLine)}`
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
  `Control-plane typecheck baseline: ${actualDiagnostics.length}/${knownDiagnostics.reduce((total, diagnostic) => total + diagnostic.count, 0)} known diagnostic(s)`
)

if (
  unexpectedDiagnostics.length > 0 ||
  staleAllowances.length > 0 ||
  hasUnparsedFailure ||
  hasUnexpectedTermination
) {
  process.exitCode = 1
}
