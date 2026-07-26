import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import ts from 'typescript'

const repositoryRoot = resolve(import.meta.dirname, '..')
const serverRoot = join(repositoryRoot, 'src/server')
const scanRoots = ['core', 'adapters', 'interfaces', 'composition'].map((name) =>
  join(serverRoot, name)
)
const processEnvironmentAdapter = normalize(
  join(serverRoot, 'adapters/environment/process-host-environment.ts')
)

function sourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path))
    } else if (['.ts', '.tsx'].includes(extname(path))) {
      files.push(path)
    }
  }
  return files
}

function layerOf(path) {
  const relative = normalize(path).slice(normalize(serverRoot).length + 1)
  return relative.split(/[\\/]/, 1)[0]
}

function resolveImport(fromFile, specifier) {
  if (specifier.startsWith('@server/')) {
    return normalize(join(serverRoot, specifier.slice('@server/'.length)))
  }
  if (specifier.startsWith('.')) {
    return normalize(resolve(dirname(fromFile), specifier))
  }
  return null
}

function isProcessEnv(node) {
  return (
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      node.name.text === 'env') ||
    (ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === 'env')
  )
}

function processEnvIsWritten(node) {
  let outer = node
  while (
    (ts.isPropertyAccessExpression(outer.parent) || ts.isElementAccessExpression(outer.parent)) &&
    outer.parent.expression === outer
  ) {
    outer = outer.parent
  }
  return (
    (ts.isBinaryExpression(outer.parent) &&
      outer.parent.left === outer &&
      outer.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      outer.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
    (ts.isDeleteExpression(outer.parent) && outer.parent.expression === outer) ||
    (ts.isCallExpression(outer.parent) &&
      ts.isPropertyAccessExpression(outer.parent.expression) &&
      outer.parent.expression.expression.getText() === 'Object' &&
      outer.parent.expression.name.text === 'assign' &&
      outer.parent.arguments[0] === outer)
  )
}

function importViolation(file, specifier) {
  const target = resolveImport(file, specifier)
  if (!target) return null
  const fromLayer = layerOf(file)
  const targetLayer = layerOf(target)
  const targetIsCoreApplication = target.includes(normalize(join(serverRoot, 'core/application')))

  if (
    target.includes(`${normalize(join(serverRoot, 'legacy-control-plane'))}`) ||
    target.includes(`${normalize(join(serverRoot, 'http/v3'))}`) ||
    target.includes(`${normalize(join(serverRoot, 'application'))}`) ||
    target.includes(`${normalize(join(serverRoot, 'infra/sqlite/control-plane'))}`)
  ) {
    return `new kernel imports old authority: ${specifier}`
  }
  if (
    fromLayer === 'core' &&
    normalize(file).includes(normalize('core/domain')) &&
    (targetIsCoreApplication || ['adapters', 'interfaces', 'composition'].includes(targetLayer))
  ) {
    return `domain imports outer layer: ${specifier}`
  }
  if (
    fromLayer === 'core' &&
    normalize(file).includes(normalize('core/application')) &&
    ['adapters', 'interfaces', 'composition'].includes(targetLayer)
  ) {
    return `application imports outer layer: ${specifier}`
  }
  if (fromLayer === 'adapters' && targetLayer === 'interfaces') {
    return `adapter imports interface layer: ${specifier}`
  }
  if (target.endsWith(normalize('composition/config/defaults'))) {
    const allowed = normalize(file).endsWith(normalize('composition/config/resolve-app-config.ts'))
    if (!allowed) return `config defaults imported outside resolver: ${specifier}`
  }
  return null
}

function inspectSource(file, sourceText) {
  const violations = []
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true)

  for (const statement of source.statements) {
    if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) ===
        ts.NodeFlags.Let
    ) {
      violations.push('module-level let is forbidden in new architecture')
    }
    if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      violations.push('module-level var is forbidden in new architecture')
    }
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const violation = importViolation(file, node.moduleSpecifier.text)
      if (violation) violations.push(violation)
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const violation = importViolation(file, node.arguments[0].text)
      if (violation) violations.push(violation)
    }
    if (isProcessEnv(node)) {
      if (processEnvIsWritten(node)) {
        violations.push('process.env writes are forbidden')
      } else if (normalize(file) !== processEnvironmentAdapter) {
        violations.push('process.env read outside environment adapter')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...new Set(violations)]
}

function assertRuleFixtures() {
  const fixtures = [
    {
      file: join(serverRoot, 'core/domain/fixture.ts'),
      source: `import '../application/index'`,
      expected: 'domain imports outer layer'
    },
    {
      file: join(serverRoot, 'core/application/fixture.ts'),
      source: `const value = process.env.SECRET`,
      expected: 'process.env read outside environment adapter'
    },
    {
      file: processEnvironmentAdapter,
      source: `process.env.SECRET = 'value'`,
      expected: 'process.env writes are forbidden'
    },
    {
      file: join(serverRoot, 'composition/fixture.ts'),
      source: `let currentConfig = {}`,
      expected: 'module-level let is forbidden'
    }
  ]
  for (const fixture of fixtures) {
    const violations = inspectSource(fixture.file, fixture.source)
    if (!violations.some((violation) => violation.includes(fixture.expected))) {
      throw new Error(`core boundary self-test failed: ${fixture.expected}`)
    }
  }
}

assertRuleFixtures()

const violations = []
for (const root of scanRoots) {
  for (const file of sourceFiles(root)) {
    for (const violation of inspectSource(file, readFileSync(file, 'utf8'))) {
      violations.push(`${file.slice(repositoryRoot.length + 1)}: ${violation}`)
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join('\n')}\n`)
  process.exitCode = 1
} else {
  process.stdout.write('Core architecture boundaries passed.\n')
}
