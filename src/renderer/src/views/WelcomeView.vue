<script setup lang="ts">
import { useEnvStore } from '../stores/env'
import { useRepoStore } from '../stores/repos'
import { useUiStore } from '../stores/ui'

const env = useEnvStore()
const repos = useRepoStore()
const ui = useUiStore()
</script>

<template>
  <div class="view-body" style="max-width: 760px; padding-top: 64px">
    <h1 style="margin: 0 0 6px; font-size: 20px">OCR Client</h1>
    <p class="muted" style="margin: 0 0 24px">
      已安装的 open-code-review CLI 的可视化外壳。点击左栏任意仓库即可配置并启动审查。
    </p>

    <div v-if="env.warnings.length" class="stack" style="margin-bottom: 20px">
      <div v-for="(warning, index) in env.warnings" :key="index" class="banner warn">
        <span>⚠</span>
        <span>{{ warning }}</span>
      </div>
    </div>

    <div v-if="!env.hasOcr" class="banner error">
      <span>✕</span>
      <div>
        <div>未找到 ocr 命令。</div>
        <div class="mono" style="margin-top: 6px">
          npm install -g @alibaba-group/open-code-review
        </div>
      </div>
    </div>

    <div v-else-if="!repos.repos.length && !repos.loading" class="card">
      <div class="card-body">
        <p style="margin-top: 0">还没有可用的仓库。有两种方式开始：</p>
        <div class="inline">
          <button class="btn primary" @click="repos.addRepo()">＋ 添加仓库</button>
          <button class="btn" @click="ui.showView('settings')">查看环境诊断</button>
        </div>
        <p class="field-hint" style="margin-top: 10px">
          已经在命令行跑过 <span class="mono">ocr review</span> 的仓库会自动出现在左栏。
        </p>
      </div>
    </div>

    <div v-else class="card">
      <div class="card-body">
        <p style="margin-top: 0">从左栏选择一个仓库开始。点仓库名进入审查配置，点 ▶ 展开历史会话。</p>
        <div class="inline">
          <button class="btn primary" @click="repos.addRepo()">＋ 添加仓库</button>
          <button class="btn" @click="ui.showView('settings')">设置</button>
        </div>
      </div>
    </div>
  </div>
</template>
