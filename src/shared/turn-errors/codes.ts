export type TurnErrorCode =
  | 'turn.cancelled'
  | 'turn.timed_out'
  | 'turn.empty_reply'
  | 'turn.incomplete'
  | 'turn.capacity_limited'
  | 'turn.context_overflow'
  | 'turn.watchdog_no_signal'
  | 'turn.watchdog_idle'
  | 'turn.watchdog_wall'
  | 'turn.tool_aborted'
  | 'turn.unknown'
  | 'job.paused'
  | 'job.cancelled'
  | 'sandbox.turn.cancelled'
  | 'sandbox.child_closed'
  | 'sandbox.worker.busy'
  | 'sandbox.worker.missing'
  | 'sandbox.required'
  | 'sandbox.turn.timed_out'
  | 'sandbox.supervisor.cleanup_failed'
  | 'sandbox.supervisor.crashed'
  | 'provider.auth.missing'
  | 'provider.cursor.not_authenticated'
  | 'provider.cursor.cli_missing'
  | 'provider.cursor.auth_unknown'
  | 'provider.cursor.acp_failed'
  | 'provider.cursor.acp_authenticate_failed'
  | 'provider.cursor.acp_initialize_failed'
  | 'provider.cursor.acp_keepalive_timeout'
  | 'provider.cursor.acp_empty_turn'
  | 'provider.cursor.acp_stdio_unavailable'
  | 'provider.claude.not_authenticated'
  | 'provider.codex.not_authenticated'
  | 'provider.codex.config_invalid'
  | 'provider.codex.api_unreachable'
  | 'provider.codex.stream_disconnected'
  | 'provider.opencode.cli_missing'
  | 'provider.opencode.not_authenticated'
  | 'provider.opencode.server_timeout'
  | 'provider.opencode.server_exited'
  | 'provider.opencode.session_error'
  | 'provider.rate_limited'
  | 'provider.cli_auth_failed'
  | 'settings.control_plane.unsupported_core'
  | 'settings.control_plane.unknown_core'
  | 'settings.control_plane.unavailable_core'
  | 'settings.control_plane.save_failed'
  | 'settings.mcp.invalid_fragment'
  | 'settings.mcp.reserved_name'
  | 'settings.mcp.invalid_root_key'
  | 'settings.mcp.save_failed'
  | 'task.execution_failed'
  | 'task.evidence_timeout'
  | 'task.evidence_missing'
  | 'task.verifier_evidence_timeout'
  | 'task.infra_retry'
  | 'task.infra_retry_exhausted'
  | 'task.terminal_failure'
  | 'auth.unauthorized'
  | 'auth.session_expired'
  | 'auth.invalid_credentials'
  | 'auth.already_initialized'
  | 'auth.setup_required'
  | 'auth.username_password_required'
  | 'auth.username_length_invalid'
  | 'auth.username_format_invalid'
  | 'auth.username_reserved'
  | 'auth.password_too_short'
  | 'auth.password_too_long'
  | 'auth.password_missing_lowercase'
  | 'auth.password_missing_uppercase'
  | 'auth.password_missing_digit'
  | 'auth.password_missing_symbol'
  | 'auth.password_invalid_chars'
  | 'thread.not_found'
  | 'thread.busy'
  | 'thread.title_empty'
  | 'thread.kind_mismatch'
  | 'thread.read_failed'
  | 'thread.message_not_found'
  | 'thread.wizard.rollback_fields_required'
  | 'thread.wizard.invalid_rollback_target'
  | 'thread.runtime_interrupted'
  | 'thread.core_required'
  | 'project.not_found'
  | 'project.workspace_root_required'
  | 'project.path_not_found'
  | 'project.directory_not_found'
  | 'project.path_inaccessible'
  | 'project.not_a_directory'
  | 'project.home_not_found'
  | 'project.already_root'
  | 'attachment.empty'
  | 'attachment.too_large'
  | 'attachment.not_found'
  | 'attachment.missing_file_field'
  | 'design_session.not_found'
  | 'design_session.launched'
  | 'workflow.deadlock'
  | 'workflow.failed_block'
  | 'message.empty'
  | 'conversation.sse_required'
  | 'job.not_found'
  | 'job.invalid_status'
  | 'job.already_finished'
  | 'job.already_launched'
  | 'job.slot_occupied'
  | 'job.plan_empty'
  | 'job.subtask_not_found'
  | 'job.not_selected'
  | 'job.invalid_id'
  | 'job.draft_message_id_required'
  | 'job.node_ref_required'
  | 'job.selections_required'
  | 'draft.not_found'
  | 'draft.invalid_payload'
  | 'draft.conflict'
  | 'draft.locked'
  | 'draft.plan_not_ready'
  | 'draft.node_not_found'
  | 'draft.reference_not_found'
  | 'draft.reference_description_missing'
  | 'draft.reference_invalid'
  | 'draft.requirements_contract_not_confirmed'
  | 'draft.abilities_core_missing'
  | 'draft.not_locked'
  | 'draft.manifest_not_ready'
  | 'draft.references_uncovered'
  | 'draft.not_selected'
  | 'draft.update_failed'
  | 'draft.references_required'
  | 'draft.attachment_ids_required'
  | 'draft.local_path_required'
  | 'draft.local_corpus.path_required'
  | 'draft.local_corpus.invalid_path'
  | 'draft.local_corpus.file_not_allowed'
  | 'plan.cancelled'
  | 'plan.sandbox_timeout'
  | 'plan.sandbox_cleanup_failed'
  | 'wizard.invalid_phase'
  | 'wizard.already_in_phase'
  | 'wizard.rollback_not_allowed'
  | 'wizard.tool_not_allowed'

