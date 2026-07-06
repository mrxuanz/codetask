<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { setup } from '@renderer/api/auth'
import { setToken } from '@renderer/auth/token'
import CredentialsForm from '@renderer/components/auth/CredentialsForm.vue'
import PageShell from '@renderer/components/ui/PageShell.vue'
import { useBootstrap } from '@renderer/composables/useBootstrap'

const { t } = useI18n()
const router = useRouter()
const { refresh, data: bootstrapData } = useBootstrap()

const needSetupToken = computed(() => bootstrapData.value?.setupTokenRequired ?? false)

async function onSubmit(payload: {
  username: string
  password: string
  setupToken?: string
}): Promise<void> {
  const res = await setup(payload.username, payload.password, payload.setupToken)
  setToken(res.data.token, res.data.expires_at)
  await refresh()
  await router.replace('/home')
}
</script>

<template>
  <PageShell>
    <CredentialsForm
      :title="t('setup.title')"
      :description="t('setup.description')"
      :submit-label="t('setup.submit')"
      :submitting-label="t('setup.submitting')"
      password-auto-complete="new-password"
      :show-setup-token="needSetupToken"
      :enforce-credentials-policy="true"
      :on-submit="onSubmit"
    />
  </PageShell>
</template>
