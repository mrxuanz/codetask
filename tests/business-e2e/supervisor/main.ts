import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PublicApiClient } from '../api/client'
import * as ops from '../api/operations'
import { resolveProfile } from '../config/profiles'
import { PROBE_SERVER_NAME, resolveProviderQueue } from '../config/providers'
import { startSettingsMcpProbe } from '../probes/settings-mcp-probe'
import { TIMEOUTS } from '../config/timeouts'
import { MANIFESTS, resolveCaseIds, type CaseManifest } from '../cases/catalog'
import {
  formatCaseList,
  labelForCaseId,
  labelForPart,
  resolveSelection,
  scopeLabelForCaseId,
  slugForCaseId
} from '../cases/selection'
import { startTestMcpServer } from '../mcp/server'
import type { Capability } from '../mcp/capabilities'
import {
  allPassed,
  runAgentReportOracle,
  runHttpStateOracle,
  runLedgerOracle,
  runProcessOracle,
  type OracleResult
} from '../oracles/http-state'
import { OperationLedger } from '../reports/ledger'
import { assertNoSecrets } from '../reports/redaction'
import { ReportWriter, type CaseReport, type FailureClass } from '../reports/writer'
import { CredentialVault } from './credential-vault'
import { fixturePath, runCaseWorker, runCrashingWorker, skillPath } from './case-process'
import { ProcessRegistry, isAlive } from './process-registry'
import {
  assertExists,
  createCaseRunId,
  createRunId,
  ensureRunLayout,
  randomAccount,
  readJson,
  repoRootFromHere
} from './run-layout'
import { startDedicatedServer, type ServerHandle } from './server-process'
import { runPreflightCleanup } from './preflight'
import {
  assertWorkspaceCopied,
  copyFixtureWorkspace
} from './workspace-copy'
import type { FixturePhaseState } from '../mcp/capabilities'
import { progress } from '../reports/progress'
import { setLang, tFailure, tSuccess } from '../i18n'
import {
  htmlFileNameForConversationCore
} from '../config/sdk-html'

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  setLang(readFlag(argv, '--lang') ?? process.env.BUSINESS_E2E_LANG)

  if (hasFlag(argv, '--list') || hasFlag(argv, '--help')) {
    console.log(formatCaseList())
    console.log(`
Examples:
  npm run business:e2e:conversation
  npm run business:e2e:chat-html
  npm run business:e2e:draft-job
  npm run business:e2e:settings-mcp
  npm run business:e2e:phases
  npm run business:e2e -- --providers opencode --part conversation,draft-job,settings-mcp
  npm run business:e2e -- --providers cursor,opencode --case chat-basic --lang en
  npm run business:e2e -- --providers all --suite both
`)
    process.exit(0)
  }
  if (hasFlag(argv, '--enable-provider') && readFlag(argv, '--enable-provider') === 'codex') {
    if (process.env.BUSINESS_ALLOW_CODEX !== '1') {
      console.log(JSON.stringify({ skipped: true, reason: 'provider_disabled', provider: 'codex' }))
      process.exit(0)
    }
  }

  const providerQueue = resolveProviderQueue({
    providers: readFlag(argv, '--providers'),
    profile: readFlag(argv, '--profile')
  })
  const selection = resolveSelection({
    part: readFlag(argv, '--part'),
    suite: readFlag(argv, '--suite'),
    caseId: readFlag(argv, '--case'),
    gate: readFlag(argv, '--gate')
  })
  for (const warning of selection.warnings) {
    console.warn(`[business-e2e] warn · ${warning}`)
  }
  const caseIds =
    selection.legacyGate != null
      ? resolveCaseIds({ gate: selection.legacyGate })
      : selection.caseIds.length > 0
        ? selection.caseIds
        : resolveCaseIds({})
  const keepRuntime =
    hasFlag(argv, '--keep-runtime') || process.env.BUSINESS_E2E_KEEP_RUNTIME === '1'
  const runStartedAt = new Date().toISOString()

  const repoRoot = repoRootFromHere()
  progress('supervisor', 'preflight.start', { keepRuntime })
  runPreflightCleanup({ repoRoot, keepRuntime })

  progress('supervisor', 'run.start', {
    providers: providerQueue.map((p) => ({
      alias: p.alias,
      core: p.core,
      skip: p.skipReason ?? null
    })),
    阶段: selection.part?.map(labelForPart) ?? null,
    套件: selection.suite,
    用例: caseIds.map((id) => scopeLabelForCaseId(id)),
    数量: caseIds.length
  })

  const runId = createRunId()
  const runRoot = join(repoRoot, 'tests/business-e2e/.runtime/runs', runId)
  const layout = ensureRunLayout(runRoot)
  const ledger = new OperationLedger(layout.reports)
  const reports = new ReportWriter(layout.reports)
  const registry = new ProcessRegistry(layout.pids)
  const vault = new CredentialVault()

  reports.writeManifest({
    runId,
    providers: providerQueue.map((p) => ({
      alias: p.alias,
      core: p.core,
      profile: p.profile.name,
      skipReason: p.skipReason ?? null
    })),
    caseIds,
    startedAt: runStartedAt,
    runRoot,
    host: '127.0.0.1'
  })

  let server: ServerHandle | undefined
  let mcp: Awaited<ReturnType<typeof startTestMcpServer>> | undefined
  let settingsProbe: Awaited<ReturnType<typeof startSettingsMcpProbe>> | undefined
  const caseSummaries: Array<{ caseId: string; classification: FailureClass }> = []
  let failed = 0
  let passed = 0
  let skipped = 0

  try {
    // Ensure build artifact exists (G0-001 may also assert this).
    assertExists(join(repoRoot, 'out/main/standalone.js'), 'standalone_entry')

    server = await startDedicatedServer({ repoRoot, runRoot, registry, ledger })
    progress('supervisor', 'server.ready', { baseUrl: server.baseUrl, pid: server.pid })
    const client = new PublicApiClient(server.baseUrl, {
      token: () => vault.peekBearerToken(),
      ledger
    })

    // Auth bootstrap for cases that need it. G1-003 owns the setup assertion.
    const account = randomAccount()
    vault.setAccount(account.username, account.password)

    mcp = await startTestMcpServer({
      client: client.withToken(() => vault.getBearerToken()),
      ledger
    })
    progress('supervisor', 'mcp.ready', { url: mcp.url })

    const needsSettingsProbe = caseIds.includes('SETTINGS-MCP-001')
    if (needsSettingsProbe) {
      settingsProbe = await startSettingsMcpProbe()
      progress('supervisor', 'settings.probe.ready', {
        name: settingsProbe.name,
        url: settingsProbe.url
      })
    }

    for (const slot of providerQueue) {
      const profile = slot.profile
      if (slot.skipReason) {
        progress('supervisor', 'case.skipped', {
          provider: slot.alias,
          reason: slot.skipReason
        })
        caseSummaries.push({
          caseId: `provider:${slot.alias}`,
          classification: 'skipped'
        })
        skipped += 1
        continue
      }

      progress('supervisor', 'settings.control_plane', {
        provider: slot.alias,
        core: slot.core,
        profile: profile.name
      })

      for (const id of caseIds) {
        const scope = `${scopeLabelForCaseId(id)} [${slot.alias}]`
        const slug = slugForCaseId(id)
        const manifest = MANIFESTS[id]
        if (!manifest) {
          progress(scope, 'case.skipped', { reason: 'manifest_missing', internalId: id })
          caseSummaries.push({
            caseId: `${labelForCaseId(id)}/${slot.alias}`,
            classification: 'skipped'
          })
          skipped += 1
          continue
        }

        const caseRunId = createCaseRunId(`${id}-${slot.alias}`)
        const started = Date.now()
        let report: CaseReport
        progress(scope, 'case.start', {
          driver: manifest.driver,
          title: manifest.title,
          provider: slot.alias,
          skipReason: manifest.skipReason ?? null
        })

        if (manifest.skipReason) {
          report = {
            runId,
            caseRunId,
            caseId: id,
            driverProvider:
              manifest.driver === 'supervisor' ? 'supervisor' : profile.driverProvider,
            roleProviders: profile.roleProviders,
            agentReportedCompleted: false,
            requiredOperationsObserved: true,
            oraclePassed: true,
            noProcessLeak: true,
            classification: 'skipped',
            summary: manifest.skipReason,
            durationMs: Date.now() - started,
            serverPid: server?.pid
          }
          progress(scope, 'case.skipped', { reason: manifest.skipReason })
          caseSummaries.push({
            caseId: `${labelForCaseId(id)}/${slot.alias}`,
            classification: 'skipped'
          })
          skipped += 1
          reports.writeCase(report)
          continue
        }

        try {
          if (!server || !isAlive(server.pid)) {
            throw Object.assign(new Error('sut_crash'), { classification: 'sut_crash' })
          }

          report = await executeCase({
            manifest,
            caseRunId,
            profile,
            repoRoot,
            runRoot,
            layout,
            server,
            client,
            vault,
            mcp,
            ledger,
            registry,
            probeMcpUrl: settingsProbe?.url,
            probeMcpName: settingsProbe?.name ?? PROBE_SERVER_NAME
          })
        } catch (error) {
          const classification = classifyError(error)
          report = {
            runId,
            caseRunId,
            caseId: id,
            driverProvider:
              manifest.driver === 'supervisor' ? 'supervisor' : profile.driverProvider,
            roleProviders: profile.roleProviders,
            agentReportedCompleted: false,
            requiredOperationsObserved: false,
            oraclePassed: false,
            noProcessLeak: true,
            classification,
            summary: String(error),
            durationMs: Date.now() - started,
            serverPid: server?.pid,
            error: String(error)
          }
        }

        reports.writeCase(report)
        caseSummaries.push({
          caseId: `${labelForCaseId(id)}/${slot.alias}`,
          classification: report.classification
        })
        if (report.classification === 'passed') passed += 1
        else if (report.classification === 'skipped') skipped += 1
        else failed += 1
        progress(scope, 'case.done', {
          classification: report.classification,
          durationMs: report.durationMs,
          summary: report.summary
        })

        // Post-case health (R16)
        if (server) {
          const healthy = isAlive(server.pid) && (await client.health().catch(() => false))
          if (!healthy) {
            console.error(
              JSON.stringify({
                event: 'sut_crash',
                caseId: slug,
                label: scope,
                internalId: id,
                provider: slot.alias
              })
            )
            break
          }
        }
        registry.stopCase(caseRunId)
        mcp.capabilities.revoke(caseRunId)
      }
    }
  } finally {
    await settingsProbe?.close().catch(() => undefined)
    await mcp?.close().catch(() => undefined)
    await server?.stop().catch(() => undefined)
    registry.stopAllExcept()
    vault.clear()
  }

  const summary = {
    runId,
    providers: providerQueue.map((p) => ({
      alias: p.alias,
      core: p.core,
      profile: p.profile.name,
      skipReason: p.skipReason ?? null
    })),
    baseUrl: server?.baseUrl ?? '',
    serverPid: server?.pid ?? 0,
    startedAt: runStartedAt,
    finishedAt: new Date().toISOString(),
    passed,
    failed,
    skipped,
    cases: caseSummaries
  }
  reports.writeSummary(summary)
  assertNoSecrets(summary, 'final_summary')
  console.log(JSON.stringify(summary, null, 2))
  if (failed > 0) {
    console.log(tFailure())
  } else {
    console.log(tSuccess())
  }
  process.exitCode = failed > 0 ? 1 : 0
}

