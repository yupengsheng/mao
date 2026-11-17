import {
  closeSync, constants, createReadStream, createWriteStream, existsSync, fstatSync, lstatSync, openSync, readFileSync,
  readlinkSync, readSync, readdirSync, realpathSync, rmSync, statSync, type ReadStream, type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import archiver from 'archiver';
import sharp from 'sharp';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { utf8Prefix } from '../common/utf8.js';
import { EXPERIENCE_MOUNT_NAME } from '../harness/experience/experience-index.service.js';
import {
  experienceMountPointsAt,
  isExperienceMountRelative,
} from '../harness/experience/experience-mount-path.js';
import { ImageFileSupport } from '../harness/tool/image-file-support.js';
import { isUnder, PathSandbox, SecurityException } from '../harness/safety/path-sandbox.js';
import { StrictPathResolver } from '../harness/safety/strict-path.js';

const MAX_ENTRIES = 500;
/** 原始选区上限（去重前），避免恶意 body 导致大量同步解析 / 去重。 */
const MAX_ZIP_ENTRIES = 1000;
const MAX_ZIP_PATH_LENGTH = 4096;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_SCANNED_DIRS = 2000;
const MAX_SEARCH_DEPTH = 12;
/** 递归搜索时跳过的目录：体积大且不会是用户要找的业务文件 */
const SEARCH_EXCLUDED_DIRS = new Set(['.git', 'node_modules']);
const DEFAULT_READ_LIMIT = 5000;
const MAX_READ_LIMIT = 5000;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ZIP_BYTES = 1024 * 1024 * 1024;

export interface DirectoryEntryDTO {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  isSymlink: boolean;
  /** 修改时间（epoch ms），供前端按时间排序；搜索接口不返回 */
  mtimeMs?: number;
}

export interface DirectoryListingDTO {
  entries: DirectoryEntryDTO[];
  truncated: boolean;
  /** 工作区绝对根路径（服务端）：条目 path 是相对它的相对路径，供前端拼「复制绝对路径」 */
  workspaceRoot: string;
  /** 当前目录是本会话的团队经验挂载：文件管理只读。缺省表示可写。 */
  readOnly?: boolean;
}

export interface WorkspaceSearchDTO {
  entries: DirectoryEntryDTO[];
  truncated: boolean;
  /** 同 DirectoryListingDTO.workspaceRoot：搜索结果 path 的相对基准 */
  workspaceRoot: string;
}

export interface FileContentDTO {
  content: string;
  total_lines: number;
  media_type?: string;
  mime?: string;
  data_uri?: string;
}

export interface DownloadResult {
  path: string;
  size: number;
  fileName: string;
}

export interface ZipResult {
  zipPath: string;
  size: number;
  fileName: string;
}

interface ZipReadAccess {
  validatePath(path: string): void;
  validateFd(fd: number, path: string): Stats;
  maxBytes: number;
}

interface ZipSourceItem {
  /** 已过沙箱校验的文件 / 目录绝对路径。 */
  absPath: string;
  /** ZIP 内的根名称，不使用客户端提供的绝对路径。 */
  entryRoot: string;
}

export class WorkspaceBrowseService {
  private maxZipBytes = DEFAULT_MAX_ZIP_BYTES;

  constructor(private readonly pathSandbox: PathSandbox) {}

  setMaxZipBytes(bytes: number): void {
    this.maxZipBytes = bytes;
  }

  listDirectory(
    sessionWorkspace: string,
    relativeDir: string | null | undefined,
    experienceDir?: string | null,
  ): DirectoryListingDTO {
    const workspaceRoot = this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
    // 工作区根整体缺失（如被用户从工作区总览删除）在严格解析之前给出可理解文案——
    // StrictPathResolver 对缺失根抛 SecurityException「路径访问被拒绝」，用户无法理解（§4.1-4）
    if (!existsSync(sessionWorkspace)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '工作区目录不存在（可能已被删除）');
    }
    const dir = this.normalizeRelativeDir(relativeDir);
    const dirPath = this.resolvePath(dir, sessionWorkspace, experienceDir);
    if (!existsSync(dirPath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目录不存在');
    }
    if (!statSync(dirPath).isDirectory()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '不是目录');
    }
    const entries: DirectoryEntryDTO[] = [];
    let truncated = false;
    let children: string[];
    try {
      children = readdirSync(dirPath).sort((a, b) => a.localeCompare(b));
    } catch (e) {
      console.warn(`Failed to list directory: ${dirPath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取目录失败');
    }
    if (children.length > MAX_ENTRIES) {
      truncated = true;
    }
    for (const name of children) {
      if (entries.length >= MAX_ENTRIES) break;
      const child = join(dirPath, name);
      const entry: DirectoryEntryDTO = {
        name,
        path: relative(workspaceRoot, resolve(child)).replace(/\\/g, '/'),
        isSymlink: false,
        isDirectory: false,
        size: 0,
        mtimeMs: 0,
      };
      try {
        const lst = lstatSync(child);
        entry.isSymlink = lst.isSymbolicLink();
        entry.isDirectory = lst.isDirectory() && !entry.isSymlink;
        if (this.isGrantedExperienceMount(entry, sessionWorkspace, experienceDir)) {
          entry.isDirectory = true;
        }
        entry.size = lst.size;
        entry.mtimeMs = lst.mtimeMs;
      } catch {
        entry.size = 0;
      }
      entries.push(entry);
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'accent' });
    });
    const readOnly = this.isExperienceListing(dir, sessionWorkspace, experienceDir);
    return { entries, truncated, workspaceRoot, ...(readOnly ? { readOnly: true } : {}) };
  }

  /**
   * 按文件名递归搜索工作区文件（大小写不敏感子串匹配）。
   * 有界遍历：跳过 .git/node_modules 与符号链接，目录数/深度/结果数均有上限，
   * 超限时返回 truncated=true，避免大工作区拖垮请求。
   */
  searchFiles(
    sessionWorkspace: string,
    pattern: string,
    limit: number | null | undefined,
    experienceDir?: string | null,
  ): WorkspaceSearchDTO {
    if (pattern == null || pattern.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '搜索关键词不能为空');
    }
    const lower = pattern.trim().toLowerCase();
    const maxResults = Math.min(Math.max(limit ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
    const rootPath = this.resolvePath('.', sessionWorkspace);
    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '工作区不存在');
    }
    const entries: DirectoryEntryDTO[] = [];
    let truncated = false;
    let scanned = 0;
    const queue: { abs: string; rel: string; depth: number }[] = [{ abs: rootPath, rel: '', depth: 0 }];
    while (queue.length > 0) {
      if (entries.length >= maxResults || scanned >= MAX_SEARCH_SCANNED_DIRS) {
        truncated = true;
        break;
      }
      const cur = queue.shift()!;
      scanned++;
      let dirents;
      try {
        dirents = readdirSync(cur.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of dirents) {
        if (entries.length >= maxResults) {
          truncated = true;
          break;
        }
        let lst: Stats;
        try {
          lst = lstatSync(join(cur.abs, e.name));
        } catch {
          continue;
        }
        if (lst.isSymbolicLink()) {
          // 只跟随工作区根上、且确实指向本会话经验库的「团队经验」。库内其他链接仍跳过。
          if (
            cur.rel === ''
            && e.name === EXPERIENCE_MOUNT_NAME
            && experienceDir
            && experienceMountPointsAt(sessionWorkspace, experienceDir)
            && cur.depth < MAX_SEARCH_DEPTH
          ) {
            queue.push({ abs: join(cur.abs, e.name), rel: e.name, depth: cur.depth + 1 });
          }
          continue;
        }
        if (lst.isDirectory()) {
          if (SEARCH_EXCLUDED_DIRS.has(e.name)) continue;
          if (cur.depth >= MAX_SEARCH_DEPTH) {
            truncated = true;
            continue;
          }
          queue.push({
            abs: join(cur.abs, e.name),
            rel: cur.rel ? `${cur.rel}/${e.name}` : e.name,
            depth: cur.depth + 1,
          });
          continue;
        }
        if (!lst.isFile()) continue;
        if (e.name.toLowerCase().includes(lower)) {
          entries.push({
            name: e.name,
            path: cur.rel ? `${cur.rel}/${e.name}` : e.name,
            isDirectory: false,
            isSymlink: false,
            size: lst.size,
          });
        }
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'accent' }));
    return { entries, truncated, workspaceRoot: rootPath };
  }

  downloadFile(sessionWorkspace: string, relativePath: string | null | undefined, experienceDir?: string | null): DownloadResult {
    if (relativePath == null || relativePath.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空');
    }
    const filePath = this.resolvePath(relativePath, sessionWorkspace, experienceDir);
    if (!existsSync(filePath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `文件不存在：${relativePath}`);
    }
    const lst = lstatSync(filePath);
    if (!lst.isFile() || lst.isSymbolicLink()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不是普通文件：${relativePath}`);
    }
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch (e) {
      console.warn(`Failed to stat file for download: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    return { path: filePath, size, fileName: basename(filePath) };
  }

  readPdfFile(sessionWorkspace: string, relativePath: string | null | undefined, experienceDir?: string | null): DownloadResult {
    if (relativePath == null || relativePath.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空');
    }
    if (!relativePath.toLowerCase().endsWith('.pdf')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '仅支持预览 .pdf 文件');
    }
    const filePath = this.resolvePath(relativePath, sessionWorkspace, experienceDir);
    if (!existsSync(filePath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `文件不存在：${relativePath}`);
    }
    const lst = lstatSync(filePath);
    if (!lst.isFile() || lst.isSymbolicLink()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不是普通文件：${relativePath}`);
    }
    let head: Buffer;
    try {
      head = readN(filePath, 8);
    } catch (e) {
      console.warn(`Failed to read pdf header: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    if (!isPdfHeader(head, head.length)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不是有效的 PDF 文件或文件已损坏：${relativePath}`);
    }
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch (e) {
      console.warn(`Failed to stat pdf file: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    return { path: filePath, size, fileName: basename(filePath) };
  }

  async zipDirectory(sessionWorkspace: string, relativeDir: string | null | undefined, experienceDir?: string | null): Promise<ZipResult> {
    const access = this.zipReadAccess(sessionWorkspace, experienceDir);
    const workspaceRoot = this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
    const dir = this.normalizeRelativeDir(relativeDir);
    const dirPath = this.resolvePath(dir, sessionWorkspace, experienceDir);
    if (!existsSync(dirPath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目录不存在');
    }
    if (!statSync(dirPath).isDirectory()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '不是目录');
    }
    let totalBytes = 0;
    walkFiles(dirPath, (p, st) => {
      if (!lstatSync(p).isSymbolicLink() && st.isFile()) {
        totalBytes += st.size;
      }
    });
    if (totalBytes > this.maxZipBytes) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `目录过大（${formatSize(totalBytes)}），请选择子目录下载`);
    }
    const rootName = this.resolveZipRootName(dirPath, workspaceRoot);
    const zipPath = join(tmpdir(), `mao-workspace-${randomUUID()}.zip`);
    let written = false;
    try {
      await writeZip([{ absPath: dirPath, entryRoot: rootName }], zipPath, access);
      written = true;
    } catch (e) {
      console.warn(`Failed to write zip for directory: ${dirPath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '打包目录失败');
    } finally {
      if (!written) {
        try { rmSync(zipPath, { force: true }); } catch { /* ignore */ }
      }
    }
    let zipSize = 0;
    try {
      zipSize = statSync(zipPath).size;
    } catch {
      zipSize = 0;
    }
    return { zipPath, size: zipSize, fileName: `${rootName}.zip` };
  }

  /** 多选文件 / 目录合并下载：先验证整个选区，再去重，绝不忽略非法的嵌套选中项。 */
  async zipEntries(sessionWorkspace: string, paths: string[] | null | undefined, experienceDir?: string | null): Promise<ZipResult> {
    if (!Array.isArray(paths)) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数: paths');
    }
    if (paths.length === 0 || paths.length > MAX_ZIP_ENTRIES) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '下载目标不能为空，且最多选择 1000 项');
    }
    const access = this.zipReadAccess(sessionWorkspace, experienceDir);
    const resolved: { absPath: string; isDir: boolean }[] = [];
    const seen = new Set<string>();
    for (const p of paths) {
      if (typeof p !== 'string' || !p.trim() || p.length > MAX_ZIP_PATH_LENGTH) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空或过长');
      }
      // 不 trim 实际路径：空格可能是合法文件名的一部分。新接口只接收相对路径。
      if (isAbsolute(p) || p.startsWith('~') || p.split('/').includes('..') || /[\\\x00-\x1f\x7f]/.test(p) || /^[a-z]:/i.test(p)) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
      }
      const absPath = this.resolvePath(p, sessionWorkspace, experienceDir);
      if (!existsSync(absPath)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `文件不存在：${p}`);
      }
      let lst = lstatSync(absPath);
      // 保留当前会话团队经验挂载的只读下载能力，其余顶层链接一律拒绝。
      if (lst.isSymbolicLink() && absPath === resolve(sessionWorkspace, EXPERIENCE_MOUNT_NAME)
        && this.isExperienceListing(p, sessionWorkspace, experienceDir)) {
        lst = statSync(absPath);
      }
      if (!lst.isFile() && !lst.isDirectory()) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `不是普通文件或目录：${p}`);
      }
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      resolved.push({ absPath, isDir: lst.isDirectory() });
    }
    const items: ZipSourceItem[] = resolved
      .filter((item) => !resolved.some((other) => other !== item && other.isDir && isStrictlyInside(item.absPath, other.absPath)))
      .map(({ absPath }) => ({ absPath, entryRoot: basename(absPath) }));
    const roots = new Set<string>();
    for (const item of items) {
      validateZipEntryName(item.entryRoot);
      if (roots.has(item.entryRoot)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `选中项存在重名：${item.entryRoot}，无法合并打包`);
      }
      roots.add(item.entryRoot);
    }
    const zipPath = join(tmpdir(), `mao-workspace-${randomUUID()}.zip`);
    try {
      // 遍历时逐项复验沙箱，跳过子树符号链接；字节上限在收集过程中提前中止。
      await writeZip(items, zipPath, access);
      const size = statSync(zipPath).size;
      const workspaceRoot = this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace);
      return { zipPath, size, fileName: `${basename(workspaceRoot)}-${zipStamp()}.zip` };
    } catch (e) {
      try { rmSync(zipPath, { force: true }); } catch { /* ignore */ }
      if (e instanceof BusinessException) throw e;
      console.warn(`Failed to write zip for selected entries in workspace: ${sessionWorkspace}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '打包选中项失败');
    }
  }

  async readFile(
    sessionWorkspace: string,
    relativePath: string | null | undefined,
    offset: number,
    limit: number,
    experienceDir?: string | null,
  ): Promise<FileContentDTO> {
    if (relativePath == null || relativePath.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空');
    }
    const filePath = this.resolvePath(relativePath, sessionWorkspace, experienceDir);
    if (!existsSync(filePath)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `文件不存在：${relativePath}`);
    }
    const lst = lstatSync(filePath);
    if (!lst.isFile() || lst.isSymbolicLink()) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不是普通文件：${relativePath}`);
    }
    if (ImageFileSupport.mimeFromPath(relativePath)) {
      return this.readImageFile(filePath, relativePath);
    }
    // 文本预览整文件读入内存，必须先做大小上限（与图片/PDF 路径对齐），防止大文件触发 OOM
    if (lst.size > MAX_TEXT_PREVIEW_BYTES) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `文件过大（${formatSize(lst.size)}），文本预览上限为 ${formatSize(MAX_TEXT_PREVIEW_BYTES)}，请下载后查看`,
      );
    }
    const effectiveOffset = Math.max(offset, 0);
    const effectiveLimit = limit > 0 ? Math.min(limit, MAX_READ_LIMIT) : DEFAULT_READ_LIMIT;
    let allLines: string[];
    try {
      const raw = readFileSync(filePath);
      if (raw.includes(0)) {
        throw new Error('nul');
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      allLines = text.split('\n');
      if (allLines.length > 0 && allLines[allLines.length - 1] === '' && text.endsWith('\n')) {
        allLines = text.replace(/\n$/, '').split('\n');
        if (text.length === 0) allLines = [];
      }
    } catch {
      console.warn(`Failed to read file as text: ${filePath}`);
      throw new BusinessException(ErrorCode.PARAM_INVALID, '二进制文件，无法预览');
    }
    const totalLines = allLines.length;
    const from = Math.min(effectiveOffset, totalLines);
    const to = Math.min(from + effectiveLimit, totalLines);
    let content = allLines.slice(from, to).join('\n');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > MAX_CONTENT_BYTES) {
      content = utf8Prefix(bytes, MAX_CONTENT_BYTES);
    }
    return { content, total_lines: totalLines };
  }

  private async readImageFile(filePath: string, relativePath: string): Promise<FileContentDTO> {
    let sizeBytes: number;
    try {
      sizeBytes = statSync(filePath).size;
    } catch (e) {
      console.warn(`Failed to stat image file: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    if (sizeBytes > ImageFileSupport.MAX_IMAGE_BYTES) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        `文件过大（${ImageFileSupport.formatSize(sizeBytes)}），图片预览上限为 ${ImageFileSupport.formatSize(ImageFileSupport.MAX_IMAGE_BYTES)}`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch (e) {
      console.warn(`Failed to read image file: ${filePath}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '读取文件失败');
    }
    const detectedMime = ImageFileSupport.detectMimeFromBytes(bytes);
    if (!detectedMime) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `不支持的图片格式或文件内容无效：${relativePath}`);
    }
    const dataUri = `data:${detectedMime};base64,${bytes.toString('base64')}`;
    let width: number | undefined;
    let height: number | undefined;
    try {
      const meta = await sharp(bytes).metadata();
      width = meta.width;
      height = meta.height;
    } catch {
      // ignore
    }
    let summary = `${relativePath} (${detectedMime}, ${ImageFileSupport.formatSize(sizeBytes)}`;
    if (width != null && height != null) {
      summary += `, ${width}×${height}`;
    }
    summary += ')';
    return {
      content: summary,
      total_lines: 0,
      media_type: 'image',
      mime: detectedMime,
      data_uri: dataUri,
    };
  }

  private normalizeRelativeDir(relativeDir: string | null | undefined): string {
    if (relativeDir == null || relativeDir.trim().length === 0 || relativeDir === '.') {
      return '.';
    }
    return relativeDir;
  }

  /** 根上的「团队经验」链接确实指向这次放行的经验库时，目录列表把它标成可进入的目录。 */
  private isGrantedExperienceMount(
    entry: DirectoryEntryDTO,
    sessionWorkspace: string,
    experienceDir?: string | null,
  ): boolean {
    return entry.path === EXPERIENCE_MOUNT_NAME
      && entry.isSymlink
      && !!experienceDir
      && experienceMountPointsAt(sessionWorkspace, experienceDir);
  }

  private isExperienceListing(relativeDir: string, sessionWorkspace: string, experienceDir?: string | null): boolean {
    return !!experienceDir
      && isExperienceMountRelative(relativeDir)
      && experienceMountPointsAt(sessionWorkspace, experienceDir);
  }

  /** 冻结授权根；之后只比较已打开 fd 的内核目标，不重新解析可能被替换的源路径。 */
  private zipReadAccess(sessionWorkspace: string, experienceDir?: string | null): ZipReadAccess {
    // Node 没有可移植的 openat2 / F_GETPATH。不能验证 fd 实际目标的平台一律失败关闭。
    if (process.platform !== 'linux') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '当前平台不支持安全 ZIP 下载');
    }
    const workspaceRoot = realpathSync(sessionWorkspace);
    const experienceRoot = experienceDir && experienceMountPointsAt(sessionWorkspace, experienceDir)
      ? realpathSync(experienceDir)
      : undefined;
    return {
      maxBytes: this.maxZipBytes,
      validatePath: (path) => { this.resolvePath(relative(sessionWorkspace, path) || '.', sessionWorkspace, experienceDir); },
      validateFd: (fd, path) => {
        let target: string;
        try {
          // readlink 直接返回 fd 绑定的内核路径；不能 realpath(target) 再跟随可变祖先链接。
          target = readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          throw new BusinessException(ErrorCode.FORBIDDEN, '无法验证下载文件的实际位置');
        }
        const grantedExperience = experienceRoot && experienceDir
          && isExperienceMountRelative(relative(sessionWorkspace, path))
          && experienceMountPointsAt(sessionWorkspace, experienceDir)
          && isUnder(target, experienceRoot);
        if (!isAbsolute(target) || target.endsWith(' (deleted)')
          || (!isUnder(target, workspaceRoot) && !grantedExperience)) {
          throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
        }
        const st = fstatSync(fd);
        if (!st.isFile()) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, '下载目标不是普通文件');
        }
        return st;
      },
    };
  }

  private resolvePath(userPath: string, sessionWorkspace: string, experienceDir?: string | null): string {
    try {
      // 严格解析（技术方案 §5.9 越界收口）：REST 文件服务以会话工作区为唯一根。
      // 唯一例外是当前会话的「团队经验」：链接目标必须正好落在该 Agent 的经验库内，
      // 其他符号链接、其他 Agent 的库、共享目录其余部分仍然拒绝。
      const extra = experienceDir && isExperienceMountRelative(userPath) && experienceMountPointsAt(sessionWorkspace, experienceDir)
        ? [experienceDir]
        : [];
      return new StrictPathResolver(sessionWorkspace, extra).resolve(userPath);
    } catch (e) {
      if (e instanceof SecurityException) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
      }
      throw new BusinessException(ErrorCode.PARAM_INVALID, (e as Error).message);
    }
  }

  private resolveZipRootName(dirPath: string, workspaceRoot: string): string {
    try {
      const normalizedDir = resolve(dirPath);
      const normalizedRoot = resolve(workspaceRoot);
      return normalizedDir === normalizedRoot ? basename(normalizedRoot) : basename(normalizedDir);
    } catch {
      return 'workspace';
    }
  }
}

