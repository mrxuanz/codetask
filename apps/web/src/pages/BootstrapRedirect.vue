<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import Card from '@renderer/components/ui/Card.vue'
import CardContent from '@renderer/components/ui/CardContent.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import PageShell from '@renderer/components/ui/PageShell.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { translateApiError } from '@renderer/i18n/translateApiError'

const { t } = useI18n()

const { data, loading, error } = useBootstrap()
const router = useRouter()

const connectionErrorMessage = computed(() =>
  t('bootstrap.connectionError', {
    error: error.value ? translateApiError(error.value, t) : t('common.unknown')
  })
)

const target = computed(() => {
  if (loading.value || error.value || !data.value) return null
  if (!data.value.initialized) return '/setup'
  if (!data.value.authenticated) return '/login'
  return '/home'
})

watch(
  target,
  (path) => {
    if (path) void router.replace(path)
  },
  { immediate: true }
)
</script>

<template>
  <PageShell v-if="loading" max-width="sm">
    <Card>
      <CardContent class="py-8">
        <Spinner />
      </CardContent>
    </Card>
  </PageShell>

  <PageShell v-else-if="error || !data" max-width="sm">
    <ErrorAlert :message="connectionErrorMessage" />
  </PageShell>
</template>
