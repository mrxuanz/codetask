<script setup lang="ts">
import { onMounted, ref, type Component } from 'vue'
import { useRouter } from 'vue-router'
import {
  Bot,
  Boxes,
  Database,
  KeyRound,
  Languages,
  ListChecks,
  LogOut,
  RefreshCw,
  Save,
  Shield,
  SlidersHorizontal,
  Sparkles
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import AccountSecurityCard from '@renderer/components/settings/AccountSecurityCard.vue'
import JobRoleSettingsEditor from '@renderer/components/settings/JobRoleSettingsEditor.vue'
import SandboxHealthCard from '@renderer/components/settings/SandboxHealthCard.vue'
import LanguageSwitcher from '@renderer/components/LanguageSwitcher.vue'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import {
  fetchConversationProviderStatuses,
  type ConversationProviderStatus
} from '@renderer/api/conversation'
import { logout } from '@renderer/api/auth'
import {
  fetchRuntimeInfo,
  fetchSandboxHealth,
  type RuntimeInfo,
  type SandboxHealthReport
} from '@renderer/api/system'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import { translateApiError } from '@renderer/i18n/translateApiError'
import { fetchDraftSettings, updateDraftSettings, type DraftSettings } from '@renderer/api/drafts'
import {
  fetchJobProviders,
  fetchJobSettings,
  updateJobSettings,
  type JobProviderDescriptor,
  type JobSettings
} from '@renderer/api/jobs'

type Section =
  | 'general'
  | 'providers'
  | 'pool'
  | 'job-roles'
  | 'planner'
  | 'sandbox'
  | 'account'

const { t } = useI18n()
const router = useRouter()
const { refresh } = useBootstrap()
const active = ref<Section>('general')
const providers = ref<ConversationProviderStatus[]>([])
const runtimeInfo = ref<RuntimeInfo | null>(null)
const sandbox = ref<SandboxHealthReport | null>(null)
const loading = ref(true)
const error = ref<string | null>(null)
const signingOut = ref(false)
const jobSettings = ref<JobSettings | null>(null)
const jobDefaults = ref<JobSettings | null>(null)
const jobProviders = ref<JobProviderDescriptor[]>([])
const jobSaving = ref(false)
const jobSaved = ref(false)
const draftSettings = ref<DraftSettings | null>(null)
const discussionPrompt = ref('')
const discussionSkillsManual = ref('')
const plannerPrompt = ref('')
const plannerSkillsManual = ref('')
const discussionPromptDefault = ref(true)
const discussionSkillsDefault = ref(true)
const plannerPromptDefault = ref(true)
const plannerSkillsDefault = ref(true)
const draftSaving = ref(false)
const draftSaved = ref(false)

const sections: Array<{ id: Section; label: string; description: string; icon: Component }> = [
  { id: 'general', label: '通用与存储', description: '语言、运行模式、本地数据', icon: SlidersHorizontal },
  { id: 'providers', label: '宿主 Provider', description: '安装与登录状态', icon: Bot },
  { id: 'pool', label: '执行池', description: '仅管理 Job 并发', icon: Boxes },
  { id: 'job-roles', label: 'Work 与校验', description: '角色、提示词、Skills', icon: ListChecks },
  { id: 'planner', label: 'Planner', description: '需求对话与执行树', icon: Sparkles },
  { id: 'sandbox', label: '沙箱', description: '原生隔离与健康状态', icon: Shield },
  { id: 'account', label: '账号安全', description: '密码与会话', icon: KeyRound }
]

function reportError(cause: unknown): void {
  error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
}

function bindDraftSettings(value: DraftSettings): void {
  draftSettings.value = value
  discussionPrompt.value = value.discussionPrompt.value
  discussionSkillsManual.value = value.discussionSkillsManual.value
  plannerPrompt.value = value.plannerPrompt.value
  plannerSkillsManual.value = value.skillsManual.value
  discussionPromptDefault.value = value.discussionPrompt.useDefault
  discussionSkillsDefault.value = value.discussionSkillsManual.useDefault
  plannerPromptDefault.value = value.plannerPrompt.useDefault
  plannerSkillsDefault.value = value.skillsManual.useDefault
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const [providerResult, sandboxResult, runtimeResult, draftResult, jobResult, jobProviderResult] =
      await Promise.all([
        fetchConversationProviderStatuses(),
        fetchSandboxHealth(),
        fetchRuntimeInfo(),
        fetchDraftSettings(),
        fetchJobSettings(),
        fetchJobProviders()
      ])
    providers.value = providerResult.data
    sandbox.value = sandboxResult.data
    runtimeInfo.value = runtimeResult.data
    bindDraftSettings(draftResult.data)
    jobSettings.value = structuredClone(jobResult.data.settings)
    jobDefaults.value = jobResult.data.defaults
    jobProviders.value = jobProviderResult.data
  } catch (cause) {
    reportError(cause)
  } finally {
    loading.value = false
  }
}

