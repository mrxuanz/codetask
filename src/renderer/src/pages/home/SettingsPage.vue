<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchAgentDefaults,
  fetchMcpSettings,
  fetchPromptSettings,
  fetchProviderCatalog,
  fetchProviderSettings,
  fetchSecrets,
  updateAgentDefaults,
  updateMcpSettings,
  updatePromptSettings,
  updateProviderSettings,
  putSecret,
  deleteSecret,
  type AgentCoreOption,
  type AgentDefaultsSettings,
  type AgentMcpSettings,
  type AgentPromptSettings,
  type McpSettingsConstraints,
  type ProviderSettingsPayload,
  type SecretMeta
} from '@renderer/api/settings'
import { useRealtimeGateway } from '@renderer/composables/useRealtimeGateway'
import { SETTINGS_SELF_TOPIC } from '@codetask/contracts'
import { fetchSandboxHealth, type SandboxHealthReport } from '@renderer/api/system'
import McpSettingsCard from '@renderer/components/settings/McpSettingsCard.vue'
import AgentDefaultsCard from '@renderer/components/settings/AgentDefaultsCard.vue'
import SandboxHealthCard from '@renderer/components/settings/SandboxHealthCard.vue'
import LanguageSwitcher from '@renderer/components/LanguageSwitcher.vue'
import PromptEditor from '@renderer/components/settings/PromptEditor.vue'
import Button from '@renderer/components/ui/Button.vue'
import Card from '@renderer/components/ui/Card.vue'
import CardContent from '@renderer/components/ui/CardContent.vue'
import CardHeader from '@renderer/components/ui/CardHeader.vue'
import CardTitle from '@renderer/components/ui/CardTitle.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Input from '@renderer/components/ui/Input.vue'
import Label from '@renderer/components/ui/Label.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { toast, toastError } from '@renderer/lib/toast'
import { fetchStorageStats, type StorageStatsData } from '@renderer/api/storage'

type SettingsSection =
  | 'language'
  | 'storage'
  | 'sandbox'
  | 'agents'
  | 'providers'
  | 'secrets'
  | 'mcp'
  | 'prompts'

const { t } = useI18n()
const realtime = useRealtimeGateway()
let settingsHubRelease: (() => void) | null = null

const section = ref<SettingsSection>('language')
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

const cores = ref<AgentCoreOption[]>([])
const agentDefaultsDraft = ref<AgentDefaultsSettings | null>(null)
const agentDefaultsRevision = ref(0)
const promptDraft = ref<AgentPromptSettings | null>(null)
const promptDefaults = ref<AgentPromptSettings | null>(null)
const promptRevision = ref(0)
const mcpDraft = ref<AgentMcpSettings | null>(null)
const mcpConstraints = ref<McpSettingsConstraints | null>(null)
const mcpRevision = ref(0)
const providerPayload = ref<ProviderSettingsPayload | null>(null)
const providerDraft = ref<ProviderSettingsPayload['saved']['providers'] | null>(null)
const sandboxHealth = ref<SandboxHealthReport | null>(null)
const sandboxHealthLoading = ref(false)
const storageStats = ref<StorageStatsData | null>(null)
const storageLoading = ref(false)
const secretsList = ref<SecretMeta[]>([])
const secretNameDraft = ref('')
const secretValueDraft = ref('')
const secretsLoading = ref(false)