async function executeCase(ctx: {
  manifest: CaseManifest
  caseRunId: string
  profile: ReturnType<typeof resolveProfile>
  repoRoot: string
  runRoot: string
  layout: ReturnType<typeof ensureRunLayout>
  server: ServerHandle
  client: PublicApiClient
  vault: CredentialVault
  mcp: Awaited<ReturnType<typeof startTestMcpServer>>
  ledger: OperationLedger
  registry: ProcessRegistry
  probeMcpUrl?: string
  probeMcpName?: string
}): Promise<CaseReport> {
  const {
    manifest,
    caseRunId,
    profile,
    server,
    client,
    vault,
    mcp,
    ledger,
    registry,
    repoRoot,
    layout,
    probeMcpUrl,
    probeMcpName
  } = ctx
  const started = Date.now()
  const caseDir = join(layout.cases, caseRunId)
  mkdirSync(caseDir, { recursive: true })

  if (manifest.driver === 'supervisor') {
    return runSupervisorCase({
      manifest,
      caseRunId,
      profile,
      server,
      client,
      vault,
      ledger,
      registry,
      repoRoot,
      runRoot: ctx.runRoot,
      started
    })
  }

  // Ensure authenticated for agent cases
  if (!vault.peekBearerToken()) {
    progress(scopeLabelForCaseId(manifest.caseId), 'auth.ensure')
    await ensureAuthenticated(client, vault, server)
  }

  progress(scopeLabelForCaseId(manifest.caseId), 'settings.control_plane', {
    planner: profile.roleProviders.planner,
    slice: profile.roleProviders.sliceVerifier,
    milestone: profile.roleProviders.milestoneVerifier
  })
  await ops.putControlPlanePolicies(client.withCase(caseRunId), {
    plannerCoreCode: profile.roleProviders.planner,
    sliceVerifierCoreCode: profile.roleProviders.sliceVerifier,
    milestoneVerifierCoreCode: profile.roleProviders.milestoneVerifier
  })
  const controlPlane = await ops.getControlPlanePolicies(client.withCase(caseRunId))
  ledger.record({
    caseRunId,
    operationId: 'settings.control_plane.verified',
    transport: 'http',
    routeOrTool: '/api/settings/control-plane',
    ok: true,
    detail: controlPlane
  })

  const workspaceRoot = join(layout.workspaces, caseRunId)
  if (manifest.workspaceFixture) {
    progress(scopeLabelForCaseId(manifest.caseId), 'workspace.copy', { fixture: manifest.workspaceFixture })
    copyFixtureWorkspace({
      repoRoot,
      fixtureWorkspaceName: manifest.workspaceFixture,
      destinationRoot: workspaceRoot
    })
    if (manifest.workspaceFixture === 'notes-search-project') {
      assertWorkspaceCopied(workspaceRoot, [
        'package.json',
        'SENTINEL.txt',
        'src/search-notes.mjs',
        'test/search-notes.test.mjs',
        'fixtures/notes.json'
      ])
    }
  } else {
    mkdirSync(workspaceRoot, { recursive: true })
    writeFileSync(join(workspaceRoot, 'README.md'), `# ${manifest.caseId}\n`, 'utf8')
  }

  let fixtureState: FixturePhaseState | undefined
  if (manifest.stagedFixture) {
    progress(scopeLabelForCaseId(manifest.caseId), 'fixture.stage', { stagedFixture: manifest.stagedFixture })
    const staged = readJson<{
      fixtureId?: string
      phaseOrder: string[]
      phases: Record<string, { message?: string }>
    }>(fixturePath(repoRoot, manifest.stagedFixture))
    fixtureState = {
      fixtureId: staged.fixtureId ?? manifest.stagedFixture,
      phaseOrder: staged.phaseOrder,
      phases: staged.phases,
      nextIndex: 0,
      unlocked: []
    }
  }

  const capability = mcp.capabilities.issue({
    caseRunId,
    caseId: manifest.caseId,
    allowedTools: manifest.allowedTools,
    workspaceRoot,
    fixtureState
  })

  const conversationCore = profile.roleProviders.conversation
  const expectedHtmlFile =
    manifest.caseId === 'CHAT-HTML-001'
      ? htmlFileNameForConversationCore(conversationCore)
      : undefined

  const agentRoot = join(layout.agents, caseRunId)
  const resultPath = join(caseDir, 'worker-result.json')
  progress(scopeLabelForCaseId(manifest.caseId), 'worker.start', {
    driver: manifest.driver,
    timeoutMs: manifest.timeoutMs ?? TIMEOUTS.caseTotalMs,
    ...(expectedHtmlFile ? { expectedHtmlFile, conversationCore } : {})
  })
  const workerResult = await runCaseWorker(
    {
      caseId: manifest.caseId,
      caseRunId,
      driver: manifest.driver,
      mcpUrl: mcp.url,
      capabilityId: capability.capabilityId,
      workspaceRoot,
      agentRoot,
      skillPaths: manifest.skills.map((name) => skillPath(repoRoot, name)),
      fixturePath: manifest.fixture ? fixturePath(repoRoot, manifest.fixture) : undefined,
      timeoutMs: manifest.timeoutMs ?? TIMEOUTS.caseTotalMs,
      resultPath,
      conversationCore,
      expectedHtmlFile,
      probeMcpUrl,
      probeMcpName
    },
    { repoRoot, registry }
  )

  const capabilityAfter = mcp.capabilities.get(capability.capabilityId)
  const artifacts = extractArtifacts(capabilityAfter?.agentReport)
  const oracleResults = await buildOracleResults({
    client: client.withCase(caseRunId),
    ledger,
    caseRunId,
    manifest,
    capability: capabilityAfter,
    server,
    registry,
    artifacts,
    expectedHtmlFile
  })

  const agentReportedCompleted = Boolean(
    capabilityAfter?.agentReport && capabilityAfter.agentReport.status === 'completed'
  )
  const requiredOperationsObserved = runLedgerOracle({
    ledger,
    caseRunId,
    requiredOperations: manifest.requiredOperations
  }).passed
  const oraclePassed = allPassed(oracleResults)
  const noProcessLeak =
    oracleResults.find((item) => item.name === 'no_case_process_leak')?.passed ?? true

  let classification: FailureClass = 'passed'
  if (!workerResult.ok && workerResult.classification) {
    classification = workerResult.classification as FailureClass
  } else if (!agentReportedCompleted) classification = 'agent_no_report'
  else if (!requiredOperationsObserved) classification = 'assertion_failed'
  else if (!oraclePassed) classification = 'oracle_failed'
  else if (!noProcessLeak) classification = 'resource_leak'

  // Final pass formula (R9)
  let passed =
    agentReportedCompleted &&
    oraclePassed &&
    requiredOperationsObserved &&
    noProcessLeak &&
    workerResult.ok

  if (manifest.expectClassification) {
    const matched = classification === manifest.expectClassification
    passed = matched && agentReportedCompleted && requiredOperationsObserved && noProcessLeak
    classification = matched ? 'passed' : 'assertion_failed'
  }

  return {
    runId: ctx.runRoot.split('/').pop() ?? caseRunId,
    caseRunId,
    caseId: manifest.caseId,
    driverProvider: manifest.driver,
    roleProviders: profile.roleProviders,
    agentReportedCompleted,
    requiredOperationsObserved,
    oraclePassed,
    noProcessLeak,
    classification: passed ? 'passed' : classification,
    summary: capabilityAfter?.agentReport?.summary ?? workerResult.error ?? classification,
    agentReport: capabilityAfter?.agentReport,
    oracleResults,
    ledgerOps: ledger.list(caseRunId),
    serverPid: server.pid,
    durationMs: Date.now() - started,
    error: workerResult.error
  }
}

