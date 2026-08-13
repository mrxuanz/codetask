import { existsSync, readFileSync } from 'node:fs'
import type { DriverStartInput } from './contract'
import { buildCreateHtmlUserMessage, htmlFileNameForConversationCore } from '../config/sdk-html'

export function buildAgentOperatorPrompt(input: DriverStartInput): string {
  const conversationCore = input.conversationCore.trim()
  if (!conversationCore) throw new Error('conversation_core_required')

  const skillText = input.skillPaths
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n\n---\n\n')

  const message =
    typeof input.fixture?.message === 'string'
      ? input.fixture.message
      : input.caseId === 'chat-create-html'
        ? buildCreateHtmlUserMessage(
            input.expectedHtmlFile?.trim() || htmlFileNameForConversationCore(conversationCore)
          )
        : '请用中文简短回答：1+1等于几？'

  const caseHints: Record<string, string> = {
    'chat-create-html':
      'Create project/thread with the conversation coreCode. Ask the product agent to create the SDK-named HTML file in workspace root (opencode.html / cursor.html / …) containing BUSINESS_E2E_CHAT_HTML. If the agent asks for details, follow up up to 3 more turns (4 total) restating filename+marker; stop early if the file exists. Then report with expectedHtmlFile in artifacts.',
    'chat-image-attachment':
      'Upload image fixture as attachment.png only. start_turn with attachmentIds on the first turn only. If the agent asks for details, follow up up to 3 more turns without re-attaching. Do not put Dream/1000/Cats into message, titles, or fileName. Report messageIdsBefore + attachmentId + turnId.',
    'design-draft-confirm':
      'Create a chat thread first. Clarify requirements in at most 4 turns if the agent asks for details, then use Design MCP only: codetask_create_draft → patch abilities → patch execution profile → codetask_confirm_design_draft. Do not use create_task turns.'
  }

  return [
    skillText,
    '',
    '## Runtime context',
    `- caseId: ${input.caseId}`,
    `- workspaceRoot to use when creating project: ${input.workspaceRoot}`,
    `- conversationCore to use for every CodeTask thread: ${conversationCore}`,
    '- draft executionConfig (per-run Design execution-profile, NOT global settings):',
    `  - plannerCoreCode: ${input.executionConfig.plannerCoreCode}`,
    `  - sliceVerifierCoreCode: ${input.executionConfig.sliceVerifierCoreCode}`,
    `  - milestoneVerifierCoreCode: ${input.executionConfig.milestoneVerifierCoreCode}`,
    `- user message for the conversation turn: ${message}`,
    caseHints[input.caseId] ? `- case-specific instructions: ${caseHints[input.caseId]}` : '',
    '',
    'Act as the human operating CodeTask. Execute the skill using only the allowed Test MCP tools. Call report_case_result exactly once when done.'
  ]
    .filter(Boolean)
    .join('\n')
}
