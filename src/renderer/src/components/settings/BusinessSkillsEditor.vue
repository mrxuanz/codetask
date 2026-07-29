<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type {
  BusinessSkillDefinition,
  BusinessSkillsSettings,
  BusinessSkillWorkflow
} from '@shared/contracts/business-skills'
import { BUSINESS_SKILL_WORKFLOWS } from '@shared/contracts/business-skills'
import Button from '@renderer/components/ui/Button.vue'

const props = defineProps<{
  settings: BusinessSkillsSettings
  disabled?: boolean
}>()

const emit = defineEmits<{
  update: [settings: BusinessSkillsSettings]
}>()

const { t } = useI18n()

function updateSkill(index: number, patch: Partial<BusinessSkillDefinition>): void {
  const previousId = props.settings.skills[index]?.id
  const skills = props.settings.skills.map((skill, skillIndex) =>
    skillIndex === index ? { ...skill, ...patch } : skill
  )
  const nextId = patch.id
  const assignments =
    previousId && nextId && previousId !== nextId
      ? (Object.fromEntries(
          BUSINESS_SKILL_WORKFLOWS.map((workflow) => [
            workflow,
            props.settings.assignments[workflow].map((id) => (id === previousId ? nextId : id))
          ])
        ) as BusinessSkillsSettings['assignments'])
      : props.settings.assignments
  emit('update', { ...props.settings, skills, assignments })
}

function addSkill(): void {
  const usedIds = new Set(props.settings.skills.map((skill) => skill.id))
  let suffix = props.settings.skills.length + 1
  while (usedIds.has(`business-skill-${suffix}`)) suffix += 1
  emit('update', {
    ...props.settings,
    skills: [
      ...props.settings.skills,
      {
        id: `business-skill-${suffix}`,
        name: t('workspace.settings.skills.newSkill'),
        description: '',
        instructions: '',
        enabled: true
      }
    ]
  })
}

function removeSkill(id: string): void {
  emit('update', {
    ...props.settings,
    skills: props.settings.skills.filter((skill) => skill.id !== id),
    assignments: Object.fromEntries(
      BUSINESS_SKILL_WORKFLOWS.map((workflow) => [
        workflow,
        props.settings.assignments[workflow].filter((skillId) => skillId !== id)
      ])
    ) as BusinessSkillsSettings['assignments']
  })
}

function isAssigned(workflow: BusinessSkillWorkflow, skillId: string): boolean {
  return props.settings.assignments[workflow].includes(skillId)
}

function toggleAssignment(
  workflow: BusinessSkillWorkflow,
  skillId: string,
  assigned: boolean
): void {
  const current = props.settings.assignments[workflow]
  const next = assigned
    ? [...new Set([...current, skillId])]
    : current.filter((id) => id !== skillId)
  emit('update', {
    ...props.settings,
    assignments: { ...props.settings.assignments, [workflow]: next }
  })
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-muted-foreground">
        {{ t('workspace.settings.skills.hint') }}
      </p>
      <Button type="button" size="sm" variant="outline" :disabled="disabled" @click="addSkill">
        {{ t('workspace.settings.skills.add') }}
      </Button>
    </div>

    <div
      v-for="(skill, index) in settings.skills"
      :key="`${skill.id}-${index}`"
      class="space-y-3 rounded-lg border border-border p-4"
    >
      <div class="flex flex-wrap items-center justify-between gap-3">
        <label class="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            :checked="skill.enabled"
            :disabled="disabled"
            @change="
              updateSkill(index, {
                enabled: ($event.target as HTMLInputElement).checked
              })
            "
          />
          {{ t('workspace.settings.skills.enabled') }}
        </label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          :disabled="disabled"
          @click="removeSkill(skill.id)"
        >
          {{ t('common.delete') }}
        </Button>
      </div>

      <div class="grid gap-3 md:grid-cols-2">
        <label class="space-y-1.5 text-xs text-muted-foreground">
          {{ t('workspace.settings.skills.id') }}
          <input
            :value="skill.id"
            :disabled="disabled"
            class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
            @input="updateSkill(index, { id: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="space-y-1.5 text-xs text-muted-foreground">
          {{ t('workspace.settings.skills.name') }}
          <input
            :value="skill.name"
            :disabled="disabled"
            class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            @input="updateSkill(index, { name: ($event.target as HTMLInputElement).value })"
          />
        </label>
      </div>

      <label class="block space-y-1.5 text-xs text-muted-foreground">
        {{ t('workspace.settings.skills.descriptionLabel') }}
        <input
          :value="skill.description"
          :disabled="disabled"
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          @input="updateSkill(index, { description: ($event.target as HTMLInputElement).value })"
        />
      </label>

      <label class="block space-y-1.5 text-xs text-muted-foreground">
        {{ t('workspace.settings.skills.instructions') }}
        <textarea
          :value="skill.instructions"
          :disabled="disabled"
          rows="5"
          class="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed"
          @input="
            updateSkill(index, { instructions: ($event.target as HTMLTextAreaElement).value })
          "
        />
      </label>

      <div>
        <p class="text-xs font-medium text-muted-foreground">
          {{ t('workspace.settings.skills.workflows') }}
        </p>
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-2">
          <label
            v-for="workflow in BUSINESS_SKILL_WORKFLOWS"
            :key="workflow"
            class="flex items-center gap-2 text-xs"
          >
            <input
              type="checkbox"
              :checked="isAssigned(workflow, skill.id)"
              :disabled="disabled"
              @change="
                toggleAssignment(workflow, skill.id, ($event.target as HTMLInputElement).checked)
              "
            />
            {{ t(`workspace.settings.skills.workflow.${workflow}`) }}
          </label>
        </div>
      </div>
    </div>
  </div>
</template>
