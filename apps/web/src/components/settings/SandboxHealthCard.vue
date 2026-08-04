<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SandboxHealthReport } from '@renderer/api/system'

const props = defineProps<{
  report: SandboxHealthReport | null
  loading?: boolean
}>()

const { t } = useI18n()

const statusLabel = computed(() => {
  const status = props.report?.status ?? 'unavailable'
  return t(`workspace.settings.sandbox.status.${status}`)
})

const statusClass = computed(() => {
  switch (props.report?.status) {
    case 'ready':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    case 'degraded':
      return 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
    case 'disabled':
      return 'bg-muted text-muted-foreground'
    default:
      return 'bg-destructive/15 text-destructive'
  }
})

function checkLabel(
  check: { ok: boolean; message?: string } | undefined,
  fallback: string
): string {
  if (!check) return fallback
  return check.ok ? t('workspace.settings.sandbox.checkOk') : (check.message ?? fallback)
}
</script>

<template>
  <div class="space-y-4 text-sm">
    <div v-if="loading" class="text-muted-foreground">
      {{ t('workspace.settings.sandbox.loading') }}
    </div>

    <template v-else-if="report">
      <div class="flex flex-wrap items-center gap-2">
        <span class="rounded-md px-2 py-0.5 text-xs font-medium" :class="statusClass">
          {{ statusLabel }}
        </span>
        <span v-if="report.backend" class="text-muted-foreground">{{ report.backend }}</span>
        <span v-if="report.helperVersion" class="text-muted-foreground">
          v{{ report.helperVersion }}
        </span>
      </div>

      <dl class="grid gap-2 sm:grid-cols-2">
        <div>
          <dt class="text-muted-foreground">{{ t('workspace.settings.sandbox.native') }}</dt>
          <dd>{{ checkLabel(report.native, t('workspace.settings.sandbox.unknown')) }}</dd>
        </div>
        <div v-if="report.platformRuntime">
          <dt class="text-muted-foreground">
            {{ t('workspace.settings.sandbox.platformRuntime') }}
          </dt>
          <dd>{{ checkLabel(report.platformRuntime, t('workspace.settings.sandbox.unknown')) }}</dd>
        </div>
        <div v-if="report.supervisor">
          <dt class="text-muted-foreground">{{ t('workspace.settings.sandbox.supervisor') }}</dt>
          <dd>{{ checkLabel(report.supervisor, t('workspace.settings.sandbox.unknown')) }}</dd>
        </div>
        <div v-if="report.windowsSetup">
          <dt class="text-muted-foreground">{{ t('workspace.settings.sandbox.windowsSetup') }}</dt>
          <dd>{{ checkLabel(report.windowsSetup, t('workspace.settings.sandbox.unknown')) }}</dd>
        </div>
      </dl>

      <ul v-if="report.warnings.length" class="list-disc space-y-1 pl-5 text-muted-foreground">
        <li v-for="(warning, index) in report.warnings" :key="index">{{ warning }}</li>
      </ul>
    </template>
  </div>
</template>
