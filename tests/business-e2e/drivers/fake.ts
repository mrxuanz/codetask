import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { AgentDriver, DriverResult, DriverStartInput } from './contract'
import { McpToolClient } from '../mcp/client'
import { progress } from '../reports/progress'
import { findAttachmentPermissionRefusal, findImageInputUnsupported } from './attachment-permission'
import {
  buildCreateHtmlUserMessage,
  CHAT_HTML_MARKER,
  htmlFileNameForConversationCore
} from '../config/sdk-html'
import { CLI_MCP_ROOT_KEY, PROBE_OK, PROBE_SERVER_NAME } from '../config/providers'
import type { SutCoreCode } from '../config/profiles'
import {
  assertNoLeak,
  IMAGE_FIXTURE_FILE,
  IMAGE_FORBIDDEN_LEAK_TOKENS,
  IMAGE_UPLOAD_FILE_NAME,
  resolveImageFixturePath
} from '../oracles/image-attachment'
import { htmlFileSatisfied, runChatWithClarificationLoop } from './chat-clarify-loop'

type Push = (type: string, detail?: unknown) => void

function selectedConversationCore(input: DriverStartInput): string {
  const core = input.conversationCore.trim()
  if (!core) throw new Error('conversation_core_required')
  return core
}

/**
 * Deterministic driver used to validate Test MCP + public API surfaces
 * without consuming external Driver model quota. SUT agents may still run.
 */
export class FakeDriver implements AgentDriver {
  readonly name = 'fake'
  private static pollLogAt = new Map<string, number>()

