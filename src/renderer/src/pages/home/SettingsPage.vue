<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  fetchControlPlaneSettings,
  fetchMcpSettings,
  fetchPromptSettings,
  updateControlPlanePolicies,
  updateMcpSettings,
  updatePromptSettings,
  type ControlPlanePolicies,
  type ControlPlaneSettingsPayload,
  type PromptSettings,
  type McpSettingsConstraints,
  type UserMcpSettings
} from '@renderer/api/settings'
import { fetchSandboxHealth, type SandboxHealthReport } from '@renderer/api/system'
import ControlPlaneCoresCard from '@renderer/components/settings/ControlPlaneCoresCard.vue'
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

type SettingsSection = 'language' | 'sandbox' | 'control-plane' | 'mcp' | 'prompts'

const { t } = useI18n()

const section = ref<SettingsSection>('language')
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const saveError = ref<string | null>(null)

const controlPlane = ref<ControlPlaneSettingsPayload | null>(null)
const controlPlaneDraft = ref<ControlPlanePolicies | null>(null)
const promptDraft = ref<PromptSettings | null>(null)
const promptDefaults = ref<PromptSettings | null>(null)
const mcpDraft = ref<UserMcpSettings | null>(null)
const mcpConstraints = ref<McpSettingsConstraints | null>(null)
const sandboxHealth = ref<SandboxHealthReport | null>(null)
const sandboxHealthLoading = ref(false)

const sections = [
  { key: 'language' as const, labelKey: 'workspace.settings.sections.language' },
  { key: 'sandbox' as const, labelKey: 'workspace.settings.sections.sandbox' },
  { key: 'control-plane' as const, labelKey: 'workspace.settings.sections.controlPlane' },
  { key: 'mcp' as const, labelKey: 'workspace.settings.sections.mcp' },
  { key: 'prompts' as const, labelKey: 'workspace.settings.sections.prompts' }
]

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
    const [controlRes, promptRes, mcpRes] = await Promise.all([
      fetchControlPlaneSettings(),
      fetchPromptSettings(),
      fetchMcpSettings()
    ])
    controlPlane.value = controlRes.data
    controlPlaneDraft.value = structuredClone(controlRes.data.policies)
    promptDraft.value = structuredClone(promptRes.data.settings)
    promptDefaults.value = promptRes.data.defaults
    mcpDraft.value = structuredClone(mcpRes.data.settings)
    mcpConstraints.value = mcpRes.data.constraints
  } catch (err) {
    error.value = err instanceof Error ? err.message : t('workspace.settings.loadFailed')
    controlPlane.value = null
    controlPlaneDraft.value = null
    promptDraft.value = null
    promptDefaults.value = null
    mcpDraft.value = null
    mcpConstraints.value = null
  } finally {
    loading.value = false
  }
}

function updateControlPlaneDraft(patch: Partial<ControlPlanePolicies>): void {
  if (!controlPlaneDraft.value) return
  controlPlaneDraft.value = { ...controlPlaneDraft.value, ...patch }
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

async function saveControlPlane(): Promise<void> {
  if (!controlPlaneDraft.value) return
  saving.value = true
  saveError.value = null
  try {
    const res = await updateControlPlanePolicies({
      plannerCoreCode: controlPlaneDraft.value.plannerCoreCode,
      sliceVerifierCoreCode: controlPlaneDraft.value.sliceVerifierCoreCode,
      milestoneVerifierCoreCode: controlPlaneDraft.value.milestoneVerifierCoreCode
    })
    controlPlaneDraft.value = structuredClone(res.data.policies)
    if (controlPlane.value) {
      controlPlane.value = { ...controlPlane.value, policies: res.data.policies }
    }
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : t('workspace.settings.saveFailed')
  } finally {
    saving.value = false
  }
}

async function savePrompts(): Promise<void> {
  if (!promptDraft.value) return
  saving.value = true
  saveError.value = null
  try {
    const res = await updatePromptSettings(promptDraft.value)
    promptDraft.value = structuredClone(res.data.settings)
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : t('workspace.settings.saveFailed')
  } finally {
    saving.value = false
  }
}

async function saveMcp(): Promise<void> {
  if (!mcpDraft.value) return
  saving.value = true
  saveError.value = null
  try {
    const res = await updateMcpSettings(mcpDraft.value)
    mcpDraft.value = structuredClone(res.data.settings)
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : t('workspace.settings.saveFailed')
  } finally {
    saving.value = false
  }
}

async function handleSave(): Promise<void> {
  if (section.value === 'control-plane') {
    await saveControlPlane()
  } else if (section.value === 'mcp') {
    await saveMcp()
  } else if (section.value === 'prompts') {
    await savePrompts()
  }
}

onMounted(() => {
  void loadSettings()
  void loadSandboxHealth()
})
</script>

<template>
  <div class="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
    <aside class="w-56 shrink-0 border-r border-border p-3">
      <p class="px-2 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground">
        {{ t('workspace.settings.sidebar') }}
      </p>
      <div class="space-y-1">
        <button
          v-for="item in sections"
          :key="item.key"
          type="button"
          class="flex h-9 w-full items-center rounded-md px-2.5 text-sm transition-colors"
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
      <header class="flex h-12 shrink-0 items-center border-b border-border px-6">
        <h1 class="text-sm font-medium">{{ t('workspace.settings.title') }}</h1>
      </header>

      <div class="p-6">
        <div class="mx-auto flex max-w-4xl flex-col gap-6">
          <div v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner class="size-4" />
            {{ t('workspace.settings.loading') }}
          </div>

          <ErrorAlert v-if="error" :message="error" />
          <ErrorAlert v-if="saveError" :message="saveError" />

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

          <Card v-if="!loading && section === 'control-plane' && controlPlaneDraft && controlPlane">
            <CardHeader class="pb-3">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle class="text-lg">
                    {{ t('workspace.settings.controlPlane.title') }}
                  </CardTitle>
                  <p class="mt-1 text-sm text-muted-foreground">
                    {{ t('workspace.settings.controlPlane.description') }}
                  </p>
                </div>
                <Button size="sm" :disabled="saving" @click="handleSave">
                  {{ saving ? t('workspace.settings.saving') : t('workspace.settings.save') }}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <ControlPlaneCoresCard
                :draft="controlPlaneDraft"
                :cores="controlPlane.cores"
                :disabled="saving"
                @update="updateControlPlaneDraft"
              />
            </CardContent>
          </Card>

          <Card v-if="!loading && section === 'mcp' && mcpDraft && mcpConstraints && controlPlane">
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
                :cores="controlPlane.cores"
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