async function runSupervisorCase(ctx: {
  manifest: CaseManifest
  caseRunId: string
  profile: ReturnType<typeof resolveProfile>
  server: ServerHandle
  client: PublicApiClient
  vault: CredentialVault
  ledger: OperationLedger
  registry: ProcessRegistry
  repoRoot: string
  runRoot: string
  started: number
}): Promise<CaseReport> {
  const { manifest, caseRunId, profile, server, client, vault, ledger, registry, repoRoot, runRoot, started } =
    ctx
  const scoped = client.withCase(caseRunId)
  const oracleResults: OracleResult[] = []
  let classification: FailureClass = 'passed'
  let summary = manifest.title

  switch (manifest.caseId) {
    case 'G0-001': {
      assertExists(join(repoRoot, 'out/main/standalone.js'), 'standalone_entry')
      oracleResults.push({ name: 'standalone_exists', passed: true })
      break
    }
    case 'G0-002': {
      const ok = await scoped.health()
      oracleResults.push({ name: 'health_ok', passed: ok })
      if (!ok) classification = 'assertion_failed'
      break
    }
    case 'G0-003': {
      const dataOk = server.dataDir.startsWith(runRoot)
      const bootOk = server.bootstrapDir.startsWith(runRoot)
      oracleResults.push(
        { name: 'data_dir_isolated', passed: dataOk, detail: { dataDir: server.dataDir } },
        { name: 'bootstrap_isolated', passed: bootOk, detail: { bootstrapDir: server.bootstrapDir } }
      )
      if (!dataOk || !bootOk) classification = 'assertion_failed'
      break
    }
    case 'G0-004': {
      const ok = server.baseUrl.startsWith('http://127.0.0.1:') && server.port > 0
      oracleResults.push({ name: 'localhost_port', passed: ok, detail: { port: server.port } })
      if (!ok) classification = 'assertion_failed'
      break
    }
    case 'G0-005': {
      oracleResults.push({
        name: 'single_server_pid',
        passed: isAlive(server.pid),
        detail: { pid: server.pid }
      })
      if (!isAlive(server.pid)) classification = 'sut_crash'
      break
    }
    case 'G0-006': {
      const before = server.pid
      await runCrashingWorker({ repoRoot, registry, caseRunId })
      const healthy = isAlive(before) && (await scoped.health())
      oracleResults.push({
        name: 'server_survives_worker_crash',
        passed: healthy && before === server.pid,
        detail: { before, after: server.pid }
      })
      if (!healthy) classification = 'sut_crash'
      break
    }
    case 'G1-003': {
      if (!server.setupToken) {
        classification = 'assertion_failed'
        summary = 'setup_token_missing_from_server_output'
        oracleResults.push({ name: 'setup_token_present', passed: false })
        break
      }
      await ensureAuthenticated(scoped, vault, server)
      const boot = await scoped.bootstrap(true)
      const ok = boot.authenticated === true
      oracleResults.push({ name: 'authenticated', passed: ok, detail: { initialized: boot.initialized } })
      if (!ok) classification = 'assertion_failed'
      break
    }
    case 'G1-007': {
      const noAuth = await new PublicApiClient(server.baseUrl, { ledger, caseRunId }).request(
        'GET',
        '/api/projects',
        undefined,
        { operationId: 'auth.missing_bearer', auth: false }
      )
      const badAuth = await new PublicApiClient(server.baseUrl, {
        token: 'invalid-token',
        ledger,
        caseRunId
      }).request('GET', '/api/projects', undefined, { operationId: 'auth.invalid_bearer' })
      const ok = noAuth.status === 401 && badAuth.status === 401
      oracleResults.push({
        name: 'bearer_rejected',
        passed: ok,
        detail: { noAuth: noAuth.status, badAuth: badAuth.status }
      })
      if (!ok) classification = 'http_contract'
      break
    }
    case 'G1-008': {
      const sample = {
        authorization: vault.peekBearerToken() ?? 'secret-token-value',
        nested: { token: 'abc123token' }
      }
      const { redactValue } = await import('../reports/redaction')
      const redacted = redactValue(sample)
      try {
        assertNoSecrets(redacted, 'g1_008')
        oracleResults.push({ name: 'redaction', passed: true, detail: redacted })
      } catch (error) {
        classification = 'security_violation'
        oracleResults.push({ name: 'redaction', passed: false, detail: String(error) })
      }
      break
    }
    default:
      classification = 'skipped'
      summary = 'supervisor_case_not_implemented'
  }

  const requiredOperationsObserved =
    manifest.requiredOperations.length === 0
      ? true
      : runLedgerOracle({
          ledger,
          caseRunId,
          requiredOperations: manifest.requiredOperations
        }).passed

  // Supervisor cases don't use agent report; treat as completed when oracles pass.
  const passed =
    classification === 'passed' && allPassed(oracleResults) && requiredOperationsObserved

  return {
    runId: runRoot.split('/').pop() ?? caseRunId,
    caseRunId,
    caseId: manifest.caseId,
    driverProvider: 'supervisor',
    roleProviders: profile.roleProviders,
    agentReportedCompleted: true,
    requiredOperationsObserved,
    oraclePassed: allPassed(oracleResults),
    noProcessLeak: true,
    classification: passed ? 'passed' : classification === 'passed' ? 'oracle_failed' : classification,
    summary,
    oracleResults,
    ledgerOps: ledger.list(caseRunId),
    serverPid: server.pid,
    durationMs: Date.now() - started
  }
}

