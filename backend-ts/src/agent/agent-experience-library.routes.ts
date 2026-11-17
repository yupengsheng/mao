import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { AgentService } from './agent.service.js';
import type { ExperienceDocMeta, ExperienceIndexService } from '../harness/experience/experience-index.service.js';

/**
 * Agent 团队经验库管理接口（技术方案 2026-10-24 §4.1）。
 *
 * 直接操作 <shareDir>/agent-experience/<agentId>/ 下的子文档与索引；
 * 开关（experience_library_enabled）只改标记位，挂载/注入在会话创建与上下文装配点按位判定。
 * enabled=0 时文档接口仍可用——admin 可先整理内容再开启。
 */
export interface AgentExperienceLibraryRouteDeps {
  agentService: AgentService;
  /** 总览批量取 Agent 名称与开关（findByIds 含 notDeleted 过滤，软删 Agent 的库归孤儿）。 */
  agentRepository: { findByIds(ids: number[]): Promise<Array<{ id?: number; name: string; experienceLibraryEnabled?: number | null }>> };
  experienceIndexService: ExperienceIndexService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface SaveDocRequest {
  fileName?: string | null;
  content?: string | null;
}

/** 服务端白名单校验，避免排序参数进入未定义比较逻辑。 */
const SORT_FIELDS = ['fileName', 'title', 'updatedAt', 'sizeBytes', 'lastVerified'] as const;
type SortField = (typeof SORT_FIELDS)[number];
const ORDERS = ['asc', 'desc'] as const;
type SortOrder = (typeof ORDERS)[number];
const GROUP_BY = ['none', 'month', 'keyword'] as const;
type GroupBy = (typeof GROUP_BY)[number];
const ABNORMAL = ['', 'no-frontmatter', 'no-title'] as const;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE_SIZE = 100;
const KEYWORD_FACET_LIMIT = 50;
const NO_MONTH_GROUP = '未命名';
const NO_KEYWORD_GROUP = '未分类';

function requireIntParam(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

function requireEnumParam<T extends string>(raw: unknown, name: string, allowed: readonly T[], fallback: T): T {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 取值必须是 ${allowed.join('/')}`);
  }
  return raw as T;
}

function requireDateParam(raw: unknown, name: string): string {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string' || !DATE_PATTERN.test(raw)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 必须是 YYYY-MM-DD 日期`);
  }
  return raw;
}

function requireSearchParam(raw: unknown, name: string, maxLength: number): string {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 必须是字符串`);
  }
  if (raw.length > maxLength) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 长度不能超过 ${maxLength}`);
  }
  return raw;
}

function splitKeywords(keywords: string): string[] {
  if (keywords === '') return [];
  const result: string[] = [];
  for (const raw of keywords.split(/[\s]*[,，、;；][\s]*/)) {
    const tag = raw.trim();
    if (tag !== '' && !result.includes(tag)) result.push(tag);
  }
  return result;
}

function beijingDateOf(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time + 8 * 3600_000).toISOString().slice(0, 10) : '';
}

function isSortValueEmpty(doc: ExperienceDocMeta, sort: SortField): boolean {
  return (sort === 'title' || sort === 'lastVerified') && doc[sort] === '';
}

function compareDocs(a: ExperienceDocMeta, b: ExperienceDocMeta, sort: SortField): number {
  if (sort === 'sizeBytes') return a.sizeBytes - b.sizeBytes;
  if (sort === 'fileName' || sort === 'title') return a[sort].localeCompare(b[sort]);
  return a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0;
}

function sortDocs(docs: ExperienceDocMeta[], sort: SortField, order: SortOrder): ExperienceDocMeta[] {
  const direction = order === 'asc' ? 1 : -1;
  return [...docs].sort((a, b) => {
    const aEmpty = isSortValueEmpty(a, sort);
    const bEmpty = isSortValueEmpty(b, sort);
    if (aEmpty || bEmpty) {
      if (aEmpty && bEmpty) return 0;
      return aEmpty ? 1 : -1;
    }
    return compareDocs(a, b, sort) * direction;
  });
}

function groupKeyOf(doc: ExperienceDocMeta, groupBy: Exclude<GroupBy, 'none'>): string {
  if (groupBy === 'month') return /^(\d{4}-\d{2})/.exec(doc.fileName)?.[1] ?? NO_MONTH_GROUP;
  return splitKeywords(doc.keywords)[0] ?? NO_KEYWORD_GROUP;
}

function sortGroupCounts(
  counts: Array<{ key: string; count: number }>,
  groupBy: Exclude<GroupBy, 'none'>,
): Array<{ key: string; count: number }> {
  const noGroup = groupBy === 'month' ? NO_MONTH_GROUP : NO_KEYWORD_GROUP;
  return counts.sort((a, b) => {
    if (a.key === noGroup) return 1;
    if (b.key === noGroup) return -1;
    return groupBy === 'month'
      ? b.key.localeCompare(a.key)
      : b.count - a.count || a.key.localeCompare(b.key);
  });
}

