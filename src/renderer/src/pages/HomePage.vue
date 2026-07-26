<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { logout } from '@renderer/api/auth'
import { fetchSandboxHealth, type SandboxHealthReport } from '@renderer/api/system'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import AccountSecurityCard from '@renderer/components/settings/AccountSecurityCard.vue'
import SandboxHealthCard from '@renderer/components/settings/SandboxHealthCard.vue'
import Button from '@renderer/components/ui/Button.vue'
import Card from '@renderer/components/ui/Card.vue'
import CardContent from '@renderer/components/ui/CardContent.vue'
import CardDescription from '@renderer/components/ui/CardDescription.vue'
import CardHeader from '@renderer/components/ui/CardHeader.vue'
import CardTitle from '@renderer/components/ui/CardTitle.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import PageShell from '@renderer/components/ui/PageShell.vue'
import { translateApiError } from '@renderer/i18n/translateApiError'

const { t } = useI18n()
const router = useRouter()
const { data, refresh } = useBootstrap()
const sandbox = ref<SandboxHealthReport | null>(null)
const sandboxLoading = ref(true)
const sandboxError = ref<string | null>(null)
const signingOut = ref(false)

async function loadSandboxHealth(): Promise<void> {
  sandboxLoading.value = true
  sandboxError.value = null
  try {
    sandbox.value = (await fetchSandboxHealth()).data
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sandboxError.value = translateApiError(message, t)
  } finally {
    sandboxLoading.value = false
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
  void loadSandboxHealth()
})
</script>

<template>
  <PageShell max-width="xl">
    <div class="space-y-6">
      <header class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-2xl font-semibold">{{ t('workspace.settings.title') }}</h1>
          <p class="mt-1 text-sm text-muted-foreground">{{ data?.username }}</p>
        </div>
        <Button type="button" variant="outline" :disabled="signingOut" @click="signOut">
          {{ signingOut ? t('workspace.settings.security.signingOut') : t('common.logout') }}
        </Button>
      </header>

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
          <ErrorAlert v-if="sandboxError" :message="sandboxError" />
          <SandboxHealthCard v-else :report="sandbox" :loading="sandboxLoading" />
        </CardContent>
      </Card>
    </div>
  </PageShell>
</template>