async function ensureAuthenticated(
  client: PublicApiClient,
  vault: CredentialVault,
  server: ServerHandle
): Promise<void> {
  if (vault.peekBearerToken()) {
    const boot = await client.bootstrap(true)
    if (boot.authenticated) return
  }
  if (!server.setupToken) throw new Error('setup_token_unavailable')
  const username = vault.getUsername()
  const password = vault.getPassword()
  const setup = await ops.setupAccount(client, {
    username,
    password,
    setupToken: server.setupToken
  })
  const setupClient = client.withToken(setup.token)
  await ops.logout(setupClient)
  const login = await ops.login(client, { username, password })
  vault.setBearerToken(login.token)
  const boot = await client.bootstrap(true)
  if (!boot.authenticated) throw new Error('auth.bootstrap_not_authenticated')
}

async function buildOracleResults(input: {
  client: PublicApiClient
  ledger: OperationLedger
  caseRunId: string
  manifest: CaseManifest
  capability: Capability | undefined
  server: ServerHandle
  registry: ProcessRegistry
  artifacts: { projectId?: string; threadId?: string; turnId?: string }
  expectedHtmlFile?: string
}): Promise<OracleResult[]> {
  const results: OracleResult[] = []
  results.push(runAgentReportOracle(input.capability))
  results.push(
    runLedgerOracle({
      ledger: input.ledger,
      caseRunId: input.caseRunId,
      requiredOperations: input.manifest.requiredOperations
    })
  )
  results.push(
    ...runProcessOracle({
      serverPid: input.server.pid,
      serverStillAlive: isAlive(input.server.pid),
      casePidsAlive: input.registry
        .list(input.caseRunId)
        .map((item) => item.pid)
        .filter((pid) => isAlive(pid))
    })
  )

  const httpExpectations = {
    projectId: input.manifest.oracle.requireProject ? input.artifacts.projectId : undefined,
    threadId: input.manifest.oracle.requireThread ? input.artifacts.threadId : undefined,
    requireAssistantMessage: input.manifest.oracle.requireAssistantMessage,
    requireTurnCompleted: input.manifest.oracle.requireTurnCompleted,
    turnId: input.artifacts.turnId
  }
  if (httpExpectations.projectId || httpExpectations.threadId) {
    results.push(
      ...(await runHttpStateOracle({
        client: input.client,
        expectations: httpExpectations
      }))
    )
  }

  if (input.manifest.caseId === 'G6-001' || input.manifest.caseId === 'G6-002') {
    const workspaceRoot = input.capability?.workspaceRoot
    if (workspaceRoot) {
      results.push(await runNotesSearchFileOracle(workspaceRoot))
    } else {
      results.push({
        name: 'notes_search_file_oracle',
        passed: false,
        detail: { reason: 'workspace_missing' }
      })
    }
  }

  if (input.manifest.caseId === 'CHAT-HTML-001') {
    const workspaceRoot = input.capability?.workspaceRoot
    const fileName = input.expectedHtmlFile || 'opencode.html'
    progress(input.manifest.caseId, 'html.oracle', { fileName, workspaceRoot })
    if (workspaceRoot) {
      results.push(await runChatHtmlFileOracle(workspaceRoot, fileName))
    } else {
      results.push({
        name: 'chat_html_file_oracle',
        passed: false,
        detail: { reason: 'workspace_missing', fileName }
      })
    }
  }

  return results
}

