import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useGitRepos } from './useGitRepos'
import type { WorkspaceGitProvider } from './workspace-git-provider'
import type { GitReposResult } from '../types/git'

function provider(getRepos: () => Promise<GitReposResult>) {
  return { getRepos: vi.fn(getRepos) } as unknown as WorkspaceGitProvider
}

function repos(paths: string[]): GitReposResult {
  return {
    isRootGit: false,
    repos: paths.map(path => ({
      name: path,
      path,
      changedFileCount: 0,
      insertions: 0,
      deletions: 0,
    })),
  }
}

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('useGitRepos 请求就绪', () => {
  it('初始扫描与 provider 切换扫描完成前暂停按仓库请求', async () => {
    let releaseFirst: (value: GitReposResult) => void = () => {}
    const first = provider(() => new Promise(resolve => { releaseFirst = resolve }))
    const providerRef = ref<WorkspaceGitProvider | null>(first)
    const state = useGitRepos(providerRef)

    expect(state.ready.value).toBe(false)
    expect(state.requestReady.value).toBe(false)
    releaseFirst(repos(['repo-a']))
    await settle()
    expect(state.ready.value).toBe(true)
    expect(state.requestReady.value).toBe(true)
    expect(state.selectedRepoPath.value).toBe('repo-a')

    let releaseSecond: (value: GitReposResult) => void = () => {}
    providerRef.value = provider(() => new Promise(resolve => { releaseSecond = resolve }))
    expect(state.repos.value).toEqual([])
    expect(state.selectedRepoPath.value).toBe('')
    expect(state.requestReady.value).toBe(false)

    releaseSecond(repos(['repo-b']))
    await settle()
    expect(state.requestReady.value).toBe(true)
    expect(state.selectedRepoPath.value).toBe('repo-b')
  })

  it('首次扫描失败后保持暂停，重试请求在途期间仍不可发请求，成功才恢复', async () => {
    let attempts = 0
    let releaseRetry: (value: GitReposResult) => void = () => {}
    const p = provider(() => {
      attempts += 1
      if (attempts === 1) return Promise.resolve({ isRootGit: false, repos: [], error: '扫描失败' })
      return new Promise(resolve => { releaseRetry = resolve })
    })
    const state = useGitRepos(ref(p))
    await settle()

    expect(state.error.value).toBe('扫描失败')
    expect(state.ready.value).toBe(true)
    expect(state.requestReady.value).toBe(false)

    const retry = state.refresh()
    await nextTick()
    // refresh 清空 error 不能使没有旧仓库的失败态提前恢复，否则会按裸 provider 误发根请求。
    expect(state.loading.value).toBe(true)
    expect(state.ready.value).toBe(false)
    expect(state.requestReady.value).toBe(false)

    releaseRetry(repos(['repo-a']))
    await retry
    expect(state.error.value).toBe('')
    expect(state.ready.value).toBe(true)
    expect(state.requestReady.value).toBe(true)
    expect(state.selectedRepoPath.value).toBe('repo-a')
  })

  it('同一 provider 刷新失败保留旧仓库与选中路径，并可用错误态重试', async () => {
    let fail = false
    const p = provider(async () => {
      if (fail) throw new Error('扫描暂时失败')
      return repos(['repo-a', 'repo-b'])
    })
    const state = useGitRepos(ref(p))
    await settle()
    state.selectRepo('repo-b')
    fail = true

    await state.refresh()
    expect(state.repos.value.map(repo => repo.path)).toEqual(['repo-a', 'repo-b'])
    expect(state.selectedRepoPath.value).toBe('repo-b')
    expect(state.error.value).toBe('扫描暂时失败')
    expect(state.requestReady.value).toBe(true)

    fail = false
    await state.refresh()
    expect(state.error.value).toBe('')
    expect(state.requestReady.value).toBe(true)
  })

  it('同一 provider 返回 error 且空数组时保留已识别仓库与选中路径', async () => {
    let failed = false
    const p = provider(async () => {
      if (failed) return { isRootGit: false, repos: [], error: '扫描 Git 仓库失败' }
      return repos(['repo-a', 'repo-b'])
    })
    const state = useGitRepos(ref(p))
    await settle()
    state.selectRepo('repo-b')
    failed = true

    await state.refresh()

    expect(state.repos.value.map(repo => repo.path)).toEqual(['repo-a', 'repo-b'])
    expect(state.selectedRepoPath.value).toBe('repo-b')
    expect(state.error.value).toBe('扫描 Git 仓库失败')
    expect(state.requestReady.value).toBe(true)
  })

  it('root git 与 nongit 扫描完成后允许无 repoPath 的根目录状态请求', async () => {
    const root = provider(async () => ({ isRootGit: true, repos: [] }))
    const rootState = useGitRepos(ref(root))
    await settle()
    expect(rootState.ready.value).toBe(true)
    expect(rootState.requestReady.value).toBe(true)
    expect(rootState.selectedRepoPath.value).toBe('')

    const nongit = provider(async () => ({ isRootGit: false, repos: [] }))
    const nongitState = useGitRepos(ref(nongit))
    await settle()
    expect(nongitState.ready.value).toBe(true)
    expect(nongitState.requestReady.value).toBe(true)
  })
})
