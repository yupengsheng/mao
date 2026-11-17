import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { createCloudProvider, createLocalProvider, createOwnedWorkspaceProvider, createProjectProvider, useWorkspaceFileProvider } from './workspace-file-provider'

const apiGet = vi.fn()
vi.mock('../api', () => ({
  api: {
    get: (url: string, config?: unknown) => apiGet(url, config),
  },
}))
vi.mock('../utils/auth-storage', () => ({
  getToken: () => 'test-token',
}))

function mockApiGet(data: unknown) {
  apiGet.mockReset()
  apiGet.mockImplementation(async () => ({ data }))
}

beforeEach(() => {
  apiGet.mockReset()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  delete (globalThis as any).window
  vi.unstubAllGlobals()
})

describe('合并 ZIP 下载', () => {
  function stubDownloadDom() {
    vi.useFakeTimers()
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => anchor),
      body: { appendChild: vi.fn() },
    })
    vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:zip'), revokeObjectURL: vi.fn() })
    return anchor
  }

  it.each(['cloud', 'owned'] as const)('%s：一次 POST、一次保存，使用 UTF-8 文件名且延迟释放 URL', async (mode) => {
    const anchor = stubDownloadDom()
    const blob = new Blob(['zip'], { type: 'application/zip' })
    const fetchMock = vi.fn(async () => new Response(blob, {
      headers: { 'Content-Disposition': `attachment; filename="fallback.zip"; filename*=UTF-8''${encodeURIComponent('工作区-20261117-1000.zip')}` },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const root = '/workspace/7/projects/a b'
    const provider = mode === 'cloud' ? createCloudProvider('42') : createOwnedWorkspaceProvider(root)
    expect(await provider.downloadEntriesZip!(['a b.txt', '文档'], 'selected.zip')).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(`/files/${mode === 'cloud' ? 'workspace' : 'owned'}-download-multi-zip`)
    expect(url).not.toContain('?')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ Authorization: 'Bearer test-token', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({
      ...(mode === 'cloud' ? { sessionId: 42 } : { root }), paths: ['a b.txt', '文档'],
    })
    expect(anchor.download).toBe('工作区-20261117-1000.zip')
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(anchor.remove).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(999)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:zip')
  })

  it.each([
    ['attachment; filename="plain.zip"', 'plain.zip'],
    [null, 'selected.zip'],
    ["attachment; filename*=UTF-8''%zz", 'selected.zip'],
  ])('Content-Disposition %s：兼容普通文件名和回退', async (disposition, expected) => {
    const anchor = stubDownloadDom()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['zip']), {
      headers: disposition ? { 'Content-Disposition': disposition } : {},
    })))
    expect((await createCloudProvider('42').downloadEntriesZip!(['a'], 'selected.zip')).ok).toBe(true)
    expect(anchor.download).toBe(expected)
  })

  it.each([200, 403, 413, 500])('HTTP %s JSON 错误不会触发下载', async (status) => {
    const anchor = stubDownloadDom()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 3001, message: '打包失败' }), {
      status, headers: { 'Content-Type': 'application/json' },
    })))
    expect(await createCloudProvider('42').downloadEntriesZip!(['a'], 'selected.zip'))
      .toEqual({ ok: false, error: '打包失败' })
    expect(anchor.click).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('HTTP 文本错误 / 网络异常返回可理解提示', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockRejectedValueOnce(new Error('network unavailable'))
    vi.stubGlobal('fetch', fetchMock)
    const provider = createCloudProvider('42')
    expect(await provider.downloadEntriesZip!(['a'], 'selected.zip')).toEqual({ ok: false, error: '下载失败（HTTP 502）' })
    expect(await provider.downloadEntriesZip!(['a'], 'selected.zip')).toEqual({ ok: false, error: 'network unavailable' })
  })

  it('LOCAL / 项目无下载能力，未就绪会话返回错误且不发送请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const provider of [createLocalProvider('/tmp/ws'), createProjectProvider('demo')]) {
      expect(provider.downloadEntriesZip).toBeUndefined()
      expect(provider.downloadDirectory).toBeUndefined()
      expect(provider.downloadFile).toBeUndefined()
    }
    expect(await createCloudProvider('invalid').downloadEntriesZip!(['a'], 'selected.zip'))
      .toEqual({ ok: false, error: '会话未就绪' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['cloud', 'owned'] as const)('%s 单文件 / 目录仍走原 GET，JSON 文件附件不会误报业务错误', async (mode) => {
    const anchor = stubDownloadDom()
    const fetchMock = vi.fn(async () => new Response('{"hello":true}', {
      headers: { 'Content-Disposition': 'attachment; filename="data.json"', 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = mode === 'cloud' ? createCloudProvider('42') : createOwnedWorkspaceProvider('/workspace/7/demo')
    expect((await provider.downloadFile!('a b.json', 'file.json')).ok).toBe(true)
    expect((await provider.downloadDirectory!('docs', 'docs')).ok).toBe(true)
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls[0]![0]).toContain(`${mode === 'cloud' ? 'workspace' : 'owned'}-download?`)
    expect(calls[0]![0]).toContain('path=a%20b.json')
    expect(calls[1]![0]).toContain('-download-zip?')
    expect(calls.every(([, init]) => !init.method)).toBe(true)
    expect(anchor.click).toHaveBeenCalledTimes(2)
    expect(anchor.download).toBe('data.json')
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
})

describe('useWorkspaceFileProvider 分支序', () => {
  it('CLOUD 有会话：cloud provider，sessionId 透传', async () => {
    mockApiGet({ entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }], truncated: false })
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref('42'), ref('demo')).value
    expect(provider).not.toBeNull()
    const result = await provider!.listDirectory('')
    expect(apiGet).toHaveBeenCalledWith('/files/workspace-directory', {
      params: { sessionId: 42, dir: undefined },
    })
    expect(result.entries?.[0].name).toBe('a.txt')
  })

  it('CLOUD 无会话有项目：project provider，projectKey 透传', async () => {
    mockApiGet({ entries: [], truncated: false })
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref(''), ref('demo')).value
    expect(provider).not.toBeNull()
    await provider!.listDirectory('src')
    expect(apiGet).toHaveBeenCalledWith('/files/project-directory', {
      params: { projectKey: 'demo', dir: 'src' },
    })
  })

  it('CLOUD 无会话无项目：null', () => {
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref(''), ref('')).value
    expect(provider).toBeNull()
  })

  it('LOCAL 有 workspace：local provider 走 Electron IPC', async () => {
    const listDirectory = vi.fn(async () => ({ entries: [], truncated: false }))
    ;(globalThis as any).window = { electronAPI: { listDirectory } }
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref('/tmp/ws'), ref(''), ref('')).value
    expect(provider).not.toBeNull()
    await provider!.listDirectory('')
    expect(listDirectory).toHaveBeenCalledWith('/tmp/ws', '/tmp/ws')
  })

  it('LOCAL 无 workspace：null', () => {
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref(''), ref(''), ref('')).value
    expect(provider).toBeNull()
  })
})

