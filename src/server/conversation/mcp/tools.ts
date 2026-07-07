import { SUPPORTED_CORE_CODES } from '../cores'
import { isWizardPhase, type WizardPhase } from '../../wizard/types'
import { allCreateTaskMcpToolNames, toolsForWizardPhase } from '../../wizard/tools'

export function proposeTaskDraftToolDefinition(): Record<string, unknown> {
  return {
    name: 'propose_task_draft',
    description:
      'Propose a structured task draft after user flow, tech stack, acceptance, and abilities are sufficiently collected. Do not include workspacePath or createDirIfNotExists; CodeTask binds the current thread project folder automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Concise task title (max 50 chars)' },
        summary: { type: 'string', description: '1-2 sentence task overview' },
        userFlow: {
          type: 'string',
          description: 'User journey / functional flow in plain language'
        },
        techStack: { type: 'string', description: 'Brief technical stack' },
        nfr: { type: 'array', items: { type: 'string' } },
        acceptance: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              given: { type: 'string' },
              when: { type: 'string' },
              then: { type: 'string' }
            },
            required: ['id', 'given', 'when', 'then']
          }
        },
        verification: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              appliesTo: { type: 'string', enum: ['all', 'task', 'slice'] }
            },
            required: ['command', 'appliesTo']
          }
        },
        outOfScope: { type: 'array', items: { type: 'string' } },
        assumptions: { type: 'array', items: { type: 'string' } },
        abilities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              abilityCode: { type: 'string' },
              reason: { type: 'string' },
              recommendedCoreCode: { type: 'string', enum: [...SUPPORTED_CORE_CODES] }
            },
            required: ['abilityCode', 'reason', 'recommendedCoreCode']
          }
        }
      },
      required: ['title', 'summary', 'userFlow', 'techStack', 'acceptance', 'abilities']
    }
  }
}

