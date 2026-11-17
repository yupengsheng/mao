import {
  mkdirSync, mkdtempSync, symlinkSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync,
  openSync, closeSync, createReadStream, fstatSync, readlinkSync, renameSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ErrorCode } from '../common/error-code.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WorkspaceBrowseService } from './workspace-browse.service.js';
import { useTmpDir } from '../testing/tmp-dir.js';
import { inflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    closeSync: vi.fn(actual.closeSync),
    readlinkSync: vi.fn(actual.readlinkSync),
    createReadStream: vi.fn(actual.createReadStream),
  };
});

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

describe('WorkspaceBrowseService ZIP 下载', () => {
  afterEach(() => {
    vi.mocked(openSync).mockReset();
    vi.mocked(closeSync).mockReset();
    vi.mocked(readlinkSync).mockReset();
    vi.mocked(createReadStream).mockReset();
  });

  function layout() {
    const root = useTmpDir('mao-zip-multi-');
    const ws = join(root, 'workspace');
    mkdirSync(join(ws, 'docs', 'empty'), { recursive: true });
    writeFileSync(join(ws, 'a.txt'), 'alpha');
    writeFileSync(join(ws, 'docs', '说明.md'), '中文内容');
    return { root, ws, service: new WorkspaceBrowseService(new PathSandbox(root)) };
  }

  async function readArchive(result: Awaited<ReturnType<WorkspaceBrowseService['zipEntries']>>) {
    onTestFinished(() => rmSync(result.zipPath, { force: true }));
    const buffer = readFileSync(result.zipPath);
    expect(buffer.length).toBe(result.size);
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    expect(eocd).toBeGreaterThanOrEqual(0);
    const end = buffer.readUInt32LE(eocd + 16) + buffer.readUInt32LE(eocd + 12);
    let offset = buffer.readUInt32LE(eocd + 16);
    const entries: { name: string; data: string }[] = [];
    while (offset < end) {
      expect(buffer.readUInt32LE(offset)).toBe(0x02014b50);
      const nameLength = buffer.readUInt16LE(offset + 28);
      const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
      const local = buffer.readUInt32LE(offset + 42);
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const compressed = buffer.subarray(start, start + buffer.readUInt32LE(offset + 20));
      const data = buffer.readUInt16LE(offset + 10) === 8 ? inflateRawSync(compressed) : compressed;
      entries.push({ name, data: data.toString('utf8') });
      offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    }
    return entries;
  }

  it('混选文件 / 目录平铺为一个 ZIP，保留空目录及中文内容', async () => {
    const { service, ws } = layout();
    const result = await service.zipEntries(ws, ['a.txt', 'docs']);
    expect(result.fileName).toMatch(/^workspace-\d{8}-\d{4}\.zip$/);
    const entries = await readArchive(result);
    expect(entries).toEqual(expect.arrayContaining([
      { name: 'a.txt', data: 'alpha' },
      { name: 'docs/', data: '' },
      { name: 'docs/empty/', data: '' },
      { name: 'docs/说明.md', data: '中文内容' },
    ]));
    expect(entries).toHaveLength(4);
  });

  it('单目录原入口保持目录根和文件名，单文件下载仍不打包', async () => {
    const { service, ws } = layout();
    expect(service.downloadFile(ws, 'a.txt')).toMatchObject({ fileName: 'a.txt', size: 5, path: join(ws, 'a.txt') });
    const result = await service.zipDirectory(ws, 'docs');
    expect(result.fileName).toBe('docs.zip');
    expect((await readArchive(result)).map((e) => e.name)).toEqual(['docs/', 'docs/empty/', 'docs/说明.md']);
    const root = await service.zipDirectory(ws, '.');
    expect(root.fileName).toBe('workspace.zip');
    expect((await readArchive(root)).map((e) => e.name)).toContain('workspace/a.txt');
  });

  it('重复路径、解析后别名、祖先目录覆盖的子项只归档一次', async () => {
    const { service, ws } = layout();
    mkdirSync(join(ws, 'docs', '..notes'));
    writeFileSync(join(ws, 'docs', '..notes', 'x.txt'), 'x');
    const result = await service.zipEntries(ws, ['docs/说明.md', 'docs', 'docs/..notes', './a.txt', 'a.txt', 'docs']);
    const entries = await readArchive(result);
    expect(entries.filter((e) => e.name === 'a.txt')).toHaveLength(1);
    expect(entries.filter((e) => e.name === 'docs/说明.md')).toHaveLength(1);
    expect(entries.filter((e) => e.name === 'docs/..notes/x.txt')).toHaveLength(1);
    expect(entries.some((e) => e.name.startsWith('..notes/'))).toBe(false);
    const rootResult = await service.zipEntries(ws, ['.', 'docs', 'a.txt']);
    expect((await readArchive(rootResult)).filter((e) => e.name === 'workspace/a.txt')).toHaveLength(1);
  });

  it('跨目录同名根条目明确拒绝，包括文件与目录冲突', async () => {
    const { service, ws } = layout();
    mkdirSync(join(ws, 'other', 'a.txt'), { recursive: true });
    await expect(service.zipEntries(ws, ['a.txt', 'other/a.txt'])).rejects.toThrow(/重名/);
    writeFileSync(join(ws, 'other', '说明.md'), 'other');
    await expect(service.zipEntries(ws, ['docs/说明.md', 'other/说明.md'])).rejects.toThrow(/重名/);
  });

  it.each([undefined, null, 'a.txt', [], [''], ['   '], [null], [17], ['a'.repeat(4097)], Array(1001).fill('a.txt')].map((paths) => ({ paths })))(
    '拒绝缺失 / 非法 / 过长或过多选区 %#', async ({ paths }) => {
      const { service, ws } = layout();
      await expect(service.zipEntries(ws, paths as string[])).rejects.toHaveProperty('code');
    },
  );

  it.each(['../secret', 'docs/../../secret', '/etc/passwd', 'C:/windows', '..\\secret', '~/.ssh', 'nul\x00.txt'])('拒绝不安全输入 %s', async (path) => {
    const { service, ws } = layout();
    await expect(service.zipEntries(ws, ['a.txt', path])).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
  });

  it('任何一项缺失或非法都使整个选区失败，不因父目录已选而忽略', async () => {
    const { service, ws } = layout();
    await expect(service.zipEntries(ws, ['docs', 'docs/missing'])).rejects.toThrow(/文件不存在/);
    symlinkSync(join(ws, 'a.txt'), join(ws, 'docs', 'link'));
    await expect(service.zipEntries(ws, ['docs', 'docs/link'])).rejects.toThrow(/不是普通文件/);
  });

  it('拒绝选中链接 / 链接逃逸，目录内部链接跳过且不跟随环路', async () => {
    const { service, ws, root } = layout();
    writeFileSync(join(root, 'secret'), 'secret');
    symlinkSync(join(root, 'secret'), join(ws, 'docs', 'leak'));
    symlinkSync(join(ws, 'docs'), join(ws, 'docs', 'loop'), 'dir');
    symlinkSync(root, join(ws, 'escape'), 'dir');
    await expect(service.zipEntries(ws, ['escape/secret'])).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    await expect(service.zipEntries(ws, ['docs/leak'])).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    const entries = await readArchive(await service.zipEntries(ws, ['a.txt', 'docs']));
    expect(entries.some((e) => /leak|loop/.test(e.name))).toBe(false);
  });

  it.each(['bad\\..\\escape.txt', 'C:drive.txt', 'bad\nname'])('递归条目的非法 ZIP 路径 %s 不会被 archiver 归一化后写入', async (name) => {
    const { service, ws } = layout();
    writeFileSync(join(ws, 'docs', name), 'bad');
    await expect(service.zipEntries(ws, ['docs'])).rejects.toThrow(/压缩包内路径不合法/);
  });

  it('保持合法空格和 shell 元字符原样，无 shell 命令执行', async () => {
    const { service, ws } = layout();
    const name = ' $(touch injected); a.txt ';
    writeFileSync(join(ws, name), 'literal');
    const entries = await readArchive(await service.zipEntries(ws, [name, 'a.txt']));
    expect(entries).toContainEqual({ name, data: 'literal' });
    expect(service.listDirectory(ws, '').entries.some((e) => e.name === 'injected')).toBe(false);
  });

  it('文件 / 目录混选总字节限额，重复项不重复计数；单目录原大小错误保留', async () => {
    const { service, ws } = layout();
    service.setMaxZipBytes(5);
    const single = await service.zipEntries(ws, ['a.txt', './a.txt']);
    expect((await readArchive(single)).map((e) => e.name)).toEqual(['a.txt']);
    await expect(service.zipEntries(ws, ['a.txt', 'docs'])).rejects.toThrow(/所选内容过大/);
    await expect(service.zipDirectory(ws, 'docs')).rejects.toThrow(/目录过大/);
  });

  it.each(['single', 'combined'])('同 inode 建流前增长 %s：按实际读取总字节拒绝超限并关闭 fd / 清理 ZIP', async (kind) => {
    const { service, ws } = layout();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    service.setMaxZipBytes(5);
    const paths = kind === 'single' ? ['a.txt'] : ['a.txt', 'b.txt'];
    if (kind === 'combined') {
      writeFileSync(join(ws, 'a.txt'), 'abc');
      writeFileSync(join(ws, 'b.txt'), 'de');
    }
    const growingPath = join(ws, paths.at(-1)!);
    const before = actual.statSync(growingPath);
    const sourceFds: number[] = [];
    let sizeBeforeAppend: number | undefined;
    vi.mocked(createReadStream).mockImplementation((path, options) => {
      const fd = (options as { fd: number }).fd;
      sourceFds.push(fd);
      if (path === growingPath) {
        // 服务已经完成 fstat 预检，但尚未读取；追加同 inode 而非替换文件。
        const opened = fstatSync(fd);
        sizeBeforeAppend = opened.size;
        expect(opened.ino).toBe(before.ino);
        expect(opened.dev).toBe(before.dev);
        appendFileSync(growingPath, 'x');
        expect(fstatSync(fd).ino).toBe(before.ino);
      }
      // 分块读取，既检查跨 chunk 累计，也检查 combined 的跨文件累计。
      return actual.createReadStream(path, { ...(options as object), highWaterMark: 2 });
    });
    await expect(service.zipEntries(ws, paths)).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID.code,
      message: expect.stringContaining('所选内容过大'),
    });
    expect(sizeBeforeAppend).toBe(kind === 'single' ? 5 : 2);
    expect(sourceFds).toHaveLength(paths.length);
    for (const fd of sourceFds) expect(() => fstatSync(fd)).toThrow();
    const zipPath = join(tmpdir(), `mao-workspace-${vi.mocked(randomUUID).mock.results.at(-1)!.value}.zip`);
    expect(existsSync(zipPath)).toBe(false);
  });

  it.each(['revoke', 'disappear'])('归档写入失败 %s：关闭输出后再返回 JSON 业务错误，清理临时 ZIP', async (failure) => {
    const { service, ws } = layout();
    type Resolver = { resolvePath(path: string, workspace: string, experience?: string | null): string };
    const resolver = service as unknown as Resolver;
    const original = resolver.resolvePath.bind(service);
    let calls = 0;
    // 第 1 次是选区检查，第 2 次是递归收集，第 3 次已经创建输出流、尚未入归档队列。
    const spy = vi.spyOn(resolver, 'resolvePath').mockImplementation((...args) => {
      const path = original(...args);
      if (++calls === 3) {
        if (failure === 'revoke') throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
        rmSync(path);
      }
      return path;
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => { spy.mockRestore(); warning.mockRestore(); });
    await expect(service.zipEntries(ws, ['a.txt'])).rejects.toMatchObject({
      code: failure === 'revoke' ? ErrorCode.FORBIDDEN.code : ErrorCode.INTERNAL_ERROR.code,
    });
    const zipPath = join(tmpdir(), `mao-workspace-${vi.mocked(randomUUID).mock.results.at(-1)!.value}.zip`);
    expect(existsSync(zipPath)).toBe(false);
  });

  it('祖先目录在路径校验后、open 前换成越界 symlink：按实际 fd 目标拒绝且关闭 fd / 清理 ZIP', async () => {
    const { service, ws, root } = layout();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '说明.md'), 'SECRET');
    let attackedFd: number | undefined;
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (path === join(ws, 'docs', '说明.md')) {
        renameSync(join(ws, 'docs'), join(ws, 'saved-docs'));
        symlinkSync(outside, join(ws, 'docs'), 'dir');
        attackedFd = actual.openSync(path, flags, mode);
        return attackedFd;
      }
      return actual.openSync(path, flags, mode);
    });
    await expect(service.zipEntries(ws, ['docs'])).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    expect(attackedFd).toBeTypeOf('number');
    expect(closeSync).toHaveBeenCalledWith(attackedFd);
    expect(() => fstatSync(attackedFd!)).toThrow();
    expect(createReadStream).not.toHaveBeenCalled();
    const zipPath = join(tmpdir(), `mao-workspace-${vi.mocked(randomUUID).mock.results.at(-1)!.value}.zip`);
    expect(existsSync(zipPath)).toBe(false);
  });

  it('fd 校验之后祖先再换成 symlink：归档只读取同一 fd 的原始内容而非秘密文件', async () => {
    const { service, ws, root } = layout();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, '说明.md'), 'SECRET');
    let swapped = false;
    vi.mocked(readlinkSync).mockImplementation((path, options) => {
      const target = actual.readlinkSync(path, options);
      if (!swapped && target === join(ws, 'docs', '说明.md')) {
        swapped = true;
        renameSync(join(ws, 'docs'), join(ws, 'saved-docs'));
        symlinkSync(outside, join(ws, 'docs'), 'dir');
      }
      return target;
    });
    const entries = await readArchive(await service.zipEntries(ws, ['docs/说明.md']));
    expect(swapped).toBe(true);
    expect(entries).toEqual([{ name: '说明.md', data: '中文内容' }]);
    const streamOptions = vi.mocked(createReadStream).mock.calls[0]![1]!;
    expect(streamOptions).toMatchObject({ fd: expect.any(Number), autoClose: true });
    expect(() => fstatSync((streamOptions as { fd: number }).fd)).toThrow();
  });

  it('团队经验 fd 检查只授权本次挂载：祖先替换成其他经验库也拒绝', async () => {
    const { service, ws, root } = layout();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const lib = join(root, 'experience');
    const other = join(root, 'other-experience');
    mkdirSync(join(lib, 'notes'), { recursive: true });
    mkdirSync(other);
    writeFileSync(join(lib, 'notes', 'entry.md'), 'allowed');
    writeFileSync(join(other, 'entry.md'), 'SECRET');
    symlinkSync(lib, join(ws, '团队经验'), 'dir');
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      if (path === join(ws, '团队经验', 'notes', 'entry.md')) {
        renameSync(join(lib, 'notes'), join(lib, 'saved-notes'));
        symlinkSync(other, join(lib, 'notes'), 'dir');
      }
      return actual.openSync(path, flags, mode);
    });
    await expect(service.zipEntries(ws, ['团队经验/notes/entry.md'], lib))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    expect(createReadStream).not.toHaveBeenCalled();
  });

  it('串行归档时最多持有一个源 fd，成功后全部关闭', async () => {
    const { service, ws } = layout();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    for (let i = 0; i < 128; i++) writeFileSync(join(ws, 'docs', `file-${i}.txt`), String(i));
    let active = 0;
    let maxActive = 0;
    const fds: number[] = [];
    vi.mocked(createReadStream).mockImplementation((path, options) => {
      const fd = (options as { fd: number }).fd;
      fds.push(fd);
      active++;
      maxActive = Math.max(maxActive, active);
      const stream = actual.createReadStream(path, options);
      stream.once('close', () => { active--; });
      return stream;
    });
    const entries = await readArchive(await service.zipEntries(ws, ['docs']));
    expect(entries).toHaveLength(131);
    expect(fds).toHaveLength(129);
    expect(maxActive).toBe(1);
    expect(active).toBe(0);
    for (const fd of fds) expect(() => fstatSync(fd)).toThrow();
  });

  it.each(['stream-create', 'stream-read', 'proc-unavailable'])('失败 %s 时关闭 fd，清理未完成 ZIP', async (failure) => {
    const { service, ws } = layout();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let fd: number | undefined;
    vi.mocked(openSync).mockImplementation((path, flags, mode) => {
      fd = actual.openSync(path, flags, mode);
      return fd;
    });
    if (failure === 'proc-unavailable') {
      vi.mocked(readlinkSync).mockImplementation(() => { throw new Error('proc unavailable'); });
    } else if (failure === 'stream-create') {
      vi.mocked(createReadStream).mockImplementation(() => { throw new Error('stream creation failed'); });
    } else {
      vi.mocked(createReadStream).mockImplementation((path, options) => {
        const stream = actual.createReadStream(path, options);
        queueMicrotask(() => stream.destroy(new Error('read failed')));
        return stream;
      });
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warning.mockRestore());
    await expect(service.zipEntries(ws, ['a.txt'])).rejects.toHaveProperty('code');
    expect(fd).toBeTypeOf('number');
    expect(() => fstatSync(fd!)).toThrow();
    const zipPath = join(tmpdir(), `mao-workspace-${vi.mocked(randomUUID).mock.results.at(-1)!.value}.zip`);
    expect(existsSync(zipPath)).toBe(false);
  });

  it('非 Linux 缺少 fd 目标验证能力时失败关闭，不回退按路径归档', async () => {
    const { service, ws } = layout();
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      await expect(service.zipEntries(ws, ['a.txt'])).rejects.toThrow(/当前平台不支持安全 ZIP 下载/);
      expect(openSync).not.toHaveBeenCalled();
      expect(createReadStream).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });

  it('授权团队经验可与工作区文件混选，未授权 / 改指向 / 库内越界链接仍拒绝', async () => {
    const { service, ws, root } = layout();
    const lib = join(root, 'experience');
    mkdirSync(lib);
    writeFileSync(join(lib, 'INDEX.md'), 'knowledge');
    symlinkSync(lib, join(ws, '团队经验'), 'dir');
    const entries = await readArchive(await service.zipEntries(ws, ['a.txt', '团队经验'], lib));
    expect(entries).toContainEqual({ name: '团队经验/INDEX.md', data: 'knowledge' });
    await expect(service.zipEntries(ws, ['团队经验/INDEX.md'])).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    symlinkSync(root, join(lib, 'leak'), 'dir');
    await expect(service.zipEntries(ws, ['团队经验/leak/secret'], lib)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    rmSync(join(ws, '团队经验'));
    symlinkSync(root, join(ws, '团队经验'), 'dir');
    await expect(service.zipEntries(ws, ['团队经验'], lib)).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
  });
});