async function runNotesSearchFileOracle(workspaceRoot: string): Promise<OracleResult> {
  const { spawnSync } = await import('node:child_process')
  const { join } = await import('node:path')
  const oraclePath = join(
    repoRootFromHere(),
    'tests/business-e2e/fixtures/validators/notes-search-oracle.mjs'
  )
  const result = spawnSync(process.execPath, [oraclePath, '--workspace', workspaceRoot], {
    encoding: 'utf8'
  })
  return {
    name: 'notes_search_file_oracle',
    passed: result.status === 0,
    detail: {
      status: result.status,
      stdout: result.stdout?.slice(0, 500),
      stderr: result.stderr?.slice(0, 500)
    }
  }
}

async function runChatHtmlFileOracle(
  workspaceRoot: string,
  fileName: string
): Promise<OracleResult> {
  const { spawnSync } = await import('node:child_process')
  const { join } = await import('node:path')
  const oraclePath = join(
    repoRootFromHere(),
    'tests/business-e2e/fixtures/validators/chat-html-oracle.mjs'
  )
  const result = spawnSync(
    process.execPath,
    [oraclePath, '--workspace', workspaceRoot, '--file', fileName],
    { encoding: 'utf8' }
  )
  return {
    name: 'chat_html_file_oracle',
    passed: result.status === 0,
    detail: {
      fileName,
      status: result.status,
      stdout: result.stdout?.slice(0, 500),
      stderr: result.stderr?.slice(0, 500)
    }
  }
}

function extractArtifacts(report: { artifacts?: unknown } | undefined): {
  projectId?: string
  threadId?: string
  turnId?: string
} {
  let artifacts = report?.artifacts
  if (typeof artifacts === 'string') {
    try {
      artifacts = JSON.parse(artifacts) as unknown
    } catch {
      artifacts = {}
    }
  }
  const record = (artifacts ?? {}) as Record<string, unknown>
  return {
    projectId: typeof record.projectId === 'string' ? record.projectId : undefined,
    threadId: typeof record.threadId === 'string' ? record.threadId : undefined,
    turnId: typeof record.turnId === 'string' ? record.turnId : undefined
  }
}

function classifyError(error: unknown): FailureClass {
  const text = String(error)
  if (text.includes('sut_crash')) return 'sut_crash'
  if (text.includes('timeout')) return 'timeout'
  if (text.includes('security_violation')) return 'security_violation'
  return 'runner_crash'
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