export function conversationMcpToolDefinitions(): Record<string, unknown>[] {
  return [
    {
      name: 'read_reference_attachment',
      description:
        'Read an attachment from the active user message. Use attachmentId from Reference Attachments; for images use the exposed path with Read when available.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', description: 'Attachment ID from the current turn' }
        },
        required: ['attachmentId']
      }
    },
    proposeTaskDraftToolDefinition(),
    {
      name: 'confirm_requirements_contract',
      description:
        'Confirm the REQUIREMENTS CONTRACT for a pending task draft. Must be called after the user explicitly confirms the requirements.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description:
              'The ID of the task-launch-draft message whose requirements contract to confirm'
          }
        },
        required: ['messageId']
      }
    },
    {
      name: 'get_task_draft',
      description:
        'Read the current task draft snapshot (REQUIREMENTS CONTRACT, abilities, references, acceptance, revision). In draft_review: call before revise_requirements_contract or update_task_draft. In plan_edit: read-only context for aligning execution tree edits with the confirmed draft.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string' },
          messageId: { type: 'string' }
        }
      }
    },
    {
      name: 'revise_requirements_contract',
      description:
        'Read-modify-write REQUIREMENTS CONTRACT in one atomic step. Loads the current draft from the server, applies find/replace pairs or a full markdown body, then saves with optimistic revision locking. Prefer this over guessing contract content. When using replacements, structured fields (title, summary, userFlow, techStack) are synced by default.',
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string' },
          messageId: { type: 'string' },
          revision: {
            type: 'number',
            description: 'Required. revision from get_task_draft.'
          },
          replacements: {
            type: 'array',
            description:
              'Sequential find/replace applied to contract markdown (and optionally structured fields).',
            items: {
              type: 'object',
              properties: {
                find: { type: 'string' },
                replace: { type: 'string' }
              },
              required: ['find', 'replace']
            }
          },
          requirementsContractMarkdown: {
            type: 'string',
            description: 'Full contract markdown replacement (alternative to replacements).'
          },
          syncStructuredFields: {
            type: 'boolean',
            description:
              'When using replacements, also apply to title/summary/userFlow/techStack. Default true.'
          }
        },
        required: ['revision']
      }
    },
    {
      name: 'update_task_draft',
      description:
        'Update an editable task draft section. Skips locked/confirmed sections and reports them in skippedLockedSections. When title, summary, userFlow, or techStack change, REQUIREMENTS CONTRACT markdown is regenerated automatically unless you pass requirementsContractMarkdown explicitly. Use draftId or messageId; defaults to active draft in context.',
      inputSchema: {
        type: 'object',
        properties: {
          draftId: { type: 'string' },
          messageId: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          userFlow: { type: 'string' },
          techStack: { type: 'string' },
          requirementsContractMarkdown: { type: 'string' },
          revision: {
            type: 'number',
            description: 'Expected draft revision for optimistic concurrency (optional).'
          }
        }
      }
    },
    {
      name: 'get_execution_plan',
      description:
        'Read the current execution plan snapshot (milestones, slices, tasks, confirmed flags, contextMarkdown, reference assignments). Call this before update_execution_plan_node when you need the latest tree state. Defaults to active plan in context.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          jobId: {
            type: 'string',
            description: 'Plan job id; defaults to active_plan_id from wizard context'
          }
        }
      }
    },
    {
      name: 'update_execution_plan_node',
      description:
        'Update an execution plan node during plan_editing. Call get_execution_plan first for planRevision, node content, and confirmed flags. Requires expectedPlanRevision for design sessions (ds-*). Confirmed nodes cannot be modified. nodeRef examples: m1 (milestone), m1-s1 (slice), m1-s1-t1 (task).',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          nodeRef: {
            type: 'string',
            description: 'Node ref: m1 for milestone, m1-s1 for slice, m1-s1-t1 for task'
          },
          expectedPlanRevision: {
            type: 'number',
            description: 'Required for design sessions — from get_execution_plan.planRevision'
          },
          title: { type: 'string' },
          description: { type: 'string' },
          successCriteria: { type: 'string' },
          contextMarkdown: {
            type: 'string',
            description: 'Task execution context markdown (tasks only)'
          },
          abilityCode: { type: 'string' },
          referenceIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Draft reference ids assigned to this task (tasks only)'
          },
          referenceReason: {
            type: 'string',
            description: 'Planner note for how workers should use assigned references (tasks only)'
          }
        },
        required: ['jobId', 'nodeRef', 'expectedPlanRevision']
      }
    },
    {
      name: 'replace_execution_plan',
      description:
        'Replace the entire execution plan tree during plan_editing. Requires expectedPlanRevision from get_execution_plan. Clears all confirmed flags and invalidates ready_to_launch. Validates structure and referenceIds against the frozen manifest.',
      inputSchema: {
        type: 'object',
        properties: {
          designSessionId: {
            type: 'string',
            description: 'Design session id; defaults to active_plan_id when it is a ds-* id'
          },
          jobId: { type: 'string', description: 'Alias of designSessionId' },
          expectedPlanRevision: {
            type: 'number',
            description: 'Optimistic lock from get_execution_plan'
          },
          milestones: {
            type: 'array',
            description: 'Full milestone → slice → task tree (same shape as register_plan)'
          }
        },
        required: ['expectedPlanRevision', 'milestones']
      }
    },
    {
      name: 'request_plan_regeneration',
      description:
        'Request a full plan regeneration via PlannerRun. Requires expectedPlanRevision. Clears confirmations when the new plan arrives. Use for complex reordering that is easier to replan than patch node-by-node.',
      inputSchema: {
        type: 'object',
        properties: {
          designSessionId: { type: 'string' },
          jobId: { type: 'string' },
          expectedPlanRevision: { type: 'number' },
          instruction: {
            type: 'string',
            description: 'What should change in the regenerated plan'
          }
        },
        required: ['expectedPlanRevision', 'instruction']
      }
    },
    {
      name: 'confirm_draft_section',
      description: 'Lock a draft section after user confirmation.',
      inputSchema: {
        type: 'object',
        properties: {
          messageId: { type: 'string' },
          section: {
            type: 'string',
            enum: [
              'requirementsContract',
              'abilities',
              'references',
              'acceptance',
              'userFlow',
              'techStack'
            ]
          }
        },
        required: ['section']
      }
    },
    {
      name: 'rename_thread',
      description: 'Rename the current conversation thread. Sets manual title source.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title']
      }
    },
    {
      name: 'delete_thread',
      description: 'Delete the current conversation thread.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'request_phase_rollback',
      description:
        'Request an explicit wizard phase rollback when requirements or draft scope must be reworked. Does not mutate artifacts silently.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            enum: ['collect', 'draft_review'],
            description: 'Target wizard phase'
          },
          reason: { type: 'string', description: 'Why rollback is needed' }
        },
        required: ['to', 'reason']
      }
    },
    {
      name: 'list_reference_corpus',
      description: 'List draft reference corpus entries (attachments and local corpus refs).',
      inputSchema: {
        type: 'object',
        properties: {
          designSessionId: { type: 'string', description: 'Optional design session id' }
        }
      }
    },
    {
      name: 'update_reference_corpus_item',
      description: 'Update description (and name for local corpus) of a reference corpus item.',
      inputSchema: {
        type: 'object',
        properties: {
          designSessionId: { type: 'string' },
          referenceId: { type: 'string' },
          description: { type: 'string' },
          name: { type: 'string' }
        },
        required: ['referenceId']
      }
    },
    {
      name: 'remove_reference_corpus_item',
      description: 'Remove a reference corpus item by id.',
      inputSchema: {
        type: 'object',
        properties: {
          designSessionId: { type: 'string' },
          referenceId: { type: 'string' }
        },
        required: ['referenceId']
      }
    }
  ]
}

const TOOL_BY_NAME = new Map(
  conversationMcpToolDefinitions().map((tool) => [tool.name as string, tool])
)

export function conversationMcpToolDefinitionsForPhase(
  phase: WizardPhase | null
): Record<string, unknown>[] {
  const names = isWizardPhase(phase) ? toolsForWizardPhase(phase) : allCreateTaskMcpToolNames()
  return names
    .map((name) => TOOL_BY_NAME.get(name))
    .filter((tool): tool is Record<string, unknown> => Boolean(tool))
}