function isPdfHeader(head: Buffer, read: number): boolean {
  let offset = 0;
  if (read >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    offset = 3;
  }
  if (read - offset < 5) return false;
  return head[offset] === 0x25 && head[offset + 1] === 0x50 && head[offset + 2] === 0x44
    && head[offset + 3] === 0x46 && head[offset + 4] === 0x2d;
}

function readN(filePath: string, n: number): Buffer {
  const buf = Buffer.alloc(n);
  const fd = openSync(filePath, 'r');
  try {
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function walkFiles(dir: string, visit: (p: string, st: Stats) => void): void {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      try {
        const lst = lstatSync(p);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) stack.push(p);
        else visit(p, lst);
      } catch {
        // skip
      }
    }
  }
}

/** 严格子树判断：..notes 是合法目录名，不能用 startsWith('..') 误判。 */
function isStrictlyInside(child: string, dir: string): boolean {
  const rel = relative(dir, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

function zipStamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** ZIP 使用 POSIX 相对名；不把 Linux 文件名中的反斜杠转换成路径分隔符。 */
function validateZipEntryName(name: string): void {
  if (!name || isAbsolute(name) || /[\\\x00-\x1f\x7f]/.test(name)
    || name.split('/').some((part) => !part || part === '.' || part === '..' || /^[a-z]:/i.test(part))) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '压缩包内路径不合法');
  }
}