export function registerAgentExperienceLibraryRoutes(app: FastifyInstance, deps: AgentExperienceLibraryRouteDeps): void {
  const { agentService, agentRepository, experienceIndexService, permissionService } = deps;

  async function requireAgentWrite(request: Parameters<typeof requireUserId>[0]): Promise<number> {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    return userId;
  }

  async function requireAgentRead(request: Parameters<typeof requireUserId>[0]): Promise<number> {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:read');
    return userId;
  }

  /** 校验 Agent 存在并返回其库目录（getAgent 不存在时抛 AGENT_NOT_FOUND）。 */
  async function requireAgentDir(agentId: number): Promise<{ agentDir: string; enabled: boolean }> {
    const agent = await agentService.getAgent(agentId);
    return {
      agentDir: experienceIndexService.dirFor(agentId),
      enabled: (agent.experienceLibraryEnabled ?? 1) === 1,
    };
  }

  function requireDocFileName(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'file 不能为空');
    }
    // basename 约束：拒绝路径分隔符 / .. / 反斜杠（防目录穿越），必须 .md 结尾
    if (raw.includes('/') || raw.includes('\\') || raw.includes('..') || !raw.toLowerCase().endsWith('.md')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'file 必须是 .md 结尾的文件名（不含路径）');
    }
    return raw;
  }

  // 跨库总览：静态路径必须在 :id 路由前注册，返回已存在 Agent 库与孤儿库。
  app.get('/v1/agents/experience-library/overview', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:read');
    const stats = experienceIndexService.overviewLibraries();
    const agents = await agentRepository.findByIds(stats.map((stat) => stat.agentId));
    const agentById = new Map(
      agents.filter((agent) => agent.id != null).map((agent) => [agent.id as number, agent]),
    );
    const libraries: Array<{
      agentId: number; agentName: string; enabled: boolean; docCount: number; totalBytes: number; lastUpdatedAt: string;
    }> = [];
    const orphans: Array<{ agentId: number; docCount: number; totalBytes: number; lastUpdatedAt: string }> = [];
    for (const stat of stats) {
      const agent = agentById.get(stat.agentId);
      if (agent == null) {
        orphans.push(stat);
      } else {
        libraries.push({
          agentId: stat.agentId,
          agentName: agent.name,
          enabled: (agent.experienceLibraryEnabled ?? 1) === 1,
          docCount: stat.docCount,
          totalBytes: stat.totalBytes,
          lastUpdatedAt: stat.lastUpdatedAt,
        });
      }
    }
    libraries.sort((a, b) => a.agentId - b.agentId);
    orphans.sort((a, b) => a.agentId - b.agentId);
    return sendOk(reply, { libraries, orphans });
  });

  app.patch('/v1/agents/:id/experience-library', async (request, reply) => {
    await requireAgentWrite(request);
    const body = bodyOf<{ enabled?: boolean }>(request);
    if (typeof body.enabled !== 'boolean') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'enabled 必须为布尔值');
    }
    const agent = await agentService.setExperienceLibraryEnabled(pathId(request), body.enabled);
    return sendOk(reply, { enabled: (agent.experienceLibraryEnabled ?? 1) === 1 });
  });

  app.get('/v1/agents/:id/experience-library/docs', async (request, reply) => {
    await requireAgentRead(request);
    const { agentDir, enabled } = await requireAgentDir(pathId(request));
    const query = request.query as Record<string, unknown>;
    // 无分页参数保持旧弹窗协议（全量 docs + indexContent），避免旧客户端收到新形状。
    const hasPagination = ['page', 'size', 'sort', 'order', 'groupBy', 'keyword', 'tag',
      'verifiedFrom', 'verifiedTo', 'updatedFrom', 'updatedTo', 'abnormal']
      .some((key) => query[key] != null && query[key] !== '');
    if (!hasPagination) {
      const docs = experienceIndexService.listDocs(agentDir);
      const indexContent = experienceIndexService.readDoc(agentDir, 'INDEX.md') ?? '';
      return sendOk(reply, { enabled, docs, indexContent });
    }

    const page = requireIntParam(query.page, 'page', 1, 1_000_000, 1);
    const size = requireIntParam(query.size, 'size', 1, MAX_PAGE_SIZE, 20);
    const sort = requireEnumParam(query.sort, 'sort', SORT_FIELDS, 'fileName');
    const order = requireEnumParam(query.order, 'order', ORDERS, 'desc');
    const groupBy = requireEnumParam(query.groupBy, 'groupBy', GROUP_BY, 'none');
    const abnormal = requireEnumParam(query.abnormal, 'abnormal', ABNORMAL, '');
    const keyword = requireSearchParam(query.keyword, 'keyword', 200);
    const tag = requireSearchParam(query.tag, 'tag', 60);
    const verifiedFrom = requireDateParam(query.verifiedFrom, 'verifiedFrom');
    const verifiedTo = requireDateParam(query.verifiedTo, 'verifiedTo');
    const updatedFrom = requireDateParam(query.updatedFrom, 'updatedFrom');
    const updatedTo = requireDateParam(query.updatedTo, 'updatedTo');
    const all = experienceIndexService.listDocs(agentDir);

    // facets 的 keywords 始终按全库统计，不受其他筛选和分页影响。
    const tagCounts = new Map<string, number>();
    for (const doc of all) {
      for (const item of splitKeywords(doc.keywords)) tagCounts.set(item, (tagCounts.get(item) ?? 0) + 1);
    }
    const keywords = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, KEYWORD_FACET_LIMIT)
      .map(([item, count]) => ({ tag: item, count }));

    let filtered = all;
    const keywordLower = keyword.trim().toLowerCase();
    if (keywordLower !== '') {
      filtered = filtered.filter((doc) =>
        [doc.fileName, doc.title, doc.keywords, doc.summary, doc.applicable]
          .some((value) => value.toLowerCase().includes(keywordLower)));
    }
    const tagLower = tag.trim().toLowerCase();
    if (tagLower !== '') {
      filtered = filtered.filter((doc) => splitKeywords(doc.keywords)
        .some((item) => item.toLowerCase() === tagLower));
    }
    if (verifiedFrom !== '') filtered = filtered.filter((doc) => doc.lastVerified !== '' && doc.lastVerified >= verifiedFrom);
    if (verifiedTo !== '') filtered = filtered.filter((doc) => doc.lastVerified !== '' && doc.lastVerified <= verifiedTo);
    if (updatedFrom !== '') filtered = filtered.filter((doc) => beijingDateOf(doc.updatedAt) >= updatedFrom);
    if (updatedTo !== '') filtered = filtered.filter((doc) => beijingDateOf(doc.updatedAt) <= updatedTo);
    if (abnormal === 'no-title') {
      filtered = filtered.filter((doc) => doc.title === '');
    } else if (abnormal === 'no-frontmatter') {
      filtered = filtered.filter((doc) => doc.title === '' && doc.keywords === '' && doc.summary === ''
        && doc.applicable === '' && doc.lastVerified === '');
    }

    const sorted = sortDocs(filtered, sort, order);
    const total = sorted.length;
    const docs = sorted.slice((page - 1) * size, page * size);
    let groupCounts: Array<{ key: string; count: number }> = [];
    if (groupBy !== 'none') {
      const counts = new Map<string, number>();
      for (const doc of filtered) {
        const key = groupKeyOf(doc, groupBy);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      groupCounts = sortGroupCounts([...counts.entries()].map(([key, count]) => ({ key, count })), groupBy);
    }
    return sendOk(reply, { enabled, total, page, size, docs, groupCounts, keywords });
  });

  app.get('/v1/agents/:id/experience-library/index', async (request, reply) => {
    await requireAgentRead(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    return sendOk(reply, experienceIndexService.readIndex(agentDir));
  });

  app.get('/v1/agents/:id/experience-library/docs/content', async (request, reply) => {
    await requireAgentRead(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    const fileName = requireDocFileName((request.query as Record<string, unknown>).file);
    const content = experienceIndexService.readDoc(agentDir, fileName);
    if (content == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `经验文档不存在: ${fileName}`);
    }
    return sendOk(reply, { fileName, content });
  });

  app.put('/v1/agents/:id/experience-library/docs/content', async (request, reply) => {
    await requireAgentWrite(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    const body = bodyOf<SaveDocRequest>(request);
    const fileName = requireDocFileName(body.fileName);
    if (fileName.toLowerCase() === 'index.md') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'INDEX.md 由系统自动生成，不能直接编辑');
    }
    if (body.content == null || typeof body.content !== 'string') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'content 不能为空');
    }
    let bytes: number;
    try {
      bytes = experienceIndexService.writeDoc(agentDir, fileName, body.content);
    } catch (e) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, (e as Error).message);
    }
    return sendOk(reply, { fileName, bytes });
  });

  app.delete('/v1/agents/:id/experience-library/docs', async (request, reply) => {
    await requireAgentWrite(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    const fileName = requireDocFileName((request.query as Record<string, unknown>).file);
    if (fileName.toLowerCase() === 'index.md') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'INDEX.md 由系统自动生成，不能删除');
    }
    try {
      experienceIndexService.deleteDoc(agentDir, fileName);
    } catch (e) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, (e as Error).message);
    }
    return sendOk(reply);
  });

  app.post('/v1/agents/:id/experience-library/index/rebuild', async (request, reply) => {
    await requireAgentWrite(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    experienceIndexService.rebuild(agentDir);
    return sendOk(reply);
  });
}
