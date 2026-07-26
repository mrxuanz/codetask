<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppHeader from '@renderer/components/AppHeader.vue'
import AccountSecurityCard from '@renderer/components/settings/AccountSecurityCard.vue'
import SandboxHealthCard from '@renderer/components/settings/SandboxHealthCard.vue'
import Button from '@renderer/components/ui/Button.vue'
import Card from '@renderer/components/ui/Card.vue'
import CardContent from '@renderer/components/ui/CardContent.vue'
import CardDescription from '@renderer/components/ui/CardDescription.vue'
import CardHeader from '@renderer/components/ui/CardHeader.vue'
import CardTitle from '@renderer/components/ui/CardTitle.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Input from '@renderer/components/ui/Input.vue'
import Label from '@renderer/components/ui/Label.vue'
import {
  fetchConversationProviderStatus,
  fetchConversationSettings,
  updateConversationSettings,
  type ConversationProviderStatus
} from '@renderer/api/conversation'
import { logout } from '@renderer/api/auth'
import { fetchSandboxHealth, type SandboxHealthReport } from '@renderer/api/system'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import { translateApiError } from '@renderer/i18n/translateApiError'
import { fetchDraftSettings, updateDraftSettings, type DraftSettings } from '@renderer/api/drafts'

const { t } = useI18n()
const router = useRouter()
const { data, refresh } = useBootstrap()
const provider = ref<ConversationProviderStatus | null>(null)
const model = ref('')
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const error = ref<string | null>(null)
const sandbox = ref<SandboxHealthReport | null>(null)
const sandboxLoading = ref(true)
const signingOut = ref(false)
const draftSettings = ref<DraftSettings | null>(null)
const draftModel = ref('')
const plannerPrompt = ref('')
const skillsManual = ref('')
const plannerUseDefault = ref(true)
const skillsUseDefault = ref(true)
const draftSaving = ref(false)
const draftSaved = ref(false)

function reportError(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause)
  error.value = translateApiError(message, t)
}

async function load(): Promise<void> {
  loading.value = true
  sandboxLoading.value = true
  error.value = null
  try {
    const [settingsResult, providerResult, sandboxResult, draftResult] = await Promise.all([
      fetchConversationSettings(),
      fetchConversationProviderStatus(),
      fetchSandboxHealth(),
      fetchDraftSettings()
    ])
    model.value = settingsResult.data.model ?? ''
    provider.value = providerResult.data
    sandbox.value = sandboxResult.data
    draftSettings.value = draftResult.data
    draftModel.value = draftResult.data.model ?? ''
    plannerPrompt.value = draftResult.data.plannerPrompt.value
    skillsManual.value = draftResult.data.skillsManual.value
    plannerUseDefault.value = draftResult.data.plannerPrompt.useDefault
    skillsUseDefault.value = draftResult.data.skillsManual.useDefault
  } catch (cause) {
    reportError(cause)
  } finally {
    loading.value = false
    sandboxLoading.value = false
  }
}

async function saveDraftPlanning(): Promise<void> {
  const current = draftSettings.value
  if (!current) return
  draftSaving.value = true
  draftSaved.value = false
  error.value = null
  try {
    const result = await updateDraftSettings({
      model: draftModel.value.trim() || null,
      plannerPrompt: plannerUseDefault.value ? null : plannerPrompt.value,
      skillsManual: skillsUseDefault.value ? null : skillsManual.value,
      expectedRevision: current.revision
    })
    draftSettings.value = result.data
    draftModel.value = result.data.model ?? ''
    plannerPrompt.value = result.data.plannerPrompt.value
    skillsManual.value = result.data.skillsManual.value
    plannerUseDefault.value = result.data.plannerPrompt.useDefault
    skillsUseDefault.value = result.data.skillsManual.useDefault
    draftSaved.value = true
  } catch (cause) {
    reportError(cause)
  } finally {
    draftSaving.value = false
  }
}

function resetPlannerPrompt(): void {
  if (!draftSettings.value) return
  plannerUseDefault.value = true
  plannerPrompt.value = draftSettings.value.defaults.plannerPrompt
}

function resetSkillsManual(): void {
  if (!draftSettings.value) return
  skillsUseDefault.value = true
  skillsManual.value = draftSettings.value.defaults.skillsManual
}

async function save(): Promise<void> {
  saving.value = true
  saved.value = false
  error.value = null
  try {
    const result = await updateConversationSettings(model.value.trim() || null)
    model.value = result.data.model ?? ''
    saved.value = true
  } catch (cause) {
    reportError(cause)
  } finally {
    saving.value = false
  }
}