describe('createProjectProvider', () => {
  it('readFile 走 project-read 并透传 offset/limit', async () => {
    mockApiGet({ content: 'hi', total_lines: 1, media_type: 'text' })
    const provider = createProjectProvider('demo')
    const result = await provider.readFile('a.txt', { offset: 10, limit: 20 })
    expect(apiGet).toHaveBeenCalledWith('/files/project-read', {
      params: { projectKey: 'demo', path: 'a.txt', offset: 10, limit: 20 },
    })
    expect(result.content).toBe('hi')
    expect(result.media_type).toBe('text')
  })

  it('searchFiles 走 project-search 并透传 pattern/limit', async () => {
    mockApiGet({ entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }], truncated: false })
    const provider = createProjectProvider('demo')
    const result = await provider.searchFiles('a', 50)
    expect(apiGet).toHaveBeenCalledWith('/files/project-search', {
      params: { projectKey: 'demo', pattern: 'a', limit: 50 },
    })
    expect(result.entries?.[0].name).toBe('a.txt')
  })

  it('接口抛错时返回 error 形状（useFileBrowser 错误节点兼容）', async () => {
    apiGet.mockReset()
    apiGet.mockImplementation(async () => { throw new Error('项目名称非法') })
    const provider = createProjectProvider('..')
    const dir = await provider.listDirectory('')
    expect(dir.error).toBe('项目名称非法')
    const file = await provider.readFile('a.txt')
    expect(file.error).toBe('项目名称非法')
    const search = await provider.searchFiles('a')
    expect(search.error).toBe('项目名称非法')
  })

  it('previewFile 走 project-preview 并带 Bearer token，返回 blob', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' })
    const fetchMock = vi.fn(async () => ({ ok: true, blob: async () => blob }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = createProjectProvider('demo')
    const result = await provider.previewFile!('docs/a b.pdf')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toContain('/files/project-preview?')
    expect(url).toContain('projectKey=demo')
    expect(url).toContain('path=docs%2Fa%20b.pdf')
    expect(init.headers.Authorization).toBe('Bearer test-token')
    expect(result.blob).toBe(blob)
  })

  it('previewFile 非 2xx 时返回 error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      headers: { get: () => 'application/json' },
      json: async () => ({ message: '项目名称非法' }),
    })))
    const provider = createProjectProvider('..')
    const result = await provider.previewFile!('a.pdf')
    expect(result.error).toBe('项目名称非法')
  })

  it('不实现下载能力（写与下载依附会话，无会话不可用）', () => {
    const provider = createProjectProvider('demo')
    expect(provider.downloadFile).toBeUndefined()
    expect(provider.downloadDirectory).toBeUndefined()
  })
})

