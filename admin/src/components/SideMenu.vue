<template>
  <div class="side-menu-wrap" :class="{ 'is-collapsed': collapsed }">
    <div v-if="showLogo" class="logo" @click="goHome">
      <img class="logo-img" :src="logoSrc" alt="" />
      <div v-if="!collapsed" class="logo-text">
        <strong>Mao</strong>
        <span>管理后台</span>
      </div>
    </div>

    <el-menu
      :default-active="activeMenu"
      :collapse="collapsed"
      :collapse-transition="false"
      router
      class="sidebar-menu"
      @select="onSelect"
    >
      <template v-for="group in visibleGroups" :key="group.id">
        <el-menu-item
          v-if="group.items.length === 1 && !group.label"
          :index="group.items[0].index"
        >
          <el-icon><component :is="group.items[0].icon" /></el-icon>
          <template #title>{{ group.items[0].label }}</template>
        </el-menu-item>
        <el-menu-item-group v-else :title="collapsed ? '' : group.label">
          <el-menu-item
            v-for="item in group.items"
            :key="item.index"
            :index="item.index"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <template #title>{{ item.label }}</template>
          </el-menu-item>
        </el-menu-item-group>
      </template>
    </el-menu>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useMenuStore } from '../stores/menu'
import { pickHomePath } from '../utils/home'
import { applyMenuVisibility, menuGroups, type MenuItemDef } from '../utils/menuNav'

withDefaults(
  defineProps<{
    showLogo?: boolean
    collapsed?: boolean
  }>(),
  { showLogo: true, collapsed: false }
)

const emit = defineEmits<{
  (e: 'select'): void
}>()

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const menuStore = useMenuStore()

const logoSrc = `${import.meta.env.BASE_URL}app-icon-small.png`

function canSee(item: MenuItemDef) {
  return !item.permission || authStore.hasPermission(item.permission)
}

// 权限过滤之上再叠加部署级可见性过滤（applyMenuVisibility 内部已剔除变空的分组）。
const visibleGroups = computed(() =>
  applyMenuVisibility(
    menuGroups
      .map(group => ({ ...group, items: group.items.filter(canSee) }))
      .filter(group => group.items.length > 0),
    menuStore.hidden
  )
)

const activeMenu = computed(() => {
  const seg = '/' + (route.path.split('/')[1] || '')
  return seg
})

function goHome() {
  const path = pickHomePath(
    (permission) => authStore.hasPermission(permission),
    (index) => menuStore.isHidden(index)
  )
  router.push(path === '/forbidden' ? '/login' : path)
  emit('select')
}

function onSelect() {
  emit('select')
}
</script>

<style scoped>
.side-menu-wrap {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--mao-surface);
}

.logo {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px;
  color: var(--mao-ink);
  cursor: pointer;
  flex-shrink: 0;
}

.is-collapsed .logo {
  justify-content: center;
  padding: 0;
}

.logo-img {
  width: 28px;
  height: 28px;
  border-radius: 7px;
}

.logo-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.logo-text strong {
  font-size: 15px;
  font-weight: 600;
}

.logo-text span {
  font-size: 11px;
  color: var(--mao-muted);
}

.sidebar-menu {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  border-right: none;
  background: var(--mao-surface);
}

.sidebar-menu:not(.el-menu--collapse) {
  width: 100%;
}

.sidebar-menu :deep(.el-menu-item-group__title) {
  color: var(--mao-muted);
  font-size: 11px;
  letter-spacing: 0.04em;
  padding: 16px 20px 6px;
  line-height: 1;
}

.is-collapsed .sidebar-menu :deep(.el-menu-item-group__title) {
  display: none;
}

.sidebar-menu .el-menu-item {
  color: var(--mao-ink);
  margin: 0 8px;
  width: calc(100% - 16px);
  border-radius: 8px;
}

.sidebar-menu .el-menu-item:hover {
  background: var(--mao-canvas);
}

.sidebar-menu .el-menu-item.is-active {
  background: var(--mao-accent-bg);
  color: var(--mao-accent);
}

.is-collapsed .sidebar-menu .el-menu-item {
  margin: 0 8px;
  width: calc(100% - 16px);
  padding: 0 !important;
  justify-content: center;
}
</style>
