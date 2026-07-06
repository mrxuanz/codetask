<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { login } from '@renderer/api/auth'
import { setToken } from '@renderer/auth/token'
import CredentialsForm from '@renderer/components/auth/CredentialsForm.vue'
import PageShell from '@renderer/components/ui/PageShell.vue'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import type { LoginPayload } from '@renderer/api/types'

const { t } = useI18n()
const router = useRouter()
const { refresh } = useBootstrap()

async function onSubmit(payload: {
  username: string
  password: string
  captchaId?: string
  captchaAnswer?: string
}): Promise<void> {
  const loginPayload: LoginPayload = {
    username: payload.username,
    password: payload.password,
    captchaId: payload.captchaId,
    captchaAnswer: payload.captchaAnswer
  }
  const res = await login(loginPayload)
  setToken(res.data.token, res.data.expires_at)
  await refresh()
  await router.replace('/home')
}
</script>

<template>
  <PageShell>
    <CredentialsForm
      :title="t('login.title')"
      :description="t('login.description')"
      :submit-label="t('login.submit')"
      :submitting-label="t('login.submitting')"
      password-auto-complete="current-password"
      :show-setup-token="false"
      :on-submit="onSubmit"
    />
  </PageShell>
</template>
