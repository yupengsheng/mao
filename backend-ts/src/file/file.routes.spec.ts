import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerFileRoutes } from './file.routes.js';
import type { FileService } from './file.service.js';
import { WorkspaceBrowseService } from './workspace-browse.service.js';
import type { WorkspaceGitService } from './workspace-git.service.js';
import type { GitCommitMessageService } from './git-commit-message.service.js';
import type { GitWriteOperationService } from './git-write-operation.service.js';
import type { SessionService } from '../session/session.service.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { WorkspaceWriteService } from './workspace-write.service.js';
import { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../testing/tmp-dir.js';
import { WorkspaceOverviewService } from './workspace-overview.service.js';
import { PathSandbox as TestPathSandbox } from '../harness/safety/path-sandbox.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

describe('multi ZIP file routes', () => {
  function setup() {
    const root = useTmpDir('mao-route-multi-zip-');
    const workspace = join(root, '7', 'projects', 'demo');
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'a.txt'), 'a');
    writeFileSync(join(workspace, 'docs', '说明.md'), 'hello');
    const pathSandbox = new TestPathSandbox(root);
    const service = new WorkspaceBrowseService(pathSandbox);
    const zip = vi.spyOn(service, 'zipEntries');
    const participated = vi.fn(async () => false);
    const overview = new WorkspaceOverviewService(pathSandbox, { existsSessionUnderWorkspace: participated } as never);
    const session = { id: 1, userId: 7, workspace, executionMode: 'CLOUD', agentId: 9 };
    const getSession = vi.fn(async (id: number) => {
      if (id !== 1) throw new BusinessException(ErrorCode.PARAM_INVALID, '会话不存在');
      return session;
    });
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-test-user'] !== 'anonymous') {
        request.userId = Number(request.headers['x-test-user'] ?? '7');
      }
    });
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService: { getSession } as unknown as SessionService,
      workspaceBrowseService: service,
      workspaceOverviewService: overview,
      workspaceGitService: {} as WorkspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService: {} as GitWriteOperationService,
      workspaceWriteService: {} as WorkspaceWriteService,
      pathSandbox,
      experienceDirForAgent: (agentId) => join(root, 'experience', String(agentId)),
    });
    onTestFinished(() => app.close());
    return { app, root, workspace, session, zip, getSession, participated };
  }

  it.each(['workspace', 'owned'])('%s：混选 POST 返回一个 ZIP / Content-Disposition，流结束删除临时文件', async (mode) => {
    const { app, workspace, zip, root } = setup();
    const payload = { ...(mode === 'workspace' ? { sessionId: 1 } : { root: workspace }), paths: ['a.txt', 'docs'] };
    const response = await app.inject({ method: 'POST', url: `/v1/files/${mode}-download-multi-zip`, payload });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toMatch(/attachment; filename="demo-\d{8}-\d{4}\.zip"; filename\*=UTF-8''demo-/);
    expect(Number(response.headers['content-length'])).toBe(response.rawPayload.length);
    expect(response.rawPayload.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip).toHaveBeenCalledTimes(1);
    expect(zip.mock.calls[0]).toEqual(mode === 'workspace'
      ? [workspace, ['a.txt', 'docs'], join(root, 'experience', '9')]
      : [workspace, ['a.txt', 'docs']]);
    const result = await zip.mock.results[0]!.value;
    await vi.waitFor(() => expect(existsSync(result.zipPath)).toBe(false));
  });

  it('workspace：中文工作区名通过 RFC 5987 Content-Disposition 传递，错误不留下下载头', async () => {
    const { app, root, session, zip } = setup();
    session.workspace = join(root, '7', 'projects', '中文项目');
    mkdirSync(session.workspace, { recursive: true });
    writeFileSync(join(session.workspace, 'note.txt'), 'note');
    const response = await app.inject({ method: 'POST', url: '/v1/files/workspace-download-multi-zip', payload: { sessionId: 1, paths: ['note.txt'] } });
    const disposition = String(response.headers['content-disposition']);
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent('中文项目')}-`);
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    zip.mockRejectedValueOnce(new BusinessException(ErrorCode.INTERNAL_ERROR, '打包失败'));
    const error = await app.inject({ method: 'POST', url: '/v1/files/workspace-download-multi-zip', payload: { sessionId: 1, paths: ['note.txt'] } });
    expect(error.json().message).toBe('打包失败');
    expect(error.headers['content-disposition']).toBeUndefined();
  });

  it.each(['workspace', 'owned'])('%s：未认证 / 跨用户请求拒绝且不调用打包服务', async (mode) => {
    const { app, workspace, zip } = setup();
    const payload = { ...(mode === 'workspace' ? { sessionId: 1 } : { root: workspace }), paths: ['a.txt'] };
    const anonymous = await app.inject({ method: 'POST', url: `/v1/files/${mode}-download-multi-zip`, payload, headers: { 'x-test-user': 'anonymous' } });
    expect(anonymous.statusCode).toBe(401);
    const foreign = await app.inject({ method: 'POST', url: `/v1/files/${mode}-download-multi-zip`, payload, headers: { 'x-test-user': '8' } });
    expect(foreign.json().code).not.toBe(0);
    expect(foreign.headers['content-type']).toContain('application/json');
    expect(zip).not.toHaveBeenCalled();
  });

  it('LOCAL 会话服务端下载拒绝，不能用有效 sessionId 绕过能力边界', async () => {
    const { app, session, zip } = setup();
    session.executionMode = 'LOCAL';
    const response = await app.inject({ method: 'POST', url: '/v1/files/workspace-download-multi-zip', payload: { sessionId: 1, paths: ['a.txt'] } });
    expect(response.json().message).toContain('本地模式不支持');
    expect(zip).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0, -1, 1.5, '1', {}, Number.MAX_SAFE_INTEGER + 1])('无效 sessionId %# 返回 JSON 错误，不查询会话', async (sessionId) => {
    const { app, getSession, zip } = setup();
    const response = await app.inject({ method: 'POST', url: '/v1/files/workspace-download-multi-zip', payload: { sessionId, paths: ['a.txt'] } });
    expect(response.json().code).not.toBe(0);
    expect(getSession).not.toHaveBeenCalled();
    expect(zip).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'owned'])('%s：非法选区 / 逃逸 / 不存在 / 超限均返回 JSON，不发送 ZIP 响应头', async (mode) => {
    const { app, workspace } = setup();
    for (const paths of [undefined, null, 'a.txt', [], [false], [''], ['missing'], ['../secret'], Array(1001).fill('a.txt')]) {
      const response = await app.inject({
        method: 'POST', url: `/v1/files/${mode}-download-multi-zip`,
        payload: { ...(mode === 'workspace' ? { sessionId: 1 } : { root: workspace }), paths },
      });
      expect(response.json().code).not.toBe(0);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-disposition']).toBeUndefined();
    }
  });

  it('owned：非法 root / 本人根和 projects 容器均拒绝，不能任意指定目录', async () => {
    const { app, root, zip } = setup();
    for (const invalidRoot of [undefined, null, 7, {}, '', root, join(root, '7'), join(root, '7', 'projects'), '/etc', 'a'.repeat(4097)]) {
      const response = await app.inject({ method: 'POST', url: '/v1/files/owned-download-multi-zip', payload: { root: invalidRoot, paths: ['a.txt'] } });
      expect(response.json().code).not.toBe(0);
    }
    expect(zip).not.toHaveBeenCalled();
  });

  it('owned：受管群工作区沿用参与权限校验，不回落当前会话', async () => {
    const { app, root, participated, getSession } = setup();
    const channel = join(root, 'feishu-chat', 'cli_test', 'oc_group');
    mkdirSync(channel, { recursive: true });
    writeFileSync(join(channel, 'group.txt'), 'group');
    const options = { method: 'POST' as const, url: '/v1/files/owned-download-multi-zip', payload: { root: channel, paths: ['group.txt'] } };
    const denied = await app.inject(options);
    expect(denied.json().code).not.toBe(0);
    expect(participated).toHaveBeenCalled();
    participated.mockResolvedValue(true);
    const allowed = await app.inject(options);
    expect(allowed.headers['content-type']).toBe('application/zip');
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each(['workspace', 'owned'])('%s：body 超过 512KiB 和非法 JSON 以合理状态码返回 JSON', async (mode) => {
    const { app } = setup();
    const tooLarge = await app.inject({ method: 'POST', url: `/v1/files/${mode}-download-multi-zip`, payload: { paths: ['x'.repeat(512 * 1024)] } });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().code).not.toBe(0);
    const malformed = await app.inject({ method: 'POST', url: `/v1/files/${mode}-download-multi-zip`, payload: '{', headers: { 'content-type': 'application/json' } });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().code).not.toBe(0);
  });
});

describe('file routes', () => {
  it('listsWorkspaceAndGitJsonEndpoints', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(multipart);
    app.addHook('preHandler', (req, _r, done) => {
      const header = (req.headers['x-test-user'] ?? '7') as string;
      req.userId = Number(header) || 7;
      done();
    });
    const session = { id: 1, userId: 7, workspace: '/tmp/ws', agentId: 9 };
    const fileService = {
      listFiles: vi.fn(async () => [
        { id: 1, originalName: 'a.txt', storedName: 'x.txt', filePath: '/tmp/x.txt', fileSize: 1, uploaderId: 7, sessionId: 1 },
      ]),
      listWorkspaceFiles: vi.fn(() => [{ path: 'a.txt', name: 'a.txt', size: 1 }]),
      getFile: vi.fn(async () => null),
      deleteFile: vi.fn(),
      uploadFile: vi.fn(async () => ({
        id: 1, originalName: 'a.txt', storedName: 'x.txt', filePath: '/tmp/x.txt', fileSize: 1, sessionId: 1,
      })),
      uploadIncomingFile: vi.fn(async (bytes: Buffer, originalName: string, mime: string, userId: number, sessionId: number, incomingDir: string) => {
        const storedName = 'stored-' + originalName;
        mkdirSync(incomingDir, { recursive: true });
        const filePath = join(incomingDir, storedName);
        writeFileSync(filePath, bytes);
        return {
          id: 2, originalName, storedName, filePath, fileSize: bytes.length, mimeType: mime, sessionId,
        };
      }),
    } as unknown as FileService;
    const sessionService = { getSession: vi.fn(async () => session) } as unknown as SessionService;
    const workspaceBrowseService = {
      listDirectory: vi.fn(() => ({ entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }], truncated: false })),
      searchFiles: vi.fn(() => ({ entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }], truncated: false })),
      readFile: vi.fn(async () => ({ content: 'hi', total_lines: 1 })),
      readPdfFile: vi.fn(() => ({ path: join(root, 'preview.pdf'), fileName: 'preview.pdf', size: 4 })),
    } as unknown as WorkspaceBrowseService;
    const workspaceGitService = {
      listRepos: vi.fn(async () => ({ isRootGit: false, repos: [] })),
      getStatus: vi.fn(async () => ({ isGit: false })),
      getFileDiff: vi.fn(async () => ({ path: 'a', changeType: 'MODIFIED', beforeContent: '', afterContent: '' })),
    } as unknown as WorkspaceGitService;
    const gitWriteOperationService = {
      refreshRemoteStatus: vi.fn(async () => ({ isGit: true })),
      commit: vi.fn(async () => ({ success: true, operation: 'commit' })),
      pull: vi.fn(async () => ({ success: true, operation: 'pull' })),
      push: vi.fn(async () => ({ success: true, operation: 'push' })),
      generateCommitMessage: vi.fn(async () => ({ title: 'feat: x', message: 'feat: x\n\n- y' })),
      recordLocalActivity: vi.fn(),
    } as unknown as GitWriteOperationService;
    const gitCommitMessageService = {
      generate: vi.fn(async () => ({ title: 'feat: x', message: 'feat: x\n\n- y' })),
    } as unknown as GitCommitMessageService;
    const root = useTmpDir('mao-files-');
    mkdirSync(join(root, '7', 'projects', 'demo'), { recursive: true });
    writeFileSync(join(root, 'preview.pdf'), '%PDF');
    const runtimeDir = useTmpDir('mao-runtime-');
    const pathSandbox = { getWorkspaceRoot: () => root } as PathSandbox;
    const runtimeDataResolver = new RuntimeDataResolver(runtimeDir, join(root, 'home'));
    registerFileRoutes(app, {
      fileService, sessionService, workspaceBrowseService, workspaceGitService,
      gitCommitMessageService, gitWriteOperationService, pathSandbox, getUploadBaseUrl: async () => '',
      workspaceWriteService: {
        mkdir: vi.fn(), write: vi.fn(), rename: vi.fn(), move: vi.fn(), delete: vi.fn(), copy: vi.fn(), upload: vi.fn(),
      } as unknown as WorkspaceWriteService,
      runtimeDataResolver,
      experienceDirForAgent: (agentId: number) => `/share/agent-experience/${agentId}`,
    });
    const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body);
    const post = async (url: string, payload: object) => JSON.parse((await app.inject({ method: 'POST', url, payload })).body);
    const fileListVo = await get('/v1/files');
    expect(fileListVo.code).toBe(0);
    expect(Array.isArray(fileListVo.data)).toBe(true);
    expect(fileListVo.data[0]?.originalName).toBe('a.txt');
    expect((await get('/v1/files/workspace-list?sessionId=1')).data.files).toHaveLength(1);
    expect((await get('/v1/files/workspace-directory?sessionId=1')).code).toBe(0);
    expect(vi.mocked(workspaceBrowseService.listDirectory).mock.calls[0]?.[2]).toBe('/share/agent-experience/9');
    expect((await get('/v1/files/workspace-search?sessionId=1&pattern=a')).code).toBe(0);
    expect((await get('/v1/files/workspace-search?sessionId=1&pattern=a')).data.entries[0].name).toBe('a.txt');
    expect((await get('/v1/files/workspace-search?sessionId=1')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-read?sessionId=1&path=a.txt')).data.content).toBe('hi');
    expect((await get('/v1/files/workspace-git-repos?sessionId=1')).data.isRootGit).toBe(false);
    expect((await get('/v1/files/workspace-git-status?sessionId=1')).data.isGit).toBe(false);
    expect((await get('/v1/files/workspace-git-diff?sessionId=1&path=a')).data.path).toBe('a');
    expect((await post('/v1/files/workspace-git-refresh', { sessionId: 1 })).data.isGit).toBe(true);
    expect((await post('/v1/files/workspace-git-commit', { sessionId: 1 })).data.success).toBe(true);
    // 两步提交（中央 Tab）：传入用户消息直接提交 + 只生成接口
    expect((await post('/v1/files/workspace-git-commit', { sessionId: 1, message: 'wip 随手一改' })).data.success).toBe(true);
    expect(vi.mocked(gitWriteOperationService.commit).mock.calls[1][2]).toBe('wip 随手一改');
    expect((await post('/v1/files/workspace-git-commit-message', { sessionId: 1 })).data.title).toBe('feat: x');
    expect((await post('/v1/files/workspace-git-pull', { sessionId: 1 })).data.success).toBe(true);
    expect((await post('/v1/files/workspace-git-push', { sessionId: 1 })).data.success).toBe(true);
    expect((await post('/v1/files/git-commit-message', { sessionId: 1, changes: { files: [], diffBytes: 0 } })).data.title).toBe('feat: x');
    expect((await post('/v1/files/workspace-git-activity', { sessionId: 1, result: { operation: 'commit', success: true } })).code).toBe(0);
    expect((await get('/v1/files/project-list?projectKey=demo')).data.files).toHaveLength(1);

    // project 只读端点族（新建态无会话浏览）：happy path
    expect((await get('/v1/files/project-directory?projectKey=demo')).code).toBe(0);
    expect((await get('/v1/files/project-directory?projectKey=demo')).data.entries[0].name).toBe('a.txt');
    expect((await get('/v1/files/project-read?projectKey=demo&path=a.txt')).data.content).toBe('hi');
    expect((await get('/v1/files/project-search?projectKey=demo&pattern=a')).data.entries[0].name).toBe('a.txt');
    const previewRes = await app.inject({ method: 'GET', url: '/v1/files/project-preview?projectKey=demo&path=preview.pdf' });
    expect(previewRes.statusCode).toBe(200);

    // project 只读端点族：参数与越权防护
    expect((await get('/v1/files/project-directory')).code).not.toBe(0);
    expect((await get('/v1/files/project-directory?projectKey=..')).code).not.toBe(0);
    expect((await get('/v1/files/project-directory?projectKey=projects')).code).not.toBe(0);
    expect((await get('/v1/files/project-search?projectKey=demo')).code).not.toBe(0);
    expect((await get('/v1/files/project-read?projectKey=demo')).code).not.toBe(0);
    expect((await get('/v1/files/project-preview?projectKey=demo')).code).not.toBe(0);
    // 项目目录不存在（新项目名）：空列表而非错误
    expect((await get('/v1/files/project-directory?projectKey=ghost')).data.entries).toEqual([]);
    expect((await get('/v1/files/project-search?projectKey=ghost&pattern=a')).data.entries).toEqual([]);
    // 跨用户不泄漏：demo 位于用户 7 根下，用户 8 看到的是「不存在」
    const foreign = await app.inject({
      method: 'GET', url: '/v1/files/project-directory?projectKey=demo', headers: { 'x-test-user': '8' },
    });
    expect(JSON.parse(foreign.body).data.entries).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/files/99/download' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/v1/files/99' })).statusCode).toBe(200);

    // upload-incoming：文件需落到会话 runtime incoming 目录，并返回 absolutePath
    const incomingDir = runtimeDataResolver.resolveIncomingDir(7, 1);
    const uploadRes = await app.inject({
      method: 'POST',
      url: '/v1/files/upload-incoming',
      payload: (() => {
        const form = new FormData();
        form.append('sessionId', '1');
        form.append('file', new Blob([Buffer.from('hello incoming')], { type: 'text/plain' }), 'note.txt');
        return form;
      })(),
    });
    const uploadBody = JSON.parse(uploadRes.body);
    expect(uploadBody.code).toBe(0);
    expect(uploadBody.data.absolutePath.startsWith(incomingDir)).toBe(true);
    expect(existsSync(uploadBody.data.absolutePath)).toBe(true);
    expect(readFileSync(uploadBody.data.absolutePath, 'utf8')).toBe('hello incoming');

    // 无 sessionId 时拒绝
    const noSession = await app.inject({
      method: 'POST',
      url: '/v1/files/upload-incoming',
      payload: (() => {
        const form = new FormData();
        form.append('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'a.txt');
        return form;
      })(),
    });
    expect(JSON.parse(noSession.body).code).not.toBe(0);

    // 属主校验：他人访问文件下载/删除被拒
    vi.mocked(fileService.getFile).mockResolvedValue({
      id: 1, originalName: 'a.txt', storedName: 'x.txt', filePath: '/tmp/x.txt', fileSize: 1, uploaderId: 7, sessionId: 1,
    } as never);
    const foreignDownload = await app.inject({ method: 'GET', url: '/v1/files/1/download', headers: { 'x-test-user': '99' } });
    expect(JSON.parse(foreignDownload.body).code).not.toBe(0);
    const foreignDelete = await app.inject({ method: 'DELETE', url: '/v1/files/1', headers: { 'x-test-user': '99' } });
    expect(JSON.parse(foreignDelete.body).code).not.toBe(0);

    // 属主本人访问放行
    const ownerDelete = await app.inject({ method: 'DELETE', url: '/v1/files/1' });
    expect(JSON.parse(ownerDelete.body).code).toBe(0);

    await app.close();
  });

  it('rejects local sessions and workspace upload traversal', async () => {
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    const { join: jn } = await import('node:path');
    const { PathSandbox: Sandbox } = await import('../harness/safety/path-sandbox.js');
    const { WorkspaceWriteService: WriteService } = await import('./workspace-write.service.js');
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(multipart);
    app.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const root = useTmpDir('mao-route-write-');
    const workspace = jn(root, 'ws');
    mk(workspace, { recursive: true });
    wf(jn(workspace, 'keep.txt'), 'keep');
    const sessions = new Map<number, { id: number; userId: number; workspace: string; executionMode: string }>([
      [1, { id: 1, userId: 7, workspace, executionMode: 'CLOUD' }],
      [2, { id: 2, userId: 7, workspace, executionMode: 'LOCAL' }],
    ]);
    const sessionService = { getSession: vi.fn(async (id: number) => sessions.get(id)) } as unknown as SessionService;
    const recorded: unknown[] = [];
    const write = new WriteService(new Sandbox(root), { record: vi.fn(async (...args: unknown[]) => { recorded.push(args); return {}; }) } as never);
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService,
      workspaceBrowseService: {} as WorkspaceBrowseService,
      workspaceGitService: {} as WorkspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService: {} as GitWriteOperationService,
      workspaceWriteService: write,
      pathSandbox: new Sandbox(root),
      runtimeDataResolver: new RuntimeDataResolver(useTmpDir('mao-route-rt-'), jn(root, 'home')),
    });
    const local = await app.inject({ method: 'POST', url: '/v1/files/workspace-mkdir', payload: { sessionId: 2, path: 'a' } });
    expect(JSON.parse(local.body).message).toContain('本地模式不支持');
    const escaped = await app.inject({
      method: 'POST',
      url: '/v1/files/workspace-upload',
      payload: (() => {
        const form = new FormData();
        form.append('sessionId', '1');
        form.append('dir', '.');
        form.append('relativePath', '../keep.txt');
        form.append('file', new Blob([Buffer.from('pwn')], { type: 'text/plain' }), 'keep.txt');
        return form;
      })(),
    });
    expect(JSON.parse(escaped.body).code).toBe(2001);
    const { readFileSync: rf } = await import('node:fs');
    expect(rf(jn(workspace, 'keep.txt'), 'utf8')).toBe('keep');
    expect(recorded).toHaveLength(0);
    await app.close();
  });

  it('workspacePath mkdir writes that owned directory and rejects paths outside the user root', async () => {
    const { mkdirSync: mk, existsSync: ex } = await import('node:fs');
    const { join: jn } = await import('node:path');
    const { PathSandbox: Sandbox } = await import('../harness/safety/path-sandbox.js');
    const { WorkspaceWriteService: WriteService } = await import('./workspace-write.service.js');
    const { WorkspaceOverviewService } = await import('./workspace-overview.service.js');
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(multipart);
    app.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const root = useTmpDir('mao-owned-write-');
    const owned = jn(root, '7', 'proj');
    mk(owned, { recursive: true });
    const overview = new WorkspaceOverviewService(new Sandbox(root), {
      aggregateWorkspaceUsage: async () => new Map(),
      listActiveWorkspaceReferences: async () => [],
    } as never);
    const write = new WriteService(new Sandbox(root), { record: vi.fn(async () => ({})) } as never);
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService: { getSession: vi.fn() } as unknown as SessionService,
      workspaceBrowseService: {} as WorkspaceBrowseService,
      workspaceGitService: {} as WorkspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService: {} as GitWriteOperationService,
      workspaceWriteService: write,
      workspaceOverviewService: overview,
      pathSandbox: new Sandbox(root),
    });
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/files/workspace-mkdir',
      payload: { workspacePath: owned, path: 'nested' },
    });
    expect(JSON.parse(ok.body).code).toBe(0);
    expect(ex(jn(owned, 'nested'))).toBe(true);
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/files/workspace-mkdir',
      payload: { workspacePath: '/etc', path: 'x' },
    });
    expect(JSON.parse(denied.body).code).not.toBe(0);
    expect(ex('/etc/x')).toBe(false);
    await app.close();
  });

  it('gitManagerEndpointsRejectLocalSessionsAndMissingParams', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const sessions = new Map<number, { id: number; userId: number; workspace: string; executionMode: string }>([
      [1, { id: 1, userId: 7, workspace: '/tmp/ws-cloud', executionMode: 'CLOUD' }],
      [2, { id: 2, userId: 7, workspace: '/tmp/ws-local', executionMode: 'LOCAL' }],
    ]);
    const sessionService = { getSession: vi.fn(async (id: number) => sessions.get(id)) } as unknown as SessionService;
    const workspaceGitService = {
      getLog: vi.fn(async () => [{ hash: 'h', shortHash: 'h', title: 't', author: 'a', date: 'd' }]),
      getCommitFiles: vi.fn(async () => ({ hash: 'h', files: [] })),
      getCommitFileDiff: vi.fn(async () => ({ path: 'a', changeType: 'MODIFIED', beforeContent: '', afterContent: '' })),
      getBranches: vi.fn(async () => [{ name: 'main', isCurrent: true, isRemote: false }]),
      getStashes: vi.fn(async () => [{ ref: 'stash@{0}', message: 'm', date: 'd' }]),
      getRemotes: vi.fn(async () => [{ name: 'origin', fetchUrl: 'u', pushUrl: 'u' }]),
      compareBranches: vi.fn(async () => ({ base: 'main', target: 'feature', aheadCount: 1, behindCount: 0, files: [] })),
      compareBranchFileDiff: vi.fn(async () => ({ path: 'a', changeType: 'MODIFIED', beforeContent: '', afterContent: '' })),
    } as unknown as WorkspaceGitService;
    const gitWriteOperationService = {
      fetchRemote: vi.fn(async () => ({ success: true, operation: 'fetch', message: '远端已更新' })),
      switchBranch: vi.fn(async () => ({ success: true, operation: 'switch', branch: 'main' })),
      stashOp: vi.fn(async () => ({ success: true, operation: 'stash', message: '已应用 stash@{0}' })),
    } as unknown as GitWriteOperationService;
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService,
      workspaceBrowseService: {} as WorkspaceBrowseService,
      workspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService,
      workspaceWriteService: {} as WorkspaceWriteService,
      pathSandbox: { getWorkspaceRoot: () => '/tmp' } as PathSandbox,
      runtimeDataResolver: new RuntimeDataResolver(useTmpDir('mao-route-gitmgr-'), '/tmp/home'),
    });
    const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body);
    const post = async (url: string, payload: object) => JSON.parse((await app.inject({ method: 'POST', url, payload })).body);

    // 新端点族只服务 CLOUD：LOCAL 会话一律拒绝（LOCAL 走 Electron IPC）
    for (const url of [
      '/v1/files/workspace-git-log?sessionId=2',
      '/v1/files/workspace-git-commit?sessionId=2&hash=abc1234',
      '/v1/files/workspace-git-commit-file-diff?sessionId=2&hash=abc1234&path=a',
      '/v1/files/workspace-git-branches?sessionId=2',
      '/v1/files/workspace-git-stashes?sessionId=2',
      '/v1/files/workspace-git-remotes?sessionId=2',
      '/v1/files/workspace-git-branch-compare?sessionId=2&base=main&target=feature',
      '/v1/files/workspace-git-branch-compare-file-diff?sessionId=2&base=main&target=feature&path=a',
    ]) {
      const body = await get(url);
      expect(body.code).not.toBe(0);
      expect(body.message).toContain('本地模式不支持');
    }
    for (const [url, payload] of [
      ['/v1/files/workspace-git-fetch', { sessionId: 2 }],
      ['/v1/files/workspace-git-switch-branch', { sessionId: 2, branch: 'main' }],
      ['/v1/files/workspace-git-stash', { sessionId: 2, action: 'apply', ref: 'stash@{0}' }],
      ['/v1/files/workspace-git-commit-message', { sessionId: 2 }],
    ] as const) {
      const body = await post(url, payload);
      expect(body.code).not.toBe(0);
      expect(body.message).toContain('本地模式不支持');
    }

    // 缺 sessionId / 缺必填参数
    expect((await get('/v1/files/workspace-git-log')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-commit?sessionId=1')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-commit-file-diff?sessionId=1&hash=abc1234')).code).not.toBe(0);
    // 分支对比：base / target / path 逐个必填
    expect((await get('/v1/files/workspace-git-branch-compare?sessionId=1&base=main')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare?sessionId=1&target=feature')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare?sessionId=1')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&base=main&target=feature')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&base=main&path=a')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&target=feature&path=a')).code).not.toBe(0);
    expect((await post('/v1/files/workspace-git-switch-branch', { sessionId: 1 })).code).not.toBe(0);
    expect((await post('/v1/files/workspace-git-stash', { sessionId: 1, action: 'apply' })).code).not.toBe(0);
    expect((await post('/v1/files/workspace-git-stash', { sessionId: 1, ref: 'stash@{0}' })).code).not.toBe(0);

    // happy path：CLOUD 会话透传分页 / 哈希 / 分支 / stash 参数
    expect((await get('/v1/files/workspace-git-log?sessionId=1&limit=20&offset=10')).data[0].hash).toBe('h');
    expect(vi.mocked(workspaceGitService.getLog).mock.calls[0][2]).toEqual({ limit: 20, offset: 10, path: undefined });
    expect((await get('/v1/files/workspace-git-commit?sessionId=1&hash=abc1234')).data.hash).toBe('h');
    expect((await get('/v1/files/workspace-git-commit-file-diff?sessionId=1&hash=abc1234&path=a.txt')).data.path).toBe('a');
    // 改名提交：oldPath 作为可选查询参数透传（before 取自父提交的旧路径）
    expect((await get('/v1/files/workspace-git-commit-file-diff?sessionId=1&hash=abc1234&path=b.txt&oldPath=a.txt')).data.path).toBe('a');
    expect(vi.mocked(workspaceGitService.getCommitFileDiff).mock.calls.at(-1)).toEqual([expect.anything(), undefined, 'abc1234', 'b.txt', 'a.txt']);
    expect((await get('/v1/files/workspace-git-branches?sessionId=1')).data[0].name).toBe('main');
    // 分支对比：base / target / repoPath 透传（repoPath 只接受一级子目录名，服务内部校验）
    expect((await get('/v1/files/workspace-git-branch-compare?sessionId=1&base=main&target=feature&repoPath=demo')).data.aheadCount).toBe(1);
    expect(vi.mocked(workspaceGitService.compareBranches).mock.calls.at(-1)).toEqual([expect.anything(), 'demo', 'main', 'feature']);
    // 单文件 diff：path 必填、oldPath 可选（rename 行传旧路径，before 取 base 侧旧路径）
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&base=main&target=feature&path=b.txt')).data.path).toBe('a');
    expect(vi.mocked(workspaceGitService.compareBranchFileDiff).mock.calls.at(-1)).toEqual([expect.anything(), undefined, 'main', 'feature', 'b.txt', undefined]);
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&base=main&target=feature&path=b.txt&oldPath=a.txt')).code).toBe(0);
    expect(vi.mocked(workspaceGitService.compareBranchFileDiff).mock.calls.at(-1)).toEqual([expect.anything(), undefined, 'main', 'feature', 'b.txt', 'a.txt']);
    expect((await get('/v1/files/workspace-git-stashes?sessionId=1')).data[0].ref).toBe('stash@{0}');
    expect((await get('/v1/files/workspace-git-remotes?sessionId=1')).data[0].name).toBe('origin');
    expect((await post('/v1/files/workspace-git-fetch', { sessionId: 1 })).data.message).toBe('远端已更新');
    expect((await post('/v1/files/workspace-git-switch-branch', { sessionId: 1, branch: 'main', create: true })).data.branch).toBe('main');
    expect(vi.mocked(gitWriteOperationService.switchBranch).mock.calls[0][3]).toBe(true);
    expect((await post('/v1/files/workspace-git-stash', { sessionId: 1, action: 'pop', ref: 'stash@{0}' })).data.message).toBe('已应用 stash@{0}');

    await app.close();
  });
});
