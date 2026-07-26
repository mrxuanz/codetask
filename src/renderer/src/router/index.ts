import { createRouter, createWebHistory } from 'vue-router'
import BootstrapGate from '@renderer/components/BootstrapGate.vue'
import BootstrapRedirect from '@renderer/pages/BootstrapRedirect.vue'
import ConversationPage from '@renderer/pages/ConversationPage.vue'
import SettingsPage from '@renderer/pages/SettingsPage.vue'
import DraftsPage from '@renderer/pages/DraftsPage.vue'
import LoginPage from '@renderer/pages/LoginPage.vue'
import SetupPage from '@renderer/pages/SetupPage.vue'

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
        { path: 'home', component: ConversationPage },
        { path: 'drafts', component: DraftsPage },
        { path: 'settings', component: SettingsPage }
      ]
    }
  ]
})

export default router
