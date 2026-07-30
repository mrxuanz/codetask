<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchBusinessSkills,
  fetchMcpSettings,
  fetchPromptSettings,
  updateBusinessSkills,
  updateMcpSettings,
  updatePromptSettings,
  type PromptSettings,
  type McpSettingsConstraints,
  type UserMcpSettings
} from '@renderer/api/settings'
import { fetchConversationCores, type ConversationCore } from '@renderer/api/conversation'
import type { BusinessSkillsSettings } from '@shared/contracts/business-skills'
import { fetchSandboxHealth, type SandboxHealthReport } from '@renderer/api/system'
import BusinessSkillsEditor from '@renderer/components/settings/BusinessSkillsEditor.vue'
import McpSettingsCard from '@renderer/components/settings/McpSettingsCard.vue'
import SandboxHealthCard from '@renderer/components/settings/SandboxHealthCard.vue'
import LanguageSwitcher from '@renderer/components/LanguageSwitcher.vue'
import PromptEditor from '@renderer/components/settings/PromptEditor.vue'
import Button from '@renderer/components/ui/Button.vue'
import Card from '@renderer/components/ui/Card.vue'
import CardContent from '@renderer/components/ui/CardContent.vue'
import CardHeader from '@renderer/components/ui/CardHeader.vue'
import CardTitle from '@renderer/components/ui/CardTitle.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { toast, toastError } from '@renderer/lib/toast'
import { fetchStorageStats, type StorageStatsData } from '@renderer/api/storage'

type SettingsSection = 'language' | 'storage' | 'sandbox' | 'skills' | 'mcp' | 'prompts'

const { t } = useI18n()

const section = ref<SettingsSection>('language')
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

const cores = ref<ConversationCore[]>([])
const businessSkillsDraft = ref<BusinessSkillsSettings | null>(null)
const promptDraft = ref<PromptSettings | null>(null)
const promptDefaults = ref<PromptSettings | null>(null)
const mcpDraft = ref<UserMcpSettings | null>(null)
const mcpConstraints = ref<McpSettingsConstraints | null>(null)
const sandboxHealth = ref<SandboxHealthReport | null>(null)
const sandboxHealthLoading = ref(false)
const storageStats = ref<StorageStatsData | null>(null)
const storageLoading = ref(false)

const sections = [
  { key: 'language' as const, labelKey: 'workspace.settings.sections.language' },
  { key: 'storage' as const, labelKey: 'workspace.settings.sections.storage' },
  { key: 'sandbox' as const, labelKey: 'workspace.settings.sections.sandbox' },
  { key: 'skills' as const, labelKey: 'workspace.settings.sections.skills' },
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

async function loadSettings(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const [coresRes, promptRes, mcpRes, skillsRes] = await Promise.all([
      fetchConversationCores(),
      fetchPromptSettings(),
      fetchMcpSettings(),
      fetchBusinessSkills()
    ])
    cores.value = coresRes.data.cores
    businessSkillsDraft.value = structuredClone(skillsRes.data.settings)
    promptDraft.value = structuredClone(promptRes.data.settings)
    promptDefaults.value = promptRes.data.defaults
    mcpDraft.value = structuredClone(mcpRes.data.settings)
    mcpConstraints.value = mcpRes.data.constraints
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.settings.loadFailed')
    cores.value = []
    businessSkillsDraft.value = null
    promptDraft.value = null
    promptDefaults.value = null
    mcpDraft.value = null
    mcpConstraints.value = null
  } finally {
    loading.value = false
  }
}

function updatePromptEntry<K extends keyof PromptSettings>(
  key: K,
  patch: Partial<PromptSettings[K]>
): void {
  if (!promptDraft.value) return
  promptDraft.value = {
    ...promptDraft.value,
    [key]: { ...promptDraft.value[key], ...patch }
  }
}

async function saveBusinessSkills(): Promise<void> {
  if (!businessSkillsDraft.value) return
  saving.value = true
  try {
    const res = await updateBusinessSkills(businessSkillsDraft.value)
    businessSkillsDraft.value = structuredClone(res.data.settings)
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
    const res = await updatePromptSettings(promptDraft.value)
    promptDraft.value = structuredClone(res.data.settings)
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
    const res = await updateMcpSettings(mcpDraft.value)
    mcpDraft.value = structuredClone(res.data.settings)
    toast.success(t('workspace.settings.saveSuccess'))
  } catch (err) {
    toastError(err, t('workspace.settings.saveFailed'))
  } finally {
    saving.value = false
  }
}

async function handleSave(): Promise<void> {
  if (section.value === 'skills') {
    await saveBusinessSkills()
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
                    <p class="text-muted-foreground">Runtime</p>
                    <p class="mt-1 font-medium">{{ formatBytes(storageStats.bytes.runtimes) }}</p>
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

          <Card v-if="!loading && section === 'skills' && businessSkillsDraft">
            <CardHeader class="pb-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle class="text-lg">
                    {{ t('workspace.settings.skills.title') }}
                  </CardTitle>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ t('workspace.settings.skills.description') }}
                  </p>
                </div>
                <Button size="sm" :disabled="saving" @click="handleSave">
                  {{ saving ? t('workspace.settings.saving') : t('workspace.settings.save') }}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <BusinessSkillsEditor
                :settings="businessSkillsDraft"
                :disabled="saving"
                @update="businessSkillsDraft = $event"
              />
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