describe('getAbsolutePath（复制绝对路径）', () => {
  it('CLOUD：目录拉取后以响应里的 workspaceRoot 为基准拼绝对路径', async () => {
    mockApiGet({
      entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }],
      truncated: false,
      workspaceRoot: '/opt/mao-data/workspace/42',
    })
    const provider = useWorkspaceFileProvider(ref('CLOUD'), ref(''), ref('42'), ref('demo')).value!
    // 拉取前无根可依：原样返回相对路径，不拼出错路径
    expect(provider.getAbsolutePath!('scripts/deploy.sh')).toBe('scripts/deploy.sh')
    await provider.listDirectory('scripts')
    expect(provider.getAbsolutePath!('scripts/deploy.sh')).toBe('/opt/mao-data/workspace/42/scripts/deploy.sh')
    // 搜索响应同样刷新根，路径语义与目录一致
    mockApiGet({ entries: [], truncated: false, workspaceRoot: '/opt/mao-data/workspace/42' })
    await provider.searchFiles('deploy')
    expect(provider.getAbsolutePath!('scripts/deploy.sh')).toBe('/opt/mao-data/workspace/42/scripts/deploy.sh')
  })

  it('project：以 project-directory 响应里的 workspaceRoot 为基准（新建态无会话也可用）', async () => {
    mockApiGet({ entries: [], truncated: false, workspaceRoot: '/opt/mao-data/workspace/7/projects/demo' })
    const provider = createProjectProvider('demo')
    expect(provider.getAbsolutePath!('src/main.ts')).toBe('src/main.ts')
    await provider.listDirectory('src')
    expect(provider.getAbsolutePath!('src/main.ts')).toBe('/opt/mao-data/workspace/7/projects/demo/src/main.ts')
  })

  it('LOCAL：以 Electron 选中的 workspace 拼绝对路径（行为不变）', async () => {
    ;(globalThis as any).window = { electronAPI: { listDirectory: vi.fn(async () => ({ entries: [], truncated: false })) } }
    const provider = useWorkspaceFileProvider(ref('LOCAL'), ref('/tmp/ws'), ref(''), ref('')).value!
    expect(provider.getAbsolutePath!('scripts/deploy.sh')).toBe('/tmp/ws/scripts/deploy.sh')
  })
})
