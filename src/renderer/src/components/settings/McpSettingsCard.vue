<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  AgentCoreOption,
  CliMcpConfigFragment,
  McpSettingsConstraints,
  UserMcpRoleKey,
  UserMcpSettings
} from '@renderer/api/settings'

const props = defineProps<{
  draft: UserMcpSettings
  cores: AgentCoreOption[]
  constraints: McpSettingsConstraints
  disabled?: boolean
}>()

const emit = defineEmits<{
  update: [settings: UserMcpSettings]
}>()

const { t } = useI18n()

const activeRole = ref<UserMcpRoleKey>('conversation')
const parseErrors = ref<Record<string, string>>({})

const roles = computed(() => [
  { key: 'conversation' as const, label: t('workspace.settings.mcp.roles.conversation') },
  { key: 'task' as const, label: t('workspace.settings.mcp.roles.task') },
  { key: 'verification' as const, label: t('workspace.settings.mcp.roles.verification') }
])

const coreCodes = computed(() => props.cores.map((core) => core.code))

function coreLabel(code: string): string {
  return props.cores.find((core) => core.code === code)?.label ?? code
}

function rootKey(code: string): string {
  return props.constraints.rootKeys[code] ?? 'mcp'
}

function editorKey(role: UserMcpRoleKey, code: string): string {
  return `${role}:${code}`
}

function fragmentText(role: UserMcpRoleKey, code: string): string {
  const fragment = props.draft[role]?.[code]
  return JSON.stringify(fragment ?? { [rootKey(code)]: {} }, null, 2)
}

function updateFragment(role: UserMcpRoleKey, code: string, raw: string): void {
  const key = editorKey(role, code)
  try {
    const parsed = JSON.parse(raw) as CliMcpConfigFragment
    parseErrors.value = { ...parseErrors.value, [key]: '' }
    emit('update', {
      ...props.draft,
      [role]: {
        ...props.draft[role],
        [code]: parsed
      }
    })
  } catch (error) {
    parseErrors.value = {
      ...parseErrors.value,
      [key]: error instanceof Error ? error.message : t('workspace.settings.mcp.invalidJson')
    }
  }
}

function resetFragment(role: UserMcpRoleKey, code: string): void {
  const key = rootKey(code)
  updateFragment(role, code, JSON.stringify({ [key]: {} }, null, 2))
}
</script>

<template>
  <div class="space-y-6">
    <p class="text-sm text-muted-foreground">
      {{ t('workspace.settings.mcp.mergeHint') }}
    </p>

    <div class="flex flex-wrap gap-2">
      <button
        v-for="role in roles"
        :key="role.key"
        type="button"
        class="rounded-md px-3 py-1.5 text-sm transition-colors"
        :class="
          activeRole === role.key
            ? 'bg-muted font-medium text-foreground'
            : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
        "
        @click="activeRole = role.key"
      >
        {{ role.label }}
      </button>
    </div>

    <div class="space-y-4">
      <div
        v-for="code in coreCodes"
        :key="`${activeRole}-${code}`"
        class="rounded-lg border border-border p-4"
      >
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 class="text-sm font-medium">{{ coreLabel(code) }}</h3>
            <p class="text-xs text-muted-foreground">
              {{ t('workspace.settings.mcp.rootKey', { key: rootKey(code) }) }}
            </p>
          </div>
          <button
            type="button"
            class="text-xs text-muted-foreground hover:text-foreground"
            :disabled="disabled"
            @click="resetFragment(activeRole, code)"
          >
            {{ t('workspace.settings.mcp.resetCli') }}
          </button>
        </div>

        <textarea
          class="min-h-36 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-5"
          :value="fragmentText(activeRole, code)"
          :disabled="disabled"
          spellcheck="false"
          @input="updateFragment(activeRole, code, ($event.target as HTMLTextAreaElement).value)"
        />

        <p v-if="parseErrors[editorKey(activeRole, code)]" class="mt-2 text-xs text-destructive">
          {{ parseErrors[editorKey(activeRole, code)] }}
        </p>
      </div>
    </div>

    <div
      class="rounded-lg border border-dashed border-border bg-muted/20 p-4 text-xs text-muted-foreground"
    >
      <p class="mb-2 font-medium text-foreground">
        {{ t('workspace.settings.mcp.constraintsTitle') }}
      </p>
      <p class="mb-1">{{ t('workspace.settings.mcp.reservedNames') }}</p>
      <p class="mb-3 font-mono">{{ constraints.reservedServerNames.join(', ') }}</p>
      <p class="mb-1">{{ t('workspace.settings.mcp.rootKeys') }}</p>
      <ul class="space-y-1 font-mono">
        <li v-for="code in coreCodes" :key="`root-${code}`">{{ code }}: "{{ rootKey(code) }}"</li>
      </ul>
    </div>
  </div>
</template>
