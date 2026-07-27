import { createRouter, createWebHistory } from 'vue-router'
import BootstrapGate from '@renderer/components/BootstrapGate.vue'
import BootstrapRedirect from '@renderer/pages/BootstrapRedirect.vue'
import ConversationPage from '@renderer/pages/ConversationPage.vue'
import SettingsPage from '@renderer/pages/SettingsPage.vue'
import DraftsPage from '@renderer/pages/DraftsPage.vue'
import JobsPage from '@renderer/pages/JobsPage.vue'
import LoginPage from '@renderer/pages/LoginPage.vue'
import SetupPage from '@renderer/pages/SetupPage.vue'
import HomeLayout from '@renderer/layouts/HomeLayout.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: BootstrapRedirect },
    {
      path: '/',
      component: BootstrapGate,
      children: [
        { path: 'setup', component: SetupPage },
        { path: 'login', component: LoginPage },
        {
          path: 'home',
          component: HomeLayout,
          children: [
            { path: '', component: ConversationPage },
            { path: 'create', component: DraftsPage },
            { path: 'tasks/:jobId?', component: JobsPage },
            { path: 'settings', component: SettingsPage }
          ]
        },
        { path: 'drafts', redirect: '/home/create' },
        { path: 'jobs', redirect: '/home/tasks' },
        { path: 'settings', redirect: '/home/settings' }
      ]
    }
  ]
})

export default router
