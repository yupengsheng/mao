<template>
  <section v-if="wait?.recovered" class="recovered-wait-notice" role="status" aria-label="已恢复的等待通知">
    <div class="notice-header">
      <span class="notice-title">等待通知已恢复</span>
      <span class="notice-kind">{{ taskWaitKindLabel(wait.kind) }}</span>
    </div>
    <p class="notice-summary">{{ formatTaskWaitSummary(wait.summary, wait.kind) }}</p>
    <p class="notice-hint">
      执行已中断，等待通知已恢复；只能查看，无法在此审批或回答。
      到期时间：{{ formatDateTime(wait.expiresAt) || '未记录' }}
    </p>
  </section>
</template>

<script setup lang="ts">
import type { TaskWaitVO } from '@mao/contracts'
import { formatDateTime } from '../../utils/datetime'
import { formatTaskWaitSummary, taskWaitKindLabel } from '../../utils/taskWait'

defineProps<{ wait?: TaskWaitVO | null }>()
</script>

<style scoped>
.recovered-wait-notice {
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--aw-warning) 40%, var(--aw-hairline));
  border-radius: var(--aw-radius-sm);
  background: color-mix(in srgb, var(--aw-warning) 7%, var(--aw-canvas));
}

.notice-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.notice-title {
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-warning);
}

.notice-kind {
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted);
  font-size: var(--aw-text-caption);
}

.notice-summary {
  margin: 0;
  font-size: var(--aw-text-caption);
  line-height: 1.5;
  color: var(--aw-ink);
  overflow-wrap: anywhere;
}

.notice-hint {
  margin: 6px 0 0;
  font-size: var(--aw-text-caption);
  line-height: 1.5;
  color: var(--aw-ink-muted);
}
</style>