  async start(input: DriverStartInput): Promise<DriverResult> {
    const events: DriverResult['events'] = []
    const push: Push = (type, detail) => {
      events.push({ type, at: new Date().toISOString(), detail })
      // Avoid flooding the terminal on long poll loops.
      if (
        type === 'plan.poll' ||
        type === 'job.poll_terminal' ||
        type === 'wizard.phase' ||
        type === 'collect.snapshot' ||
        type === 'drafts'
      ) {
        const key = `${input.caseId}:${type}`
        const now = Date.now()
        const last = FakeDriver.pollLogAt.get(key) ?? 0
        if (now - last < 5_000) return
        FakeDriver.pollLogAt.set(key, now)
      }
      progress(input.caseId, type, detail)
    }

    progress(input.caseId, 'driver.start', { driver: this.name, timeoutMs: input.timeoutMs })

    try {
      const mcp = new McpToolClient(input.mcpUrl, input.capabilityId)
      await mcp.initialize()
      push('mcp.initialized')

      if (input.caseId === 'FOUNDATION-FAKE-001' || input.caseId.startsWith('FOUNDATION')) {
        await this.runFoundation(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId === 'DESIGN-DRAFT-001') {
        await this.runDesignDraftSmoke(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId === 'CHAT-HTML-001') {
        await this.runCreateHtmlConversation(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId === 'CHAT-IMG-001') {
        await this.runChatImageAttachment(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId === 'SETTINGS-MCP-001') {
        await this.runSettingsMcpProbe(input, mcp, push)
        return { ok: true, events }
      }

      if (input.caseId.startsWith('G2')) {
        const project = (await mcp.callTool('codetask_create_project', {
          workspaceRoot: input.workspaceRoot,
          title: 'fake-g2'
        })) as { id: string }
        push('project.created', { id: project.id })
        await mcp.callTool('case_checkpoint', { name: 'project_created' })

        const thread = (await mcp.callTool('codetask_create_thread', {
          projectId: project.id,
          title: 'fake-thread',
          coreCode: selectedConversationCore(input)
        })) as { id: string }
        push('thread.created', { id: thread.id })
        await mcp.callTool('case_checkpoint', { name: 'thread_created' })

        const got = (await mcp.callTool('codetask_get_thread', {
          threadId: thread.id
        })) as { id?: string }
        if (got.id !== thread.id) throw new Error('thread_mismatch')

        await mcp.callTool('codetask_list_cores', {})
        await mcp.callTool('report_case_result', {
          caseId: input.caseId,
          status: 'completed',
          summary: 'Fake driver created project and thread via Test MCP',
          observations: [{ step: 'g2', result: 'ok', projectId: project.id, threadId: thread.id }],
          artifacts: { projectId: project.id, threadId: thread.id }
        })
        push('case.reported')
        return { ok: true, events }
      }

      if (input.caseId.startsWith('G3')) {
        const message =
          typeof input.fixture?.message === 'string'
            ? input.fixture.message
            : '请用中文简短回答：1+1等于几？'
        const project = (await mcp.callTool('codetask_create_project', {
          workspaceRoot: input.workspaceRoot,
          title: 'fake-g3'
        })) as { id: string }
        const thread = (await mcp.callTool('codetask_create_thread', {
          projectId: project.id,
          coreCode: selectedConversationCore(input)
        })) as { id: string }
        const loop = await runChatWithClarificationLoop(mcp, {
          threadId: thread.id,
          initialMessage: message,
          clarifyMessage: '不需要更多细节。请直接用中文只回复数字答案，不要解释、不要追问。',
          push
        })
        await mcp.callTool('codetask_list_messages', { threadId: thread.id })
        await mcp.callTool('report_case_result', {
          caseId: input.caseId,
          status: 'completed',
          summary: 'Fake driver completed conversation turn',
          observations: [
            {
              step: 'turn',
              result: loop.lastTurnStatus,
              turnsUsed: loop.turnsUsed,
              clarified: loop.clarified
            }
          ],
          artifacts: {
            projectId: project.id,
            threadId: thread.id,
            turnId: loop.turnIds[loop.turnIds.length - 1],
            turnIds: loop.turnIds
          }
        })
        return { ok: true, events }
      }

      throw new Error(`fake_driver_unsupported_case:${input.caseId}`)
    } catch (error) {
      push('error', { error: String(error) })
      return {
        ok: false,
        classification: classifyFakeDriverError(error),
        error: String(error),
        events
      }
    }
  }

  private async runFoundation(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const project = (await mcp.callTool('codetask_create_project', {
      workspaceRoot: input.workspaceRoot,
      title: 'foundation-notes-search'
    })) as { id: string }
    push('project.created', { id: project.id })

    const thread = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: 'foundation-chat',
      coreCode: selectedConversationCore(input),
      threadKind: 'chat'
    })) as { id: string }
    push('thread.created', { id: thread.id })

    const phase1 = (await mcp.callTool('case_next_fixture', {})) as {
      phase?: string
      payload?: { message?: string }
    }
    push('fixture.phase', phase1)
    if (phase1.phase !== 'fuzzy') throw new Error(`unexpected_phase:${phase1.phase}`)

    const phase2 = (await mcp.callTool('case_next_fixture', { phase: 'scope' })) as {
      phase?: string
      payload?: { message?: string }
    }
    if (phase2.phase !== 'scope') throw new Error(`unexpected_phase:${phase2.phase}`)
    push('fixture.phase', phase2)

    const fuzzyMessage =
      typeof phase1.payload?.message === 'string' && phase1.payload.message.trim()
        ? phase1.payload.message
        : '帮我做一个笔记搜索功能，具体先不定。'
    const scopeMessage =
      typeof phase2.payload?.message === 'string' && phase2.payload.message.trim()
        ? phase2.payload.message
        : '范围：在本地 notes.json 里按标题和正文搜索。不要追问，确认理解即可。'

    const loop = await runChatWithClarificationLoop(mcp, {
      threadId: thread.id,
      initialMessage: fuzzyMessage,
      clarifyMessage: [
        scopeMessage,
        '不要继续追问。若信息已够，用一句话确认你已理解需求即可。'
      ].join('\n'),
      push
    })
    push('chat.clarify_loop', {
      turnsUsed: loop.turnsUsed,
      clarified: loop.clarified,
      turnIds: loop.turnIds
    })
    await mcp.callTool('case_checkpoint', { name: 'turn_completed' })

    const draft = (await mcp.callTool('codetask_create_draft', {
      projectId: project.id,
      title: 'Foundation design draft',
      summary: 'Smoke draft for MCP surface',
      requirementsMarkdown: '# Requirements\n- foundation probe'
    })) as { id: string; status?: string }
    push('draft.created', { id: draft.id, status: draft.status })
    await mcp.callTool('case_checkpoint', { name: 'draft_created' })

    const listed = await mcp.callTool('codetask_list_drafts', {})
    push('drafts.listed', listed)

    await mcp.callTool('codetask_get_draft', { draftId: draft.id })
    await mcp.callTool('case_checkpoint', { name: 'design_draft_surface_ok' })

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary:
        'Foundation fake exercised chat clarify-loop + Design draft create/list/get (architecture 03)',
      observations: [
        {
          step: 'design_draft',
          draftId: draft.id,
          turnsUsed: loop.turnsUsed,
          clarified: loop.clarified
        }
      ],
      artifacts: {
        projectId: project.id,
        threadId: thread.id,
        draftId: draft.id,
        turnId: loop.turnIds[loop.turnIds.length - 1],
        turnIds: loop.turnIds
      }
    })
    push('case.reported')
  }

  private async runDesignDraftSmoke(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const core = selectedConversationCore(input)
    const project = (await mcp.callTool('codetask_create_project', {
      workspaceRoot: input.workspaceRoot,
      title: 'design-draft-smoke'
    })) as { id: string }
    push('project.created', { id: project.id })

    const thread = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: 'design-draft-chat',
      coreCode: core,
      threadKind: 'chat'
    })) as { id: string }
    push('thread.created', { id: thread.id })

    const loop = await runChatWithClarificationLoop(mcp, {
      threadId: thread.id,
      initialMessage:
        '帮我做一个笔记功能：创建笔记、列出笔记。先确认你理解需求即可，不要实现代码。',
      clarifyMessage: [
        '范围已定：create notes + list notes。',
        '不要追问。用一句话确认你已理解，然后停止。'
      ].join(''),
      push
    })
    push('chat.clarify_loop', {
      turnsUsed: loop.turnsUsed,
      clarified: loop.clarified,
      turnIds: loop.turnIds
    })
    await mcp.callTool('case_checkpoint', { name: 'turn_completed' })

    let draft = (await mcp.callTool('codetask_create_draft', {
      projectId: project.id,
      title: 'Design draft smoke',
      summary: 'Confirmable Design draft',
      requirementsMarkdown: '# Requirements\n- create notes\n- list notes'
    })) as {
      id: string
      lockRevision: number
      status: string
    }
    push('draft.created', draft)

    draft = (await mcp.callTool('codetask_patch_draft_abilities', {
      draftId: draft.id,
      expectedRevision: draft.lockRevision,
      abilities: [
        {
          abilityCode: 'general',
          label: 'General',
          description: 'General implementation',
          reason: 'default',
          recommendedCoreCode: core
        }
      ]
    })) as typeof draft
    push('draft.abilities', { revision: draft.lockRevision })

    draft = (await mcp.callTool('codetask_patch_draft_execution_profile', {
      draftId: draft.id,
      expectedRevision: draft.lockRevision,
      plannerCoreCode: core,
      sliceVerifierCoreCode: core,
      milestoneVerifierCoreCode: core
    })) as typeof draft
    push('draft.execution_profile', { revision: draft.lockRevision })

    draft = (await mcp.callTool('codetask_confirm_design_draft', {
      draftId: draft.id,
      expectedRevision: draft.lockRevision
    })) as typeof draft
    if (draft.status !== 'confirmed') {
      throw new Error(`draft_not_confirmed:${draft.status}`)
    }
    push('draft.confirmed', { id: draft.id, status: draft.status })
    await mcp.callTool('case_checkpoint', { name: 'draft_confirmed' })

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: 'Design draft: chat clarify-loop → create → abilities → execution profile → confirm',
      observations: [
        {
          step: 'confirm',
          draftId: draft.id,
          status: draft.status,
          turnsUsed: loop.turnsUsed,
          clarified: loop.clarified
        }
      ],
      artifacts: {
        projectId: project.id,
        threadId: thread.id,
        draftId: draft.id,
        turnId: loop.turnIds[loop.turnIds.length - 1],
        turnIds: loop.turnIds
      }
    })
    push('case.reported')
  }

  private async runSettingsMcpProbe(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const core = selectedConversationCore(input) as SutCoreCode
    const rootKey = CLI_MCP_ROOT_KEY[core] ?? 'mcp'
    const probeUrl = input.probeMcpUrl?.replace(/\/$/, '') || ''
    const probeName = input.probeMcpName || PROBE_SERVER_NAME
    if (!probeUrl) throw new Error('probe_mcp_url_missing')

    const serverEntry =
      core === 'opencode'
        ? {
            type: 'remote',
            url: probeUrl,
            enabled: true,
            headers: { Accept: 'application/json, text/event-stream' }
          }
        : {
            url: probeUrl,
            headers: { Accept: 'application/json, text/event-stream' }
          }

    const before = (await mcp.callTool('codetask_get_mcp_settings', {})) as {
      settings?: { roles?: Record<string, unknown> }
      revision?: number
    }
    push('settings.mcp.snapshot', { core, hasSettings: Boolean(before?.settings) })
    await mcp.callTool('case_checkpoint', { name: 'mcp_settings_snapshot' })

    const base =
      before?.settings && typeof before.settings === 'object'
        ? structuredClone(before.settings as { roles?: Record<string, unknown> })
        : { roles: { conversation: {}, planner: {}, task: {}, verification: {} } }
    if (!base.roles || typeof base.roles !== 'object') {
      base.roles = {}
    }
    const rolesMap = base.roles as Record<string, Record<string, unknown>>

    const roles = ['conversation', 'task', 'verification'] as const
    for (const role of roles) {
      const roleMap =
        rolesMap[role] && typeof rolesMap[role] === 'object'
          ? ({ ...rolesMap[role] } as Record<string, unknown>)
          : {}
      const fragment =
        roleMap[core] && typeof roleMap[core] === 'object'
          ? (roleMap[core] as Record<string, unknown>)
          : { [rootKey]: {} }
      const servers =
        fragment[rootKey] && typeof fragment[rootKey] === 'object'
          ? { ...(fragment[rootKey] as Record<string, unknown>) }
          : {}
      servers[probeName] = serverEntry
      roleMap[core] = { [rootKey]: servers }
      rolesMap[role] = roleMap
    }
    base.roles = rolesMap

    let revision = typeof before.revision === 'number' ? before.revision : 0
    const registered = (await mcp.callTool('codetask_put_mcp_settings', {
      settings: base,
      expectedRevision: revision
    })) as { revision?: number }
    revision = typeof registered?.revision === 'number' ? registered.revision : revision + 1
    push('settings.mcp.registered', { core, probeName, probeUrl, roles: [...roles] })
    await mcp.callTool('case_checkpoint', { name: 'mcp_probe_registered' })

    const after = (await mcp.callTool('codetask_get_mcp_settings', {})) as {
      settings?: Record<string, unknown>
      revision?: number
    }
    if (typeof after?.revision === 'number') revision = after.revision
    const afterText = JSON.stringify(after?.settings ?? {})
    if (!afterText.includes(probeName)) {
      throw new Error('settings_mcp_roundtrip_missing_probe')
    }
    push('settings.mcp.roundtrip_ok', { probeName })

    const reservedAttempt = structuredClone(base)
    const reservedRoles =
      reservedAttempt.roles && typeof reservedAttempt.roles === 'object'
        ? (reservedAttempt.roles as Record<string, Record<string, unknown>>)
        : {}
    const conv =
      reservedRoles.conversation && typeof reservedRoles.conversation === 'object'
        ? ({ ...reservedRoles.conversation } as Record<string, unknown>)
        : {}
    const frag = (conv[core] ?? { [rootKey]: {} }) as Record<string, unknown>
    const servers = {
      ...((frag[rootKey] as Record<string, unknown>) ?? {}),
      'codetask-manager': serverEntry
    }
    conv[core] = { [rootKey]: servers }
    reservedRoles.conversation = conv
    reservedAttempt.roles = reservedRoles
    let reservedFailed = false
    try {
      await mcp.callTool('codetask_put_mcp_settings', {
        settings: reservedAttempt,
        expectedRevision: revision
      })
    } catch {
      reservedFailed = true
    }
    if (!reservedFailed) {
      throw new Error('settings_mcp_reserved_name_should_fail')
    }
    push('settings.mcp.reserved_rejected', { ok: true })

    // Harness self-check: call probe HTTP MCP tools/call directly.
    const probeHits: Record<string, string> = {}
    for (const role of roles) {
      const tool =
        role === 'conversation'
          ? 'ping_conversation'
          : role === 'task'
            ? 'ping_task'
            : 'ping_verification'
      const res = await fetch(probeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: {} }
        })
      })
      const json = (await res.json()) as {
        result?: { content?: Array<{ text?: string }> }
      }
      const text = json.result?.content?.[0]?.text ?? ''
      probeHits[role] = text
      const expected = PROBE_OK[role]
      if (text !== expected) {
        throw new Error(`probe_self_check_failed:${role}:got=${text}`)
      }
    }
    push('settings.mcp.probe_self_ok', probeHits)
    await mcp.callTool('case_checkpoint', { name: 'mcp_probe_self_ok' })

    // Restore prior snapshot
    if (before?.settings) {
      await mcp.callTool('codetask_put_mcp_settings', {
        settings: before.settings,
        expectedRevision: revision
      })
      push('settings.mcp.restored')
    }

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Settings MCP probe registered for ${core} (conversation/task/verification)`,
      observations: [
        {
          step: 'settings-mcp-probe',
          core,
          probeName,
          probeUrl,
          probeHits,
          reservedRejected: true
        }
      ],
      artifacts: { conversationCore: core, probeName, probeUrl }
    })
    push('case.reported', { core, probeName })
  }

  private async runChatImageAttachment(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const core = selectedConversationCore(input)
    const message =
      typeof input.fixture?.message === 'string'
        ? input.fixture.message
        : '请读取附件图片，只回复图片中看到的英文内容。'
    const uploadFileName =
      typeof input.fixture?.uploadFileName === 'string'
        ? input.fixture.uploadFileName
        : IMAGE_UPLOAD_FILE_NAME
    const imagePath = resolveImageFixturePath(IMAGE_FIXTURE_FILE)
    assertNoLeak('chat.message', message, IMAGE_FORBIDDEN_LEAK_TOKENS)
    assertNoLeak('chat.uploadFileName', uploadFileName, IMAGE_FORBIDDEN_LEAK_TOKENS)

    const projectTitle = `chat-img-probe-${core}`
    const threadTitle = 'chat-img-probe'
    assertNoLeak('chat.projectTitle', projectTitle, IMAGE_FORBIDDEN_LEAK_TOKENS)
    assertNoLeak('chat.threadTitle', threadTitle, IMAGE_FORBIDDEN_LEAK_TOKENS)

    const project = (await mcp.callTool('codetask_create_project', {
      workspaceRoot: input.workspaceRoot,
      title: projectTitle
    })) as { id: string }
    push('project.created', { id: project.id })
    await mcp.callTool('case_checkpoint', { name: 'project_created' })

    const thread = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: threadTitle,
      coreCode: core,
      threadKind: 'chat'
    })) as { id: string }
    push('thread.created', { id: thread.id, coreCode: core })
    await mcp.callTool('case_checkpoint', { name: 'thread_created' })

    const uploaded = (await mcp.callTool('codetask_upload_attachment', {
      threadId: thread.id,
      filePath: imagePath,
      fileName: uploadFileName
    })) as { attachment?: { id?: string }; id?: string }
    const attachmentId = uploaded.attachment?.id ?? uploaded.id
    if (!attachmentId) throw new Error('attachment_id_missing')
    push('attachment.uploaded', { attachmentId, uploadFileName })
    await mcp.callTool('case_checkpoint', { name: 'attachment_uploaded', detail: { attachmentId } })

    const before = (await mcp.callTool('codetask_list_messages', {
      threadId: thread.id
    })) as Array<Record<string, unknown>> | { data?: Array<Record<string, unknown>> }
    const beforeList = Array.isArray(before) ? before : (before.data ?? [])
    const messageIdsBefore = beforeList
      .map((item) => (typeof item.id === 'string' ? item.id : ''))
      .filter(Boolean)

    const startedLoop = await runChatWithClarificationLoop(mcp, {
      threadId: thread.id,
      initialMessage: message,
      attachmentIds: [attachmentId],
      clarifyMessage:
        '不要追问、不要解释。请只回复附件图片中看到的英文原文内容，不要输出其它文字。',
      push
    })
    const lastTurnId = startedLoop.turnIds[startedLoop.turnIds.length - 1]!
    push('turn.done', {
      status: startedLoop.lastTurnStatus,
      turnId: lastTurnId,
      turnsUsed: startedLoop.turnsUsed,
      clarified: startedLoop.clarified
    })
    const afterTurnMessages = await mcp.callTool('codetask_list_messages', {
      threadId: thread.id
    })
    const attachmentPermissionRefusal = findAttachmentPermissionRefusal(afterTurnMessages)
    if (attachmentPermissionRefusal) {
      throw new Error(
        `attachment_read_permission_denied:${core}:${attachmentPermissionRefusal.slice(0, 240)}`
      )
    }
    const imageInputUnsupported = findImageInputUnsupported(afterTurnMessages)
    if (imageInputUnsupported) {
      throw new Error(
        `provider_image_input_unsupported:${core}:${imageInputUnsupported.slice(0, 240)}`
      )
    }
    await mcp.callTool('case_checkpoint', { name: 'turn_completed' })

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `CHAT-IMG attachment turn completed (core=${core})`,
      observations: [
        {
          step: 'chat-image-attachment',
          core,
          attachmentId,
          turnStatus: startedLoop.lastTurnStatus,
          turnsUsed: startedLoop.turnsUsed,
          clarified: startedLoop.clarified
        }
      ],
      artifacts: {
        projectId: project.id,
        threadId: thread.id,
        turnId: lastTurnId,
        turnIds: startedLoop.turnIds,
        attachmentId,
        messageIdsBefore,
        conversationCore: core
      }
    })
    push('case.reported', { attachmentId })
  }

  private async runCreateHtmlConversation(
    input: DriverStartInput,
    mcp: McpToolClient,
    push: Push
  ): Promise<void> {
    const core = selectedConversationCore(input)
    const fileName = input.expectedHtmlFile?.trim() || htmlFileNameForConversationCore(core)
    const marker =
      typeof input.fixture?.expect === 'object' &&
      input.fixture.expect &&
      typeof (input.fixture.expect as { htmlMarker?: unknown }).htmlMarker === 'string'
        ? (input.fixture.expect as { htmlMarker: string }).htmlMarker
        : CHAT_HTML_MARKER
    const message =
      typeof input.fixture?.message === 'string'
        ? input.fixture.message
        : buildCreateHtmlUserMessage(fileName, marker)

    push('html.expected', { core, fileName, marker })

    const project = (await mcp.callTool('codetask_create_project', {
      workspaceRoot: input.workspaceRoot,
      title: `chat-html-${core}`
    })) as { id: string }
    push('project.created', { id: project.id })
    await mcp.callTool('case_checkpoint', { name: 'project_created' })

    const thread = (await mcp.callTool('codetask_create_thread', {
      projectId: project.id,
      title: `create-${fileName}`,
      coreCode: core
    })) as { id: string }
    push('thread.created', { id: thread.id, coreCode: core })
    await mcp.callTool('case_checkpoint', { name: 'thread_created' })

    const loop = await runChatWithClarificationLoop(mcp, {
      threadId: thread.id,
      initialMessage: message,
      clarifyMessage: [
        `不要追问。请立即在工作区根目录创建 ${fileName}。`,
        `文件必须是合法 HTML，body 中必须包含纯文本标记 ${marker}。`,
        '创建完成后只确认文件名，不要创建其它文件。'
      ].join(''),
      isSatisfied: () => htmlFileSatisfied(input.workspaceRoot, fileName),
      push
    })
    const lastTurnId = loop.turnIds[loop.turnIds.length - 1]!
    push('turn.done', {
      status: loop.lastTurnStatus,
      turnId: lastTurnId,
      turnsUsed: loop.turnsUsed,
      clarified: loop.clarified
    })
    await mcp.callTool('codetask_list_messages', { threadId: thread.id })
    await mcp.callTool('case_checkpoint', { name: 'turn_completed' })

    const target = join(input.workspaceRoot, fileName)
    if (!existsSync(target)) {
      throw new Error(`expected_html_missing:${fileName}`)
    }
    push('html.oracle', { wrote: fileName })

    await mcp.callTool('report_case_result', {
      caseId: input.caseId,
      status: 'completed',
      summary: `Conversation create-html: ${fileName} (core=${core})`,
      observations: [
        {
          step: 'chat-create-html',
          fileName,
          core,
          turnStatus: loop.lastTurnStatus,
          turnsUsed: loop.turnsUsed,
          clarified: loop.clarified
        }
      ],
      artifacts: {
        projectId: project.id,
        threadId: thread.id,
        turnId: lastTurnId,
        turnIds: loop.turnIds,
        expectedHtmlFile: fileName,
        conversationCore: core
      }
    })
    push('case.reported', { fileName })
  }

  async cleanup(): Promise<void> {
    /* no-op */
  }
}

function classifyFakeDriverError(error: unknown): string {
  const text = String(error).toLowerCase()
  if (text.includes('provider_image_input_unsupported')) return 'provider_unavailable'
  if (text.includes('timeout:') || text.includes('_timeout')) return 'timeout'
  if (
    text.includes('mcp_') ||
    text.includes('fetch failed') ||
    text.includes('econnreset') ||
    text.includes('econnrefused')
  ) {
    return 'mcp_failed'
  }
  return 'agent_failed'
}