const sections = [
  { key: 'language' as const, labelKey: 'workspace.settings.sections.language' },
  { key: 'storage' as const, labelKey: 'workspace.settings.sections.storage' },
  { key: 'sandbox' as const, labelKey: 'workspace.settings.sections.sandbox' },
  { key: 'agents' as const, labelKey: 'workspace.settings.sections.agents' },
  { key: 'providers' as const, labelKey: 'workspace.settings.sections.providers' },
  { key: 'secrets' as const, labelKey: 'workspace.settings.sections.secrets' },
  { key: 'mcp' as const, labelKey: 'workspace.settings.sections.mcp' },
  { key: 'prompts' as const, labelKey: 'workspace.settings.sections.prompts' }
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0]
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024
    unit = units[index]
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`
}

async function loadStorage(): Promise<void> {
  storageLoading.value = true
  try {
    storageStats.value = (await fetchStorageStats()).data
  } catch (err) {
    toastError(err, t('workspace.settings.storage.loadFailed'))
  } finally {
    storageLoading.value = false
  }
}

async function loadSandboxHealth(): Promise<void> {
  sandboxHealthLoading.value = true
  try {
    const res = await fetchSandboxHealth()
    sandboxHealth.value = res.data
  } catch {
    sandboxHealth.value = null
  } finally {
    sandboxHealthLoading.value = false
  }
}

async function loadSecrets(): Promise<void> {
  secretsLoading.value = true
  try {
    const res = await fetchSecrets()
    secretsList.value = res.data.secrets
  } catch (err) {
    toastError(err, t('workspace.settings.secrets.loadFailed'))
    secretsList.value = []
  } finally {
    secretsLoading.value = false
  }
}

async function loadSettings(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const [coresRes, agentRes, promptRes, mcpRes, providersRes, secretsRes] = await Promise.all([
      fetchProviderCatalog(),
      fetchAgentDefaults(),
      fetchPromptSettings(),
      fetchMcpSettings(),
      fetchProviderSettings(),
      fetchSecrets()
    ])
    cores.value = coresRes.data.providers
    agentDefaultsDraft.value = structuredClone(agentRes.data.settings)
    agentDefaultsRevision.value = agentRes.data.revision
    promptDraft.value = structuredClone(promptRes.data.settings)
    promptDefaults.value = promptRes.data.defaults
    promptRevision.value = promptRes.data.revision
    mcpDraft.value = structuredClone(mcpRes.data.settings)
    mcpConstraints.value = mcpRes.data.constraints
    mcpRevision.value = mcpRes.data.revision
    providerPayload.value = providersRes.data
    providerDraft.value = structuredClone(providersRes.data.saved.providers)
    secretsList.value = secretsRes.data.secrets
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.settings.loadFailed')
    cores.value = []
    agentDefaultsDraft.value = null
    promptDraft.value = null
    promptDefaults.value = null
    mcpDraft.value = null
    mcpConstraints.value = null
    providerPayload.value = null
    providerDraft.value = null
    secretsList.value = []
  } finally {
    loading.value = false
  }
}

function updatePromptEntry<K extends keyof AgentPromptSettings>(
  key: K,
  patch: Partial<AgentPromptSettings[K]>
): void {
  if (!promptDraft.value) return
  promptDraft.value = {
    ...promptDraft.value,
    [key]: { ...promptDraft.value[key], ...patch }
  }
}

async function saveAgentDefaults(): Promise<void> {
  if (!agentDefaultsDraft.value) return
  saving.value = true
  try {
    const res = await updateAgentDefaults(agentDefaultsDraft.value, agentDefaultsRevision.value)
    agentDefaultsDraft.value = structuredClone(res.data.settings)
    agentDefaultsRevision.value = res.data.revision
    toast.success(t('workspace.settings.saveSuccess'))
  } catch (err) {
    toastError(err, t('workspace.settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function savePrompts(): Promise<void> {
  if (!promptDraft.value) return
  saving.value = true
  try {
    const res = await updatePromptSettings(promptDraft.value, promptRevision.value)
    promptDraft.value = structuredClone(res.data.settings)
    promptRevision.value = res.data.revision
    toast.success(t('workspace.settings.saveSuccess'))
  } catch (err) {
    toastError(err, t('workspace.settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function saveMcp(): Promise<void> {
  if (!mcpDraft.value) return
  saving.value = true
  try {
    const res = await updateMcpSettings(mcpDraft.value, mcpRevision.value)
    mcpDraft.value = structuredClone(res.data.settings)
    mcpRevision.value = res.data.revision
    toast.success(t('workspace.settings.saveSuccess'))
  } catch (err) {
    toastError(err, t('workspace.settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function saveProviders(): Promise<void> {
  if (!providerDraft.value || !providerPayload.value) return
  saving.value = true
  try {
    const res = await updateProviderSettings(providerDraft.value, providerPayload.value.revision)
    providerPayload.value = {
      ...providerPayload.value,
      saved: res.data.settings,
      revision: res.data.revision,
      restartRequired: res.data.restartRequired
    }
    providerDraft.value = structuredClone(res.data.settings.providers)
    toast.success(t('workspace.settings.saveSuccess'))
  } catch (err) {
    toastError(err, t('workspace.settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function saveSecret(): Promise<void> {
  const name = secretNameDraft.value.trim()
  const value = secretValueDraft.value
  if (!name || !value) return
  saving.value = true
  secretsLoading.value = true
  try {
    await putSecret(name, value)
    await loadSecrets()
    secretNameDraft.value = ''
    secretValueDraft.value = ''
    toast.success(t('workspace.settings.secrets.saveSuccess'))
  } catch (err) {
    toastError(err, t('workspace.settings.secrets.saveFailed'))
  } finally {
    saving.value = false
    secretsLoading.value = false
  }
}

async function removeSecret(name: string): Promise<void> {
  if (!window.confirm(t('workspace.settings.secrets.deleteConfirm', { name }))) return
  secretsLoading.value = true
  try {
    await deleteSecret(name)
    await loadSecrets()
  } catch (err) {
    toastError(err, t('workspace.settings.secrets.deleteFailed'))
  } finally {
    secretsLoading.value = false
  }
}

async function handleSave(): Promise<void> {
  if (section.value === 'agents') {
    await saveAgentDefaults()
  } else if (section.value === 'providers') {
    await saveProviders()
  } else if (section.value === 'secrets') {
    await saveSecret()
  } else if (section.value === 'mcp') {
    await saveMcp()
  } else if (section.value === 'prompts') {
    await savePrompts()
  }
}

onMounted(() => {
  void loadSettings()
  void loadSandboxHealth()
  void loadStorage()
  settingsHubRelease = realtime.watchTopic(SETTINGS_SELF_TOPIC, (envelope) => {
    if (envelope.type !== 'settings.changed') return
    // HTTP reload — event payload is minimal (no secrets / full config).
    // Do not clobber in-flight local edits blindly: reload refreshes revision baselines.
    void loadSettings()
  })
})

onUnmounted(() => {
  settingsHubRelease?.()
  settingsHubRelease = null
})
</script>

<template>
  <div
    class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background lg:flex-row"
  >
    <aside
      class="w-full shrink-0 border-b border-border p-2 lg:w-48 lg:border-r lg:border-b-0 lg:p-3 xl:w-56"
    >
      <p class="px-2 py-1 text-[11px] font-semibold tracking-wide text-muted-foreground lg:py-2">
        {{ t('workspace.settings.sidebar') }}
      </p>
      <div
        class="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-1 lg:overflow-visible lg:pb-0"
      >
        <button
          v-for="item in sections"
          :key="item.key"
          type="button"
          class="flex h-9 w-auto shrink-0 items-center rounded-md px-2.5 text-sm transition-colors lg:w-full"
          :class="
            section === item.key
              ? 'bg-muted font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'
          "
          @click="section = item.key"
        >
          {{ t(item.labelKey) }}
        </button>
      </div>
    </aside>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <header class="flex h-12 shrink-0 items-center border-b border-border px-4 sm:px-6">
        <h1 class="text-sm font-medium">{{ t('workspace.settings.title') }}</h1>
      </header>

      <div class="p-3 sm:p-5 lg:p-6">
        <div class="mx-auto flex max-w-4xl flex-col gap-6">
          <div v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner class="size-4" />
            {{ t('workspace.settings.loading') }}
          </div>

          <ErrorAlert v-if="error" :message="error" />

          <Card v-if="!loading && section === 'language'">
            <CardHeader class="pb-3">
              <CardTitle class="text-lg">{{
                t('workspace.settings.languageSection.title')
              }}</CardTitle>
              <p class="mt-1 text-sm text-muted-foreground">
                {{ t('workspace.settings.languageSection.description') }}
              </p>
            </CardHeader>
            <CardContent>
              <LanguageSwitcher />
            </CardContent>
          </Card>

          <Card v-if="section === 'storage'">
            <CardHeader class="pb-3">
              <CardTitle class="text-lg">{{ t('workspace.settings.storage.title') }}</CardTitle>
              <p class="mt-1 text-sm text-muted-foreground">
                {{ t('workspace.settings.storage.description') }}
              </p>
            </CardHeader>
            <CardContent class="space-y-5">
              <div
                v-if="storageLoading && !storageStats"
                class="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Spinner class="size-4" />
                {{ t('workspace.settings.storage.loading') }}
              </div>
              <template v-if="storageStats">
                <div>
                  <p class="text-xs font-medium text-muted-foreground">
                    {{ t('workspace.settings.storage.currentPath') }}
                  </p>
                  <p class="mt-1 break-all font-mono text-sm">{{ storageStats.dataDir }}</p>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ t('workspace.settings.storage.source', { source: storageStats.source }) }}
                  </p>
                </div>
                <div class="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                  <div class="rounded-md border p-3">
                    <p class="text-muted-foreground">{{ t('workspace.settings.storage.total') }}</p>
                    <p class="mt-1 font-medium">{{ formatBytes(storageStats.bytes.total) }}</p>
                  </div>
                  <div class="rounded-md border p-3">
                    <p class="text-muted-foreground">DB + WAL</p>
                    <p class="mt-1 font-medium">
                      {{ formatBytes(storageStats.bytes.database + storageStats.bytes.wal) }}
                    </p>
                  </div>
                  <div class="rounded-md border p-3">
                    <p class="text-muted-foreground">Attachments</p>
                    <p class="mt-1 font-medium">
                      {{ formatBytes(storageStats.bytes.attachments) }}
                    </p>
                  </div>
                  <div class="rounded-md border p-3">
                    <p class="text-muted-foreground">Artifact</p>
                    <p class="mt-1 font-medium">{{ formatBytes(storageStats.bytes.artifacts) }}</p>
                  </div>
                  <div class="rounded-md border p-3">
                    <p class="text-muted-foreground">
                      {{ t('workspace.settings.storage.reclaimable') }}
                    </p>
                    <p class="mt-1 font-medium">
                      {{ formatBytes(storageStats.sqlite.reclaimableBytes) }}
                    </p>
                  </div>
                </div>
              </template>
            </CardContent>
          </Card>

          <Card v-if="section === 'sandbox'">
            <CardHeader class="pb-3">
              <CardTitle class="text-lg">{{ t('workspace.settings.sandbox.title') }}</CardTitle>
              <p class="mt-1 text-sm text-muted-foreground">
                {{ t('workspace.settings.sandbox.description') }}
              </p>
            </CardHeader>
            <CardContent>
              <SandboxHealthCard :report="sandboxHealth" :loading="sandboxHealthLoading" />
            </CardContent>
          </Card>

          <Card v-if="!loading && section === 'agents' && agentDefaultsDraft">
            <CardHeader class="pb-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle class="text-lg">{{ t('workspace.settings.agents.title') }}</CardTitle>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ t('workspace.settings.agents.description') }}
                  </p>
                </div>
                <Button size="sm" :disabled="saving" @click="handleSave">
                  {{ saving ? t('workspace.settings.saving') : t('workspace.settings.save') }}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <AgentDefaultsCard
                :draft="agentDefaultsDraft"
                :cores="cores"
                :disabled="saving"
                @update="agentDefaultsDraft = { ...agentDefaultsDraft!, ...$event }"
              />
            </CardContent>
          </Card>

          <Card v-if="!loading && section === 'providers' && providerDraft && providerPayload">
            <CardHeader class="pb-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle class="text-lg">{{
                    t('workspace.settings.providers.title')
                  }}</CardTitle>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ t('workspace.settings.providers.description') }}
                  </p>
                </div>
                <Button size="sm" :disabled="saving" @click="handleSave">
                  {{ saving ? t('workspace.settings.saving') : t('workspace.settings.save') }}
                </Button>
              </div>
            </CardHeader>
            <CardContent class="space-y-4">
              <p
                v-if="providerPayload.restartRequired"
                class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100"
              >
                {{ t('workspace.settings.providers.restartRequired') }}
              </p>
              <textarea
                class="min-h-48 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
                :value="JSON.stringify(providerDraft, null, 2)"
                :disabled="saving"
                spellcheck="false"
                @change="
                  (() => {
                    try {
                      providerDraft = JSON.parse(
                        ($event.target as HTMLTextAreaElement).value
                      ) as typeof providerDraft
                    } catch {
                      /* keep previous draft on invalid JSON */
                    }
                  })()
                "
              />
            </CardContent>
          </Card>

          <Card v-if="!loading && section === 'secrets'">
            <CardHeader class="pb-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle class="text-lg">{{ t('workspace.settings.secrets.title') }}</CardTitle>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ t('workspace.settings.secrets.description') }}
                  </p>
                </div>
                <Button
                  size="sm"
                  :disabled="saving || !secretNameDraft.trim() || !secretValueDraft"
                  @click="handleSave"
                >
                  {{ saving ? t('workspace.settings.saving') : t('workspace.settings.save') }}
                </Button>
              </div>
            </CardHeader>
            <CardContent class="space-y-5">
              <div
                v-if="secretsLoading && secretsList.length === 0"
                class="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Spinner class="size-4" />
                {{ t('workspace.settings.loading') }}
              </div>

              <div v-if="secretsList.length === 0 && !secretsLoading" class="text-sm text-muted-foreground">
                {{ t('workspace.settings.secrets.empty') }}
              </div>

              <ul v-if="secretsList.length > 0" class="divide-y rounded-md border">
                <li
                  v-for="secret in secretsList"
                  :key="secret.name"
                  class="flex items-center justify-between gap-3 px-3 py-2.5"
                >
                  <div class="min-w-0">
                    <p class="truncate font-mono text-sm">{{ secret.name }}</p>
                    <p v-if="secret.configured" class="text-xs text-muted-foreground">
                      {{ t('workspace.settings.secrets.configured') }}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    :disabled="secretsLoading"
                    @click="removeSecret(secret.name)"
                  >
                    {{ t('workspace.settings.secrets.delete') }}
                  </Button>
                </li>
              </ul>

              <div class="space-y-3 rounded-md border p-4">
                <p class="text-sm font-medium">{{ t('workspace.settings.secrets.add') }}</p>
                <div class="grid gap-3 sm:grid-cols-2">
                  <div class="space-y-2">
                    <Label for="secret-name">{{ t('workspace.settings.secrets.name') }}</Label>
                    <Input
                      id="secret-name"
                      v-model="secretNameDraft"
                      :disabled="saving"
                      autocomplete="off"
                    />
                  </div>
                  <div class="space-y-2">
                    <Label for="secret-value">{{ t('workspace.settings.secrets.value') }}</Label>
                    <Input
                      id="secret-value"
                      v-model="secretValueDraft"
                      type="password"
                      :disabled="saving"
                      autocomplete="new-password"
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card v-if="!loading && section === 'mcp' && mcpDraft && mcpConstraints">
            <CardHeader class="pb-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle class="text-lg">{{ t('workspace.settings.mcp.title') }}</CardTitle>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ t('workspace.settings.mcp.description') }}
                  </p>
                </div>
                <Button size="sm" :disabled="saving" @click="handleSave">
                  {{ saving ? t('workspace.settings.saving') : t('workspace.settings.save') }}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <McpSettingsCard
                :draft="mcpDraft"
                :cores="cores"
                :constraints="mcpConstraints"
                :disabled="saving"
                @update="mcpDraft = $event"
              />
            </CardContent>
          </Card>

          <Card v-if="!loading && section === 'prompts' && promptDraft && promptDefaults">
            <CardHeader class="pb-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle class="text-lg">{{ t('workspace.settings.prompts.title') }}</CardTitle>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ t('workspace.settings.prompts.description') }}
                  </p>
                </div>
                <Button size="sm" :disabled="saving" @click="handleSave">
                  {{ saving ? t('workspace.settings.saving') : t('workspace.settings.save') }}
                </Button>
              </div>
            </CardHeader>

            <CardContent class="space-y-4">
              <PromptEditor
                :title="t('workspace.settings.prompts.conversation')"
                :entry="promptDraft.conversation"
                :default-body="promptDefaults.conversation.body"
                :disabled="saving"
                @update:entry="updatePromptEntry('conversation', $event)"
              />
              <PromptEditor
                :title="t('workspace.settings.prompts.planner')"
                :entry="promptDraft.planner"
                :default-body="promptDefaults.planner.body"
                :disabled="saving"
                @update:entry="updatePromptEntry('planner', $event)"
              />
              <PromptEditor
                :title="t('workspace.settings.prompts.sliceVerifier')"
                :entry="promptDraft.sliceVerifier"
                :default-body="promptDefaults.sliceVerifier.body"
                :disabled="saving"
                @update:entry="updatePromptEntry('sliceVerifier', $event)"
              />
              <PromptEditor
                :title="t('workspace.settings.prompts.milestoneVerifier')"
                :entry="promptDraft.milestoneVerifier"
                :default-body="promptDefaults.milestoneVerifier.body"
                :disabled="saving"
                @update:entry="updatePromptEntry('milestoneVerifier', $event)"
              />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  </div>
</template>
