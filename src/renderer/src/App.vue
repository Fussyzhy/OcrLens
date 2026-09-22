<script setup lang="ts">
import { onMounted } from 'vue'
import BackgroundFX from './components/BackgroundFX.vue'
import Sidebar from './components/Sidebar.vue'
import TitleBar from './components/TitleBar.vue'
import ToastHost from './components/ToastHost.vue'
import NewReviewView from './views/NewReviewView.vue'
import ResultsView from './views/ResultsView.vue'
import SettingsView from './views/SettingsView.vue'
import WelcomeView from './views/WelcomeView.vue'
import { useEnvStore } from './stores/env'
import { useRepoStore } from './stores/repos'
import { useUiStore } from './stores/ui'

const env = useEnvStore()
const repos = useRepoStore()
const ui = useUiStore()

onMounted(async () => {
  // Environment first: everything else depends on knowing where ocr and git are.
  await env.load()
  await repos.load()
})
</script>

<template>
  <div class="app">
    <BackgroundFX />
    <TitleBar />

    <div class="shell">
      <Sidebar />
      <main class="pane">
        <WelcomeView v-if="ui.view === 'welcome'" />
        <NewReviewView v-else-if="ui.view === 'new-review'" />
        <ResultsView v-else-if="ui.view === 'results'" />
        <SettingsView v-else-if="ui.view === 'settings'" />
      </main>
    </div>
  </div>
  <ToastHost />
</template>