describe('WorkspaceBrowseService.searchFiles', () => {
  let cleanup: (() => void) | null = null;

  function createService(): { service: WorkspaceBrowseService; ws: string } {
    const root = mkdtempSync(join(tmpdir(), 'mao-browse-search-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    const ws = join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    return { service: new WorkspaceBrowseService(new PathSandbox(root)), ws };
  }

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('recursivelyMatchesFileNamesCaseInsensitive', () => {
    const { service, ws } = createService();
    mkdirSync(join(ws, 'amber-acg', 'src', 'main'), { recursive: true });
    writeFileSync(join(ws, 'amber-acg', 'src', 'main', 'UserService.java'), 'x');
    writeFileSync(join(ws, 'README.md'), 'x');

    const result = service.searchFiles(ws, 'userservice', 100);
    expect(result.truncated).toBe(false);
    expect(result.entries.map((e) => e.path)).toEqual(['amber-acg/src/main/UserService.java']);
    expect(result.entries[0].size).toBe(1);
    // 结果 path 相对工作区根，workspaceRoot 供前端拼绝对路径（复制绝对路径）
    expect(result.workspaceRoot).toBe(resolve(ws));
  });

  it('skipsGitNodeModulesAndSymlinkedDirs', () => {
    const { service, ws } = createService();
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, '.git', 'config.lock'), 'x');
    mkdirSync(join(ws, 'app', 'node_modules'), { recursive: true });
    writeFileSync(join(ws, 'app', 'node_modules', 'left-pad.js'), 'x');
    mkdirSync(join(ws, 'app', 'real'), { recursive: true });
    writeFileSync(join(ws, 'app', 'real', 'config.lock'), 'x');
    mkdirSync(join(ws, 'linked-target'), { recursive: true });
    writeFileSync(join(ws, 'linked-target', 'config.lock'), 'x');
    symlinkSync(join(ws, 'linked-target'), join(ws, 'linked'));

    // 符号链接本身不进入遍历（无 linked/config.lock），但真实目录 linked-target 正常搜索
    const result = service.searchFiles(ws, 'config.lock', 100);
    expect(result.entries.map((e) => e.path)).toEqual(['app/real/config.lock', 'linked-target/config.lock']);
    expect(result.entries.some((e) => e.path.startsWith('linked/'))).toBe(false);
  });

  it('marksTruncatedWhenResultLimitReached', () => {
    const { service, ws } = createService();
    for (let i = 0; i < 5; i++) writeFileSync(join(ws, `report-${i}.txt`), 'x');

    const result = service.searchFiles(ws, 'report', 3);
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('returnsEmptyForNoMatch', () => {
    const { service, ws } = createService();
    writeFileSync(join(ws, 'a.txt'), 'x');
    const result = service.searchFiles(ws, 'zzz-not-exist', 100);
    expect(result.entries).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('rejectsBlankPattern', () => {
    const { service, ws } = createService();
    expect(() => service.searchFiles(ws, '   ', 100)).toThrow();
  });
});

describe('WorkspaceBrowseService.listDirectory', () => {
  let cleanup: (() => void) | null = null;

  function createService(): { service: WorkspaceBrowseService; ws: string } {
    const root = mkdtempSync(join(tmpdir(), 'mao-browse-list-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    const ws = join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    return { service: new WorkspaceBrowseService(new PathSandbox(root)), ws };
  }

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('returnsMtimeMsForEntries', () => {
    const { service, ws } = createService();
    writeFileSync(join(ws, 'a.txt'), 'x');
    mkdirSync(join(ws, 'sub'));

    const result = service.listDirectory(ws, '');
    const file = result.entries.find((e) => e.name === 'a.txt');
    const dir = result.entries.find((e) => e.name === 'sub');
    expect(file?.mtimeMs).toBeGreaterThan(0);
    expect(dir?.mtimeMs).toBeGreaterThan(0);
    expect(file?.size).toBe(1);
    expect(dir?.isDirectory).toBe(true);
  });

  it('keepsSymlinkFlagAndSortsDirectoriesFirst', () => {
    const { service, ws } = createService();
    writeFileSync(join(ws, 'a.txt'), 'x');
    mkdirSync(join(ws, 'zdir'));
    symlinkSync(join(ws, 'a.txt'), join(ws, 'link.txt'));
    const result = service.listDirectory(ws, '');
    expect(result.entries.map((e) => e.name)).toEqual(['zdir', 'a.txt', 'link.txt']);
    expect(result.entries.find((e) => e.name === 'link.txt')?.isSymlink).toBe(true);
    expect(result.entries.find((e) => e.name === 'zdir')?.isSymlink).toBe(false);
  });

  it('returnsWorkspaceRootAsAbsolutePathOfSessionWorkspace', () => {
    const { service, ws } = createService();
    writeFileSync(join(ws, 'a.txt'), 'x');
    const result = service.listDirectory(ws, '');
    expect(result.workspaceRoot).toBe(resolve(ws));
    // 子目录同样以工作区根为基准，不随 dir 参数漂移
    mkdirSync(join(ws, 'sub'));
    expect(service.listDirectory(ws, 'sub').workspaceRoot).toBe(resolve(ws));
  });
});

describe('WorkspaceBrowseService experience mount', () => {
  let cleanup: (() => void) | null = null;

  function layout() {
    const root = mkdtempSync(join(tmpdir(), 'mao-browse-exp-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    const ws = join(root, 'ws');
    const lib = join(root, 'share', 'agent-experience', '9');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(lib, { recursive: true });
    mkdirSync(ws, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(lib, 'INDEX.md'), '# index\n');
    writeFileSync(join(lib, '2026-11-02-note.md'), 'note body');
    writeFileSync(join(elsewhere, 'secret.txt'), 'nope');
    symlinkSync(lib, join(ws, '团队经验'), 'dir');
    symlinkSync(elsewhere, join(ws, 'leak'), 'dir');
    return { root, ws, lib, elsewhere, service: new WorkspaceBrowseService(new PathSandbox(root)) };
  }

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('listsReadsAndSearchesTheGrantedLibrary', async () => {
    const { service, ws, lib } = layout();
    const listing = service.listDirectory(ws, '', lib);
    expect(listing.readOnly).toBeUndefined();
    expect(listing.entries.find((e) => e.name === '团队经验')).toMatchObject({
      isDirectory: true,
      isSymlink: true,
      path: '团队经验',
    });

    const inside = service.listDirectory(ws, '团队经验', lib);
    expect(inside.readOnly).toBe(true);
    expect(inside.entries.map((e) => e.name).sort()).toEqual(['2026-11-02-note.md', 'INDEX.md']);

    const content = await service.readFile(ws, '团队经验/2026-11-02-note.md', 0, 20, lib);
    expect(content.content).toBe('note body');

    const found = service.searchFiles(ws, 'note', 20, lib);
    expect(found.entries.map((e) => e.path)).toContain('团队经验/2026-11-02-note.md');
    expect(found.entries.some((e) => e.path.startsWith('leak/'))).toBe(false);
  });

  it('rejectsOtherSymlinksAndARetargetedMount', async () => {
    const { service, ws, lib, root } = layout();
    await expect(service.readFile(ws, 'leak/secret.txt', 0, 10, lib))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    await expect(service.readFile(ws, '团队经验/../../elsewhere/secret.txt', 0, 10, lib))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });

    rmSync(join(ws, '团队经验'));
    const hijacked = join(root, 'hijacked');
    mkdirSync(hijacked);
    writeFileSync(join(hijacked, 'x.md'), 'x');
    symlinkSync(hijacked, join(ws, '团队经验'), 'dir');

    await expect(service.readFile(ws, '团队经验/x.md', 0, 10, lib))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    const listing = service.listDirectory(ws, '', lib);
    expect(listing.entries.find((e) => e.name === '团队经验')?.isDirectory).toBe(false);
  });

  it('without a grant the mount stays forbidden', async () => {
    const { service, ws } = layout();
    await expect(service.readFile(ws, '团队经验/INDEX.md', 0, 10))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    const listing = service.listDirectory(ws, '');
    expect(listing.entries.find((e) => e.name === '团队经验')?.isDirectory).toBe(false);
  });
});