async function signOut(): Promise<void> {
  signingOut.value = true
  try {
    await logout()
    await refresh()
    await router.replace('/login')
  } finally {
    signingOut.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <main class="flex h-full min-h-0 flex-col bg-background">
    <AppHeader :username="data?.username" />
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-3xl space-y-5 px-4 py-6 sm:py-8">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 class="text-2xl font-semibold">{{ t('conversation.settings.title') }}</h1>
            <p class="mt-1 text-sm text-muted-foreground">
              {{ t('conversation.settings.description') }}
            </p>
          </div>
          <Button variant="outline" :disabled="signingOut" @click="signOut">
            {{ t('common.logout') }}
          </Button>
        </header>

        <ErrorAlert v-if="error" :message="error" />

        <Card>
          <CardHeader>
            <CardTitle>{{ t('conversation.settings.cursorTitle') }}</CardTitle>
            <CardDescription>{{ t('conversation.settings.cursorDescription') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-5">
            <div v-if="loading" class="py-4 text-sm text-muted-foreground">
              {{ t('common.loading') }}
            </div>
            <template v-else>
              <div class="rounded-lg border border-border p-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p class="font-medium">Cursor CLI</p>
                    <p class="mt-1 text-xs text-muted-foreground">
                      {{ provider?.message }}
                    </p>
                  </div>
                  <span
                    class="rounded-full px-2.5 py-1 text-xs font-medium"
                    :class="
                      provider?.authenticated
                        ? 'bg-emerald-100 text-emerald-800'
                        : 'bg-amber-100 text-amber-800'
                    "
                  >
                    {{
                      provider?.authenticated
                        ? t('conversation.settings.authenticated')
                        : t('conversation.settings.notAuthenticated')
                    }}
                  </span>
                </div>
                <div class="mt-4 rounded-md bg-muted p-3 text-xs">
                  <p>{{ t('conversation.settings.loginHint') }}</p>
                  <code class="mt-2 block font-mono">agent login</code>
                  <p class="mt-2 text-muted-foreground">
                    {{ t('conversation.settings.noKeyHint') }}
                  </p>
                </div>
              </div>

              <div class="space-y-2">
                <Label for="conversation-model">
                  {{ t('conversation.settings.modelLabel') }}
                </Label>
                <Input
                  id="conversation-model"
                  v-model="model"
                  :placeholder="t('conversation.settings.modelPlaceholder')"
                />
                <p class="text-xs text-muted-foreground">
                  {{ t('conversation.settings.modelHint') }}
                </p>
              </div>
              <div class="flex items-center gap-3">
                <Button :disabled="saving" @click="save">
                  {{ saving ? t('conversation.settings.saving') : t('conversation.settings.save') }}
                </Button>
                <span v-if="saved" class="text-sm text-emerald-700">
                  {{ t('conversation.settings.saved') }}
                </span>
                <Button variant="outline" :disabled="loading" @click="load">
                  {{ t('conversation.settings.refreshStatus') }}
                </Button>
              </div>
            </template>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{{ t('drafts.settings.title') }}</CardTitle>
            <CardDescription>{{ t('drafts.settings.description') }}</CardDescription>
          </CardHeader>
          <CardContent v-if="draftSettings" class="space-y-6">
            <div class="space-y-2">
              <Label for="draft-model">{{ t('drafts.settings.model') }}</Label>
              <Input
                id="draft-model"
                v-model="draftModel"
                :placeholder="t('conversation.settings.modelPlaceholder')"
              />
            </div>

            <div class="space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <Label for="draft-planner-prompt">{{ t('drafts.settings.prompt') }}</Label>
                <Button size="sm" variant="outline" @click="resetPlannerPrompt">
                  {{ t('drafts.settings.resetDefault') }}
                </Button>
              </div>
              <textarea
                id="draft-planner-prompt"
                v-model="plannerPrompt"
                rows="8"
                class="settings-textarea"
                @input="plannerUseDefault = false"
              />
              <p class="text-xs text-muted-foreground">
                {{
                  plannerUseDefault
                    ? t('drafts.settings.usingDefault')
                    : t('drafts.settings.usingCustom')
                }}
              </p>
            </div>

            <div class="space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <Label for="draft-skills-manual">{{ t('drafts.settings.skills') }}</Label>
                <Button size="sm" variant="outline" @click="resetSkillsManual">
                  {{ t('drafts.settings.resetDefault') }}
                </Button>
              </div>
              <textarea
                id="draft-skills-manual"
                v-model="skillsManual"
                rows="18"
                class="settings-textarea font-mono"
                @input="skillsUseDefault = false"
              />
              <p class="text-xs text-muted-foreground">
                {{ t('drafts.settings.skillsHint') }}
              </p>
            </div>

            <div class="rounded-md bg-muted p-3 text-xs text-muted-foreground">
              {{ t('drafts.settings.protocolHint') }}
            </div>
            <div class="flex items-center gap-3">
              <Button :disabled="draftSaving" @click="saveDraftPlanning">
                {{ draftSaving ? t('conversation.settings.saving') : t('drafts.settings.save') }}
              </Button>
              <span v-if="draftSaved" class="text-sm text-emerald-700">
                {{ t('conversation.settings.saved') }}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{{ t('workspace.settings.security.title') }}</CardTitle>
            <CardDescription>{{ t('workspace.settings.security.description') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <AccountSecurityCard />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{{ t('workspace.settings.sandbox.title') }}</CardTitle>
            <CardDescription>{{ t('workspace.settings.sandbox.description') }}</CardDescription>
          </CardHeader>
          <CardContent>
            <SandboxHealthCard :report="sandbox" :loading="sandboxLoading" />
          </CardContent>
        </Card>
      </div>
    </div>
  </main>
</template>

<style scoped>
.settings-textarea {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--color-input);
  border-radius: 0.375rem;
  background: var(--color-background);
  padding: 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.5;
}
</style>
