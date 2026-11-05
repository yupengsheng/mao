<template>
  <div class="agent-tab">
    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>Agent Token 排行</span>
          <el-button type="primary" link @click="go('/agents')">Agent 管理</el-button>
        </div>
      </template>
      <BaseChart
        :option="rankBarOption(tokenItems, CHART_PALETTE[0], formatTokens)"
        :empty="tokenItems.length === 0"
        :height="Math.max(200, tokenItems.length * 34 + 32)"
      />
    </el-card>

    <el-card class="block">
      <template #header>
        <div class="card-header">
          <span>Agent 用量明细</span>
          <div class="header-actions">
            <span class="card-hint">按会话数 / 消息数降序 · 共 {{ total }} 条，当前第 {{ page }} 页</span>
            <el-button :disabled="agentStats.length === 0" @click="exportRows">导出当前页 CSV</el-button>
          </div>
        </div>
      </template>
      <el-table :data="agentStats" size="small" stripe>
        <template #empty>
          <el-empty description="当前页暂无 Agent 数据" :image-size="48" />
        </template>
        <el-table-column label="Agent" min-width="150" show-overflow-tooltip>
          <template #default="{ row }">
            <button class="linkish" type="button" @click="go(`/sessions?agentId=${row.agentId}`)">
              {{ row.agentName || '未知' }}
            </button>
          </template>
        </el-table-column>
        <el-table-column label="会话" width="80" align="right">
          <template #default="{ row }">{{ formatNumber(row.sessionCount) }}</template>
        </el-table-column>
        <el-table-column label="消息" width="90" align="right">
          <template #default="{ row }">{{ formatNumber(row.messageCount) }}</template>
        </el-table-column>
        <el-table-column label="Token" width="120" align="right">
          <template #default="{ row }">
            <strong>{{ formatNumber(row.totalTokens) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="调用" width="80" align="right">
          <template #default="{ row }">{{ formatNumber(row.callCount || 0) }}</template>
        </el-table-column>
        <el-table-column label="成本" width="100" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">{{ formatCost(row.cost) }}</template>
        </el-table-column>
        <el-table-column label="成功率" width="90" align="right">
          <template #default="{ row }">
            {{ row.callSuccessRate == null ? '-' : `${row.callSuccessRate}%` }}
          </template>
        </el-table-column>
        <el-table-column label="消息/会话" width="110" align="right" class-name="hide-on-mobile">
          <template #default="{ row }">
            {{ row.sessionCount ? (row.messageCount / row.sessionCount).toFixed(1) : '-' }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="100" class-name="hide-on-mobile">
          <template #default="{ row }">
            <button class="linkish" type="button" @click="go(`/llm-calls?agentId=${row.agentId}`)">调用流水</button>
          </template>
        </el-table-column>
      </el-table>
      <ResponsivePagination
        class="pagination"
        :current-page="page"
        :page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        @current-change="(value: number) => emit('current-change', value)"
        @size-change="(value: number) => emit('size-change', value)"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import BaseChart from '../../../components/BaseChart.vue'
import ResponsivePagination from '../../../components/ResponsivePagination.vue'
import { CHART_PALETTE } from '../../../utils/echarts'
import { formatCost, formatNumber, formatTokens, rankBarOption, type RankItem } from '../chart-options'
import { exportCsv } from '../utils/csv'
import type { AgentsPayload } from '../types'
import { withDrilldownPeriod } from '../utils/drilldown'

const props = defineProps<{ payload: AgentsPayload | null; loading?: boolean }>()
const emit = defineEmits<{
  (e: 'current-change', value: number): void
  (e: 'size-change', value: number): void
}>()
const router = useRouter()

const agentStats = computed(() => props.payload?.agentStats || [])
const total = computed(() => props.payload?.pagination?.total ?? agentStats.value.length)
const page = computed(() => props.payload?.pagination?.page ?? 1)
const pageSize = computed(() => props.payload?.pagination?.pageSize ?? 20)
// Token 排行用后端独立截断的 tokenTop：agentStats 按会话/消息数截断，直接重排会遗漏 Token 重的 Agent
const tokenItems = computed<RankItem[]>(() =>
  (props.payload?.tokenTop || [])
    .map((row) => ({ name: row.agentName || '未知', value: Number(row.totalTokens || 0) }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
)

function go(path: string) {
  router.push(withDrilldownPeriod(path, props.payload?.period))
}

function exportRows() {
  exportCsv(
    `analytics-agents-${new Date().toISOString().slice(0, 10)}.csv`,
    ['Agent', '会话', '消息', 'Token', '调用', '成本', '成功率', '消息/会话'],
    agentStats.value.map((row) => [
      row.agentName || '未知',
      row.sessionCount,
      row.messageCount,
      row.totalTokens,
      row.callCount ?? 0,
      row.cost ?? '',
      row.callSuccessRate == null ? '' : `${row.callSuccessRate}%`,
      row.sessionCount ? (row.messageCount / row.sessionCount).toFixed(1) : ''
    ])
  )
}
</script>

<script lang="ts">
export default { name: 'AgentTab' }
</script>

<style scoped>
.block {
  margin-bottom: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.card-hint {
  font-size: 12px;
  color: var(--mao-muted);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.pagination {
  margin-top: 12px;
  justify-content: flex-end;
}

.linkish {
  padding: 0;
  border: none;
  background: none;
  color: var(--mao-accent);
  font: inherit;
  cursor: pointer;
}

.linkish:hover {
  text-decoration: underline;
}
</style>
