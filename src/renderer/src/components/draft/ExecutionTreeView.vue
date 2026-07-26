<script setup lang="ts">
import type { ExecutionTree } from '@renderer/api/drafts'

defineProps<{ tree: ExecutionTree }>()
</script>

<template>
  <div class="space-y-4">
    <div>
      <h3 class="text-lg font-semibold">{{ tree.title }}</h3>
      <p class="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{{ tree.summary }}</p>
    </div>
    <section
      v-for="milestone in tree.milestones"
      :key="milestone.id"
      class="rounded-lg border border-border bg-card p-4"
    >
      <div class="flex items-start gap-2">
        <span class="rounded bg-primary/10 px-2 py-1 font-mono text-xs text-primary">
          {{ milestone.id }}
        </span>
        <div>
          <h4 class="font-semibold">{{ milestone.title }}</h4>
          <p class="mt-1 text-sm text-muted-foreground">{{ milestone.objective }}</p>
          <p class="mt-2 text-xs"><strong>Done:</strong> {{ milestone.successCriteria }}</p>
        </div>
      </div>
      <div class="mt-4 space-y-3">
        <article
          v-for="slice in milestone.slices"
          :key="slice.id"
          class="rounded-md border border-border/80 bg-background p-3"
        >
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-mono text-xs text-muted-foreground">{{ slice.id }}</span>
            <h5 class="font-medium">{{ slice.title }}</h5>
            <span v-if="slice.dependsOn.length" class="text-xs text-muted-foreground">
              ← {{ slice.dependsOn.join(', ') }}
            </span>
          </div>
          <p class="mt-1 text-sm text-muted-foreground">{{ slice.objective }}</p>
          <div class="mt-3 space-y-2">
            <div
              v-for="task in slice.tasks"
              :key="task.id"
              class="rounded border border-border/70 p-3 text-sm"
            >
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-xs text-muted-foreground">{{ task.id }}</span>
                <strong>{{ task.title }}</strong>
                <span class="rounded bg-muted px-2 py-0.5 text-xs"
                  >{{ task.estimatedMinutes }}m</span
                >
                <span class="rounded bg-muted px-2 py-0.5 text-xs">{{ task.kind }}</span>
              </div>
              <p class="mt-2 text-muted-foreground">{{ task.objective }}</p>
              <p v-if="task.files.length" class="mt-2 break-all font-mono text-xs">
                {{ task.files.join(' · ') }}
              </p>
              <ul class="mt-2 list-disc space-y-1 pl-5 text-xs">
                <li v-for="criterion in task.acceptanceCriteria" :key="criterion">
                  {{ criterion }}
                </li>
              </ul>
              <p v-if="task.attachmentIds.length" class="mt-2 text-xs text-muted-foreground">
                Attachments: {{ task.attachmentIds.join(', ') }}
              </p>
            </div>
          </div>
        </article>
      </div>
    </section>
  </div>
</template>