async function writeZip(
  items: ZipSourceItem[],
  zipPath: string,
  options: ZipReadAccess,
): Promise<void> {
  // 先完成收集 / 验证，再创建临时文件，失败时不会遗留打开的输出流。
  const entries: { name: string; path: string; isDirectory: boolean }[] = [];
  let totalBytes = 0;
  for (const item of items) {
    const stack = [{ path: item.absPath, name: item.entryRoot, root: true }];
    while (stack.length) {
      const cur = stack.pop()!;
      let lst = lstatSync(cur.path);
      if (lst.isSymbolicLink()) {
        if (!cur.root) continue;
        // 根已经由调用方校验（唯一可跟随的是授权的团队经验挂载）。
        lst = statSync(cur.path);
      }
      if (!lst.isDirectory() && !lst.isFile()) continue;
      options.validatePath(cur.path);
      validateZipEntryName(cur.name);
      totalBytes += lst.isFile() ? lst.size : 0;
      if (totalBytes > options.maxBytes) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `所选内容过大（${formatSize(totalBytes)}），请减少选中项或分批下载`);
      }
      entries.push({ name: cur.name, path: cur.path, isDirectory: lst.isDirectory() });
      // 大量空目录 / 零字节文件也会消耗内存，限制展开后的归档条目。
      if (entries.length > 100_000) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '所选内容条目过多，请分批下载');
      }
      if (lst.isDirectory()) {
        for (const name of readdirSync(cur.path)) {
          stack.push({ path: join(cur.path, name), name: `${cur.name}/${name}`, root: false });
        }
      }
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  await new Promise<void>((resolveP, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 5 } });
    let failure: Error | undefined;
    let input: ReadStream | undefined;
    let countedInput: Transform | undefined;
    let inputClosed: Promise<void> | undefined;
    let outputClosed = false;
    let readingDone = false;
    const settle = () => {
      if (outputClosed && readingDone) {
        if (failure) reject(failure);
        else resolveP();
      }
    };
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      input?.destroy();
      countedInput?.destroy();
      archive.abort();
      output.destroy();
    };
    output.on('error', fail);
    // 输入 / 输出 fd 均关闭后再返回错误，调用方才可可靠清理临时文件。
    output.on('close', () => { outputClosed = true; settle(); });
    archive.on('error', fail);
    archive.on('warning', fail);
    archive.pipe(output);
    void (async () => {
      let openedBytes = 0;
      let readBytes = 0;
      try {
        for (const entry of entries) {
          if (failure) break;
          options.validatePath(entry.path);
          if (entry.isDirectory) {
            archive.append(Buffer.alloc(0), { name: `${entry.name}/` });
            continue;
          }
          // O_NOFOLLOW 防叶子替换，O_NONBLOCK 避免被换成 FIFO 后阻塞事件循环。
          // 祖先替换由打开后对 /proc/self/fd 的实际目标校验防御。
          let fd: number | undefined = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const st = options.validateFd(fd, entry.path);
            openedBytes += st.size;
            if (openedBytes > options.maxBytes) {
              throw new BusinessException(ErrorCode.PARAM_INVALID, '所选内容过大，请减少选中项或分批下载');
            }
            // fd 非空时 Node 不再按 path 打开；流拥有 fd，close 时自动回收。
            input = createReadStream(entry.path, { fd, autoClose: true });
            fd = undefined;
            const source = input;
            inputClosed = new Promise<void>((closed) => source.once('close', closed));
            // fstat 只是预检：同 inode 仍可被追加。整次归档按实际读取字节计数，
            // 超限块不传给归档器，错误沿用 fail 关闭源 fd / 归档 / 临时输出。
            const counted = countedInput = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                readBytes += chunk.length;
                if (readBytes > options.maxBytes) {
                  callback(new BusinessException(ErrorCode.PARAM_INVALID, '所选内容过大，请减少选中项或分批下载'));
                } else {
                  callback(null, chunk);
                }
              },
            });
            const consumed = new Promise<void>((done, failed) => {
              counted.once('end', done);
              counted.once('error', failed);
              counted.once('close', () => {
                if (!counted.readableEnded) failed(failure ?? new Error('ZIP 文件读取中止'));
              });
              source.once('error', failed);
              source.once('close', () => {
                if (!source.readableEnded) failed(failure ?? new Error('ZIP 文件读取中止'));
              });
              archive.append(counted, { name: entry.name, mode: st.mode, date: st.mtime });
              source.pipe(counted);
            });
            // 一次最多一个源 fd，不为十万归档条目同时打开文件。
            await consumed;
            await inputClosed;
            input = undefined;
            countedInput = undefined;
            inputClosed = undefined;
          } finally {
            // 校验 / 建流前失败：fd 尚未转移给 ReadStream，必须自己关闭。
            if (fd !== undefined) closeSync(fd);
          }
        }
        if (!failure) void archive.finalize().catch(fail);
      } catch (e) {
        fail(e as Error);
      } finally {
        input?.destroy();
        countedInput?.destroy();
        await inputClosed;
        readingDone = true;
        settle();
      }
    })();
  });
}