export type TurnErrorParams = Record<string, string | number | boolean>

export const TURN_ERROR_DEFAULT_MESSAGES: Record<TurnErrorCode, string> = {
  'turn.cancelled': 'Conversation cancelled',
  'turn.timed_out': 'Turn timed out',
  'turn.empty_reply': 'Agent returned no content',
  'turn.incomplete': 'Agent turn ended without completion',
  'turn.capacity_limited': 'Selected model is at capacity; retry later',
  'turn.context_overflow': 'Context window exceeded',
  'turn.watchdog_no_signal': 'Turn produced no activity signal within {seconds}s',
  'turn.watchdog_idle': 'Turn stalled with no activity signal',
  'turn.watchdog_wall': 'Turn exceeded the {minutes} minute limit',
  'turn.tool_aborted': 'Tool call aborted before completion',
  'turn.unknown': 'Agent turn failed',
  'job.paused': 'Job paused',
  'job.cancelled': 'Job cancelled',
  'sandbox.turn.cancelled': 'Sandbox turn cancelled',
  'sandbox.child_closed': 'Sandbox worker exited unexpectedly',
  'sandbox.worker.busy': 'Sandbox worker is busy',
  'sandbox.worker.missing': 'Sandbox worker not available',
  'sandbox.required': 'Sandbox is required for this operation',
  'sandbox.turn.timed_out': 'Sandbox task timed out',
  'sandbox.supervisor.cleanup_failed': 'Sandbox supervisor cleanup failed',
  'sandbox.supervisor.crashed': 'Sandbox supervisor crashed',
  'provider.auth.missing': 'Provider authentication required',
  'provider.cursor.not_authenticated':
    'Cursor Agent is not signed in. Run `agent login` in a terminal and retry.',
  'provider.cursor.cli_missing':
    'Cursor Agent CLI is not installed or not on PATH (requires the `agent` command).',
  'provider.cursor.auth_unknown': 'Unable to verify Cursor Agent sign-in status',
  'provider.cursor.acp_failed': 'Cursor ACP session failed',
  'provider.cursor.acp_authenticate_failed': 'Cursor ACP authenticate failed',
  'provider.cursor.acp_initialize_failed': 'Cursor ACP initialize failed',
  'provider.cursor.acp_keepalive_timeout':
    'Cursor Agent cloud connection timed out. Retry later or run `agent login` on the host.',
  'provider.cursor.acp_empty_turn':
    'Cursor ACP turn produced no output (cloud may have disconnected); retrying automatically',
  'provider.cursor.acp_stdio_unavailable':
    'Cursor Agent subprocess failed to start (stdio unavailable)',
  'provider.claude.not_authenticated':
    'Claude Code is not signed in. Run `claude auth login` in a terminal and retry.',
  'provider.codex.not_authenticated':
    'Codex is not signed in. Run `codex login` in a terminal and retry.',
  'provider.codex.config_invalid':
    'Codex config.toml is invalid; check custom model provider settings',
  'provider.codex.api_unreachable': 'Unable to reach Codex API',
  'provider.codex.stream_disconnected': 'Codex stream disconnected before completion',
  'provider.opencode.cli_missing': 'OpenCode CLI is not installed or not on PATH',
  'provider.opencode.not_authenticated':
    'OpenCode is not authenticated. Configure authentication or set an API key environment variable.',
  'provider.opencode.server_timeout': 'Timed out waiting for OpenCode server to start',
  'provider.opencode.server_exited': 'OpenCode server exited unexpectedly',
  'provider.opencode.session_error': 'OpenCode session error',
  'provider.rate_limited': 'Rate limited; retry later',
  'provider.cli_auth_failed': 'CLI authentication failed; check API key or sign-in status',
  'settings.control_plane.unsupported_core': 'Unsupported control plane CLI',
  'settings.control_plane.unknown_core': 'Unknown control plane CLI',
  'settings.control_plane.unavailable_core': 'Selected control plane CLI is unavailable',
  'settings.control_plane.save_failed': 'Failed to save Control Plane settings',
  'settings.mcp.invalid_fragment': 'Invalid MCP config fragment',
  'settings.mcp.reserved_name': 'Reserved MCP server name',
  'settings.mcp.invalid_root_key': 'Invalid MCP config root key',
  'settings.mcp.save_failed': 'Failed to save MCP settings',
  'task.execution_failed': 'Task execution failed',
  'task.evidence_timeout': 'Timed out waiting for task evidence',
  'task.evidence_missing': 'Structured evidence package missing',
  'task.verifier_evidence_timeout': 'Timed out waiting for verifier completion signal',
  'task.infra_retry':
    'Task {taskId} tool-layer infrastructure failure; automatic retry ({attempt}/{maxAttempts})',
  'task.infra_retry_exhausted':
    'Task {taskId} tool-layer infrastructure retries exhausted ({maxAttempts})',
  'task.terminal_failure': 'Task {taskId} failed',
  'auth.unauthorized': 'Not signed in',
  'auth.session_expired': 'Session expired',
  'auth.invalid_credentials': 'Invalid username or password',
  'auth.already_initialized': 'Account already initialized',
  'auth.setup_required': 'Account setup required',
  'auth.username_password_required': 'Username and password are required',
  'auth.username_length_invalid': 'Username must be between {minLength} and {maxLength} characters',
  'auth.username_format_invalid':
    'Username must start with a letter and contain only letters, numbers, underscores, or hyphens',
  'auth.username_reserved': 'This username is reserved and cannot be used',
  'auth.password_too_short': 'Password must be at least {minLength} characters',
  'auth.password_too_long': 'Password must be at most {maxLength} characters',
  'auth.password_missing_lowercase': 'Password must include at least one lowercase letter',
  'auth.password_missing_uppercase': 'Password must include at least one uppercase letter',
  'auth.password_missing_digit': 'Password must include at least one digit',
  'auth.password_missing_symbol': 'Password must include at least one symbol',
  'auth.password_invalid_chars': 'Password may only contain printable ASCII characters',
  'thread.not_found': 'Thread not found',
  'thread.busy': 'Thread is busy; please wait for the current turn to finish',
  'thread.title_empty': 'Thread title cannot be empty',
  'thread.kind_mismatch': 'Thread kind mismatch: expected {expected}, got {actual}',
  'thread.read_failed': 'Failed to read thread after update',
  'thread.message_not_found': 'Source message not found',
  'thread.wizard.rollback_fields_required': 'Rollback target and reason are required',
  'thread.wizard.invalid_rollback_target': 'Invalid rollback target phase',
  'thread.runtime_interrupted':
    'The previous run was interrupted when the app closed or the service restarted. You can send a new message to continue.',
  'thread.core_required': 'coreCode is required',
  'project.not_found': 'Project not found',
  'project.workspace_root_required': 'workspaceRoot is required',
  'project.path_not_found': 'Path not found: {path}',
  'project.directory_not_found': 'Directory not found: {path}',
  'project.path_inaccessible': 'Path is inaccessible: {path}',
  'project.not_a_directory': 'Not a directory: {path}',
  'project.home_not_found': 'Unable to resolve user home directory',
  'project.already_root': 'Already at root directory',
  'attachment.empty': 'Attachment cannot be empty',
  'attachment.too_large': 'Attachment exceeds size limit',
  'attachment.not_found': 'Attachment not found',
  'attachment.missing_file_field': 'Missing file field',
  'design_session.not_found': 'Design session not found',
  'design_session.launched': 'Design session already launched; corpus is immutable',
  'workflow.deadlock': 'No ready subtasks; workflow blocked',
  'workflow.failed_block': 'Failed subtasks present; workflow blocked',
  'message.empty': 'Message cannot be empty',
  'conversation.sse_required': 'Please use SSE streaming (Accept: text/event-stream)',
  'job.not_found': 'Job not found',
  'job.invalid_status': 'Job status {status} does not allow this action',
  'job.already_finished': 'Job already finished',
  'job.already_launched': 'Job already launched',
  'job.slot_occupied': 'Execution slot occupied',
  'job.plan_empty': 'Job plan is empty',
  'job.subtask_not_found': 'Subtask not found',
  'job.not_selected': 'Please use the currently selected execution plan',
  'job.invalid_id': 'designSessionId (ds-*) is required',
  'job.draft_message_id_required': 'draftMessageId is required',
  'job.node_ref_required': 'nodeRef is required',
  'job.selections_required': 'Ability selections are required',
  'draft.not_found': 'Draft not found',
  'draft.invalid_payload': 'Draft payload invalid',
  'draft.conflict': 'Draft conflict: revision mismatch',
  'draft.locked': 'Draft is locked for editing',
  'draft.plan_not_ready': 'Execution tree not generated yet',
  'draft.node_not_found': 'Plan node not found',
  'draft.reference_not_found': 'Reference not found',
  'draft.reference_description_missing': 'Reference descriptions required',
  'draft.reference_invalid': 'Invalid reference IDs',
  'draft.requirements_contract_not_confirmed': 'Requirements contract not confirmed',
  'draft.abilities_core_missing': 'Execution CLI required for every ability',
  'draft.not_locked': 'Draft is not locked',
  'draft.manifest_not_ready': 'Reference manifest is not ready',
  'draft.references_uncovered': 'References not assigned to tasks',
  'draft.not_selected': 'Please use the currently selected draft',
  'draft.update_failed': 'Failed to update collecting draft',
  'draft.references_required': 'At least one reference file is required',
  'draft.attachment_ids_required': 'attachmentIds are required',
  'draft.local_path_required': 'localPath is required',
  'draft.local_corpus.path_required': 'Local corpus reference missing localPath',
  'draft.local_corpus.invalid_path': 'Invalid local corpus path',
  'draft.local_corpus.file_not_allowed': 'Single-file local corpus not allowed',
  'plan.cancelled': 'Plan generation cancelled',
  'plan.sandbox_timeout': 'Plan sandbox task timed out',
  'plan.sandbox_cleanup_failed':
    'Sandbox process exited abnormally. Fully quit the app and restart, then retry plan generation.',
  'wizard.invalid_phase':
    'Current wizard phase {current} does not allow this action (allowed: {expected})',
  'wizard.already_in_phase': 'Already in wizard phase {phase}',
  'wizard.rollback_not_allowed': 'Cannot roll back to the requested phase',
  'wizard.tool_not_allowed': 'Tool {toolName} is not allowed in the current phase'
}

export const TURN_ERROR_SCHEMA_VERSION = 1 as const

export function isTurnErrorCode(code: string): code is TurnErrorCode {
  return Object.prototype.hasOwnProperty.call(TURN_ERROR_DEFAULT_MESSAGES, code)
}
