const REGISTER_PLAN_TOOL_JSON = `{
  "name": "register_plan",
  "description": "Register the final structured execution plan through MCP. Call after all task contexts are registered. Do not include verificationCommand or verificationPolicy on slices.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "milestones": {
        "type": "array",
        "description": "Ordered milestone list. Each milestone contains slices; each slice contains tasks.",
        "items": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "description": { "type": "string" },
            "successCriteria": {
              "type": "string",
              "description": "Detailed success criteria for this milestone. Describe observable outcomes, key files, and how to tell the milestone is done. Not runnable commands."
            },
            "slices": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "title": { "type": "string" },
                  "description": { "type": "string" },
                  "successCriteria": {
                    "type": "string",
                    "description": "Detailed success criteria for this slice: expected outcomes, key files/paths, and completion signals."
                  },
                  "dependsOnSliceRefs": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Canonical slice refs that must complete first, e.g. m1-s1."
                  },
                  "tasks": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "title": { "type": "string" },
                        "description": { "type": "string" },
                        "taskKind": {
                          "type": "string",
                          "enum": [
                            "project-setup",
                            "dependency-management",
                            "scaffolding",
                            "backend-implementation",
                            "frontend-implementation",
                            "data-modeling",
                            "testing-validation",
                            "documentation-handoff",
                            "general-implementation"
                          ]
                        },
                        "abilityCode": { "type": "string" },
                        "referenceIds": {
                          "type": "array",
                          "items": { "type": "string" },
                          "description": "Exact frozen draft reference ids this task should use. Use only ids present in the Frozen Draft References list. If no frozen draft reference ids are listed, omit this field or use []. Never use draftId, bigTaskId, sourceMessageId, task ids, message ids, file paths, artifact ids, or task refs here."
                        },
                        "referenceReason": {
                          "type": "string",
                          "description": "Why these references are relevant for this task."
                        },
                        "dependsOnTaskRefs": {
                          "type": "array",
                          "items": { "type": "string" },
                          "description": "Canonical task refs, e.g. m1-s1-t1."
                        },
                        "requiredInputs": {
                          "type": "array",
                          "items": { "type": "string" }
                        },
                        "successCriteria": {
                          "type": "string",
                          "description": "Task-level success criteria. When omitted, inherits the slice success criteria."
                        },
                        "canRunInParallel": { "type": "boolean" }
                      },
                      "required": ["title", "description", "taskKind", "abilityCode"]
                    }
                  }
                },
                "required": ["title", "description", "successCriteria", "tasks"]
              }
            }
          },
          "required": ["title", "description", "successCriteria", "slices"]
        }
      }
    },
    "required": ["milestones"],
    "additionalProperties": false
  }
}`

export function registerTaskContextToolDefinition(): Record<string, unknown> {
  return {
    name: 'register_task_context',
    description:
      'Register the self-contained execution context for one planned task. Supply 1-based milestone/slice/task indices, the exact taskTitle you will use in register_plan, and a detailed content string.',
    inputSchema: {
      type: 'object',
      properties: {
        milestone: { type: 'integer', minimum: 1 },
        slice: { type: 'integer', minimum: 1 },
        task: { type: 'integer', minimum: 1 },
        taskTitle: { type: 'string', minLength: 1 },
        content: { type: 'string', minLength: 1 }
      },
      required: ['milestone', 'slice', 'task', 'taskTitle', 'content'],
      additionalProperties: false
    }
  }
}

export function updateTaskContextToolDefinition(): Record<string, unknown> {
  return {
    name: 'update_task_context',
    description:
      'Update a previously registered task context during planning. Use the same milestone/slice/task indices and taskTitle as register_task_context.',
    inputSchema: {
      type: 'object',
      properties: {
        milestone: { type: 'integer', minimum: 1 },
        slice: { type: 'integer', minimum: 1 },
        task: { type: 'integer', minimum: 1 },
        taskTitle: { type: 'string', minLength: 1 },
        content: { type: 'string', minLength: 1 }
      },
      required: ['milestone', 'slice', 'task', 'taskTitle', 'content'],
      additionalProperties: false
    }
  }
}

export function registerPlanToolDefinition(): Record<string, unknown> {
  return JSON.parse(REGISTER_PLAN_TOOL_JSON) as Record<string, unknown>
}

export function plannerMcpToolDefinitions(): Record<string, unknown>[] {
  return [
    registerTaskContextToolDefinition(),
    updateTaskContextToolDefinition(),
    registerPlanToolDefinition()
  ]
}
