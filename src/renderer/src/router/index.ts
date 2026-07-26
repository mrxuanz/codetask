import { createRouter, createWebHistory } from 'vue-router'
import BootstrapGate from '@renderer/components/BootstrapGate.vue'
import BootstrapRedirect from '@renderer/pages/BootstrapRedirect.vue'
import HomePage from '@renderer/pages/HomePage.vue'
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
        { path: 'home', component: HomePage }
      ]
    }
  ]
})

export default router