async function saveJobSettings(): Promise<void> {
  const current = jobSettings.value
  if (!current) return
  jobSaving.value = true
  jobSaved.value = false
  error.value = null
  try {
    const result = await updateJobSettings(current, current.revision)
    jobSettings.value = structuredClone(result.data.settings)
    jobDefaults.value = result.data.defaults
    jobSaved.value = true
  } catch (cause) {
    reportError(cause)
  } finally {
    jobSaving.value = false
  }
}

async function savePlannerSettings(): Promise<void> {
  const current = draftSettings.value
  if (!current) return
  draftSaving.value = true
  draftSaved.value = false
  error.value = null
  try {
    const result = await updateDraftSettings({
      discussionPrompt: discussionPromptDefault.value ? null : discussionPrompt.value,
      discussionSkillsManual: discussionSkillsDefault.value
        ? null
        : discussionSkillsManual.value,
      plannerPrompt: plannerPromptDefault.value ? null : plannerPrompt.value,
      skillsManual: plannerSkillsDefault.value ? null : plannerSkillsManual.value,
      expectedRevision: current.revision
    })
    bindDraftSettings(result.data)
    draftSaved.value = true
  } catch (cause) {
    reportError(cause)
  } finally {
    draftSaving.value = false
  }
}

function resetDraftField(
  field:
    | 'discussionPrompt'
    | 'discussionSkillsManual'
    | 'plannerPrompt'
    | 'skillsManual'
): void {
  const settings = draftSettings.value
  if (!settings) return
  if (field === 'discussionPrompt') {
    discussionPrompt.value = settings.defaults.discussionPrompt
    discussionPromptDefault.value = true
  }
  if (field === 'discussionSkillsManual') {
    discussionSkillsManual.value = settings.defaults.discussionSkillsManual
    discussionSkillsDefault.value = true
  }
  if (field === 'plannerPrompt') {
    plannerPrompt.value = settings.defaults.plannerPrompt
    plannerPromptDefault.value = true
  }
  if (field === 'skillsManual') {
    plannerSkillsManual.value = settings.defaults.skillsManual
    plannerSkillsDefault.value = true
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

onMounted(() => void load())
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 bg-background">
    <aside class="w-64 shrink-0 border-r border-border bg-card/50 p-3">
      <div class="px-2 py-2">
        <h1 class="text-lg font-semibold">{{ t('conversation.settings.title') }}</h1>
        <p class="mt-1 text-xs text-muted-foreground">按职责拆分配置，模型始终由宿主 CLI 决定。</p>
      </div>
      <nav class="mt-3 space-y-1">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          class="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left"
          :class="active === section.id ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
          @click="active = section.id"
        >
          <component :is="section.icon" class="mt-0.5 size-4 shrink-0" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ section.label }}</span>
            <span
              class="mt-0.5 block truncate text-[11px]"
              :class="active === section.id ? 'text-primary-foreground/70' : 'text-muted-foreground'"
            >
              {{ section.description }}
            </span>
          </span>
        </button>
      </nav>
      <div class="mt-5 border-t border-border pt-3">
        <Button variant="ghost" class="w-full justify-start" :disabled="signingOut" @click="signOut">
          <LogOut class="size-4" />{{ t('common.logout') }}
        </Button>
      </div>
    </aside>

    <main class="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div class="mx-auto max-w-4xl p-6">
        <ErrorAlert v-if="error" class="mb-5" :message="error" />
        <div v-if="loading" class="flex justify-center p-16">
          <RefreshCw class="size-6 animate-spin text-muted-foreground" />
        </div>

        <template v-else>
          <section v-if="active === 'general'" class="space-y-5">
            <header>
              <h2 class="text-xl font-semibold">通用与存储</h2>
              <p class="mt-1 text-sm text-muted-foreground">界面偏好与初始化时选定的本地数据边界。</p>
            </header>
            <div class="rounded-xl border border-border bg-card p-5">
              <div class="flex items-center justify-between gap-4">
                <div class="flex items-center gap-3">
                  <Languages class="size-5 text-muted-foreground" />
                  <div><h3 class="text-sm font-semibold">界面语言</h3><p class="mt-1 text-xs text-muted-foreground">只保存在浏览器本地偏好中。</p></div>
                </div>
                <LanguageSwitcher />
              </div>
            </div>
            <div class="rounded-xl border border-border bg-card p-5">
              <div class="flex items-start gap-3">
                <Database class="mt-0.5 size-5 text-muted-foreground" />
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold">数据目录</h3>
                  <p class="mt-1 text-xs text-muted-foreground">数据库、草案附件、Job 快照和运行目录由初始化结果显式注入。</p>
                  <code class="mt-3 block break-all rounded-lg bg-muted px-3 py-2 text-xs">{{ runtimeInfo?.dataDir }}</code>
                  <dl class="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div class="rounded-lg border border-border p-3"><dt class="text-muted-foreground">运行模式</dt><dd class="mt-1 font-medium">{{ runtimeInfo?.mode }}</dd></div>
                    <div class="rounded-lg border border-border p-3"><dt class="text-muted-foreground">配置权威</dt><dd class="mt-1 font-medium">TypeScript 运行时对象</dd></div>
                  </dl>
                  <p class="mt-3 text-xs leading-5 text-muted-foreground">Provider 账号、模型、密钥和业务开关不从环境变量读取；PATH 等操作系统进程环境仅用于发现宿主 CLI，不是产品配置入口。</p>
                </div>
              </div>
            </div>
          </section>

          <section v-if="active === 'providers'" class="space-y-5">
            <header class="flex items-start justify-between gap-4">
              <div><h2 class="text-xl font-semibold">宿主 Provider</h2><p class="mt-1 text-sm text-muted-foreground">四个 Provider 统一展示安装、协议和宿主登录状态。</p></div>
              <Button variant="outline" size="sm" @click="load"><RefreshCw class="size-4" />刷新</Button>
            </header>
            <div v-for="provider in providers" :key="provider.code" class="rounded-xl border border-border bg-card p-5">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div class="flex items-center gap-2"><h3 class="font-semibold">{{ provider.label }}</h3><span class="rounded bg-muted px-2 py-0.5 text-[10px] uppercase">{{ provider.protocol }}</span></div>
                  <p class="mt-2 text-xs text-muted-foreground">{{ provider.message }}</p>
                </div>
                <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="provider.authenticated ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/10 text-amber-700'">
                  {{ provider.authenticated ? '宿主已登录' : provider.installed ? '需要登录' : '未安装' }}
                </span>
              </div>
              <div class="mt-4 rounded-lg bg-muted p-3 text-xs">
                <p class="text-muted-foreground">登录命令</p>
                <code class="mt-1 block font-mono">{{ provider.loginCommand }}</code>
                <p class="mt-3 text-muted-foreground">状态命令</p>
                <code class="mt-1 block font-mono">{{ provider.statusCommand }}</code>
              </div>
              <p class="mt-3 text-xs text-muted-foreground">CodeTask 不保存 Key 或模型名称；运行时使用该宿主 CLI 已登录账号与当前模型。</p>
            </div>
          </section>

          <section v-if="active === 'pool' && jobSettings" class="space-y-5">
            <header><h2 class="text-xl font-semibold">执行池</h2><p class="mt-1 text-sm text-muted-foreground">这里只控制同时运行多少个 Job；每个 Job 内部永远一次只运行一个 Work 或 Gate。</p></header>
            <div class="rounded-xl border border-border bg-card p-5">
              <label class="text-sm font-semibold" for="pool-size">最大并发 Job</label>
              <select id="pool-size" v-model.number="jobSettings.maxConcurrentJobs" class="mt-3 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
                <option :value="1">1（默认，最稳妥）</option>
                <option :value="2">2（两个不同 Job 可并行）</option>
              </select>
              <p class="mt-3 text-xs leading-5 text-muted-foreground">同一工作区仍只允许一个 Job 持有写租约；队列按持久化顺序补入执行池，暂停、失败和重启不会跳过原位置。</p>
              <div class="mt-4 flex items-center gap-3"><Button :disabled="jobSaving" @click="saveJobSettings"><Save class="size-4" />保存执行池</Button><span v-if="jobSaved" class="text-sm text-emerald-700">已保存</span></div>
            </div>
          </section>

          <section v-if="active === 'job-roles' && jobSettings && jobDefaults" class="space-y-5">
            <header><h2 class="text-xl font-semibold">Work 与校验角色</h2><p class="mt-1 text-sm text-muted-foreground">Provider、是否校验、提示词和 Skills 操作手册；无 App 模型字段。</p></header>
            <JobRoleSettingsEditor title="Work 执行" description="唯一可持有工作区写租约的角色。" :role="jobSettings.work" :defaults="jobDefaults.work" :providers="jobProviders" :validation="false" @update="jobSettings.work = $event" />
            <JobRoleSettingsEditor title="Work 校验" description="每个 Work 后的只读校验，可关闭。" :role="jobSettings.workValidation" :defaults="jobDefaults.workValidation" :providers="jobProviders" validation @update="jobSettings.workValidation = { ...jobSettings.workValidation, ...$event }" />
            <JobRoleSettingsEditor title="Slice 校验" description="检查一个 Slice 内多个 Work 的组合结果。" :role="jobSettings.sliceValidation" :defaults="jobDefaults.sliceValidation" :providers="jobProviders" validation @update="jobSettings.sliceValidation = { ...jobSettings.sliceValidation, ...$event }" />
            <JobRoleSettingsEditor title="Milestone 校验" description="跨 Slice 的只读里程碑校验。" :role="jobSettings.milestoneValidation" :defaults="jobDefaults.milestoneValidation" :providers="jobProviders" validation @update="jobSettings.milestoneValidation = { ...jobSettings.milestoneValidation, ...$event }" />
            <div class="sticky bottom-4 flex items-center justify-end gap-3 rounded-xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur">
              <span v-if="jobSaved" class="text-sm text-emerald-700">已保存；新 Job 会快照这些设置。</span>
              <Button :disabled="jobSaving" @click="saveJobSettings"><Save class="size-4" />保存 Work 与校验</Button>
            </div>
          </section>

          <section v-if="active === 'planner' && draftSettings" class="space-y-5">
            <header><h2 class="text-xl font-semibold">Planner</h2><p class="mt-1 text-sm text-muted-foreground">需求对话与执行树生成是两个职责，各自拥有提示词和 Skills 操作手册。</p></header>
            <div class="rounded-xl border border-border bg-card p-5">
              <div class="flex items-center justify-between gap-3"><div><h3 class="text-sm font-semibold">需求对话提示词</h3><p class="mt-1 text-xs text-muted-foreground">Reflect → Gather → 草案 → 显式确认。</p></div><Button variant="outline" size="sm" @click="resetDraftField('discussionPrompt')">恢复默认</Button></div>
              <textarea v-model="discussionPrompt" rows="7" class="settings-textarea" @input="discussionPromptDefault = false" />
              <div class="mt-5 flex items-center justify-between gap-3"><h3 class="text-sm font-semibold">需求对话 Skills 操作手册</h3><Button variant="outline" size="sm" @click="resetDraftField('discussionSkillsManual')">恢复默认</Button></div>
              <textarea v-model="discussionSkillsManual" rows="13" class="settings-textarea font-mono" @input="discussionSkillsDefault = false" />
            </div>
            <div class="rounded-xl border border-border bg-card p-5">
              <div class="flex items-center justify-between gap-3"><div><h3 class="text-sm font-semibold">执行树提示词</h3><p class="mt-1 text-xs text-muted-foreground">只把已确认草案拆成有序执行树。</p></div><Button variant="outline" size="sm" @click="resetDraftField('plannerPrompt')">恢复默认</Button></div>
              <textarea v-model="plannerPrompt" rows="7" class="settings-textarea" @input="plannerPromptDefault = false" />
              <div class="mt-5 flex items-center justify-between gap-3"><h3 class="text-sm font-semibold">执行树 Skills 操作手册</h3><Button variant="outline" size="sm" @click="resetDraftField('skillsManual')">恢复默认</Button></div>
              <textarea v-model="plannerSkillsManual" rows="16" class="settings-textarea font-mono" @input="plannerSkillsDefault = false" />
              <p class="mt-3 text-xs leading-5 text-muted-foreground">JSON 结构、节点 ID、依赖顺序、相对路径、附件 ID 与 3–15 分钟任务时长由服务端固定协议校验，编辑文本不能关闭。</p>
            </div>
            <div class="sticky bottom-4 flex items-center justify-end gap-3 rounded-xl border border-border bg-background/95 p-3 shadow-lg backdrop-blur">
              <span v-if="draftSaved" class="text-sm text-emerald-700">已保存</span>
              <Button :disabled="draftSaving" @click="savePlannerSettings"><Save class="size-4" />保存 Planner</Button>
            </div>
          </section>

          <section v-if="active === 'sandbox'" class="space-y-5">
            <header><h2 class="text-xl font-semibold">沙箱</h2><p class="mt-1 text-sm text-muted-foreground">一个应用策略、一个原生 wire 协议；业务代码不能选择 v1/v2/v3 分支。</p></header>
            <div class="rounded-xl border border-border bg-card p-5"><SandboxHealthCard :report="sandbox" :loading="loading" /></div>
            <div class="rounded-xl border border-border bg-card p-5 text-sm leading-6">
              <h3 class="font-semibold">强制边界</h3>
              <ul class="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
                <li>普通对话与 Planner 不持有原生工作区写租约；Job Work 运行时，普通对话降为只读。</li>
                <li>只有 task-worker + task-sandbox + 匹配 Job 租约可以写工作区。</li>
                <li>所有校验器只读工作区，只能写独立验证输出目录。</li>
                <li>Provider 状态目录、runtime 和验证输出一旦与工作区重叠即拒绝启动。</li>
              </ul>
            </div>
          </section>

          <section v-if="active === 'account'" class="space-y-5">
            <header><h2 class="text-xl font-semibold">账号安全</h2><p class="mt-1 text-sm text-muted-foreground">CodeTask 本地账号、密码与会话，不涉及 Provider 凭据。</p></header>
            <div class="rounded-xl border border-border bg-card p-5"><AccountSecurityCard /></div>
          </section>
        </template>
      </div>
    </main>
  </div>
</template>

<style scoped>
.settings-textarea {
  margin-top: 0.75rem;
  width: 100%;
  resize: vertical;
  border: 1px solid var(--color-input);
  border-radius: 0.5rem;
  background: var(--color-background);
  padding: 0.75rem;
  font-size: 0.8125rem;
  line-height: 1.5;
}
</style>
