<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { JobProgressSnapshot } from '@renderer/lib/jobProgress'

const props = defineProps<{
  snapshot: JobProgressSnapshot
  compact?: boolean
  /** Larger percentage and progress bar for loading overlays. */
  prominent?: boolean
  /** Bordered fill box — occupancy shown by area, not a text label. */
  occupancy?: boolean
}>()

const { t } = useI18n()

const fillClass = computed(() => {
  switch (props.snapshot.tone) {
    case 'success':
      return 'bg-emerald-500'
    case 'danger':
      return 'bg-red-500'
    default:
      return 'bg-sky-500'
  }
})

const summaryClass = computed(() => {
  switch (props.snapshot.tone) {
    case 'danger':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
})
</script>

<template>
  <div v-if="occupancy" class="w-full">
    <div
      class="relative h-36 w-full overflow-hidden rounded-lg border-2 border-border bg-muted/15 sm:h-40"
      role="progressbar"
      :aria-valuenow="snapshot.percent"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="t('workspace.tasks.progress.label')"
    >
      <div
        class="absolute inset-x-0 bottom-0 transition-all duration-500 ease-out"
        :class="fillClass"
        :style="{ height: `${snapshot.percent}%` }"
      />
      <div class="pointer-events-none absolute inset-0 flex items-center justify-center">
        <strong
          class="text-3xl font-semibold tabular-nums text-foreground drop-shadow-sm sm:text-4xl"
        >
          {{ snapshot.percent }}%
        </strong>
      </div>
    </div>
  </div>

  <div v-else :class="prominent ? 'w-full space-y-3' : compact ? 'space-y-1' : 'space-y-2'">
    <div
      :class="
        prominent
          ? 'flex flex-col items-center gap-1 text-center'
          : 'flex items-center justify-between gap-2 text-[11px]'
      "
    >
      <span :class="prominent ? 'text-xs text-muted-foreground' : 'text-muted-foreground'">
        {{ t('workspace.tasks.progress.label') }}
      </span>
      <strong
        :class="
          prominent
            ? 'text-3xl font-semibold tabular-nums text-foreground'
            : 'font-medium text-foreground'
        "
      >
        {{ snapshot.percent }}%
      </strong>
    </div>
    <div
      :class="
        prominent
          ? 'h-2.5 overflow-hidden rounded-full bg-muted'
          : 'h-1.5 overflow-hidden rounded-full bg-muted'
      "
    >
      <div
        class="h-full rounded-full transition-all"
        :class="fillClass"
        :style="{ width: `${snapshot.percent}%` }"
      />
    </div>
    <p v-if="!compact && !prominent" class="text-xs" :class="summaryClass">
      {{ snapshot.summaryLabel }}
    </p>
  </div>
</template>
