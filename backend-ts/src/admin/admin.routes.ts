import type { FastifyInstance } from 'fastify';
import { requireRequestPermission } from '../common/http-error.js';
import { sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { bodyOf } from '../common/request.js';
import type { JwtService } from '../crypto/jwt.service.js';
import { parseAnalyticsRange, resolveAnalyticsRange } from './analytics-range.js';
import type { AdminAnalyticsService } from './admin-analytics.service.js';
import type { MemoryItemVO, MemoryListQuery, MemoryPageVO } from '../memory/types.js';
import { ACTIVE_PHASES } from '../session/util/session-group-key.js';

/** 运行监控默认视图：全部活跃相位 + 异常终态（CANCELLING 与 ACTIVE_PHASES 同源，避免手写清单漂移）。 */
const RUNTIME_DEFAULT_PHASES = [...ACTIVE_PHASES, 'FAILED', 'CANCELLED'].join(',');

export interface AdminSessionLister {
  listSessionsForAdmin(
    page: number,
    size: number,
    userId?: number,
    agentId?: number,
    executionMode?: string,
    phase?: string,
    keyword?: string,
    status?: string,
    messageScope?: string,
    source?: string,
    startDate?: string,
    endDate?: string,
    options?: { range?: string | null; dateFrom?: string | null; dateTo?: string | null },
  ): Promise<{ records: unknown[]; total: number; current: number; size: number; matchSnippets?: Record<number, string> }>;
}

/** 后台记忆读写：读需 memory:read，写需 memory:write，目标归属按记忆 id 反查。 */
export interface AdminMemoryAuditor {
  listForAdmin(query: MemoryListQuery): Promise<MemoryPageVO>;
  updateForAdmin(id: number, input: { content?: string | null; status?: string | null }): Promise<MemoryItemVO>;
  removeForAdmin(id: number): Promise<void>;
  createForAdmin(userId: number, input: { scope: string; content: string; projectKey?: string | null }): Promise<MemoryItemVO>;
}

export interface AdminUserLookup {
  findByIds(ids: number[]): Promise<Array<{ id: number; username: string; displayName?: string | null }>>;
  search(keyword: string, pageSize: number): Promise<Array<{ id: number; username: string; displayName?: string | null }>>;
}

export interface AdminRouteDeps {
  jwt: JwtService;
  analytics: AdminAnalyticsService;
  sessionLister?: AdminSessionLister;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  memoryAuditor?: AdminMemoryAuditor;
  memoryUserLookup?: AdminUserLookup;
}

interface AnalyticsQueryRaw {
  /** 语义统计周期（管理后台周期选择器）：今日/昨日/本周/上周/本月/上月/自定义 */
  range?: string;
  /** 自定义区间起止日（YYYY-MM-DD，闭区间），仅 range=custom 时生效 */
  start?: string;
  end?: string;
  days?: string;
  endOffset?: string;
  limit?: string;
  page?: string;
  pageSize?: string;
  excludeConnectivity?: string;
  modelId?: string;
}

function parseAnalyticsQuery(raw: AnalyticsQueryRaw): {
  days: number;
  endOffset: number;
  limit: number;
  page?: number;
  pageSize?: number;
  excludeConnectivity: boolean;
  modelId: number | null;
} {
  // 语义周期优先解析成 (days, endOffset)；缺省/非法回落原始参数（mao-cli 兼容口径）
  const range = parseAnalyticsRange(raw.range);
  const window =
    range != null ? resolveAnalyticsRange(range, { start: raw.start, end: raw.end }) : null;
  const days = Number(window?.days ?? raw.days ?? 30);
  const endOffset = Number(window?.endOffset ?? raw.endOffset ?? 0);
  const limit = Number(raw.limit ?? 20);
  const hasPagination = raw.page != null || raw.pageSize != null;
  const page = hasPagination ? normalizeInteger(raw.page, 1, 1_000_000) : undefined;
  const pageSize = hasPagination ? normalizeInteger(raw.pageSize, 20, 100) : undefined;
  const modelIdRaw = raw.modelId == null || raw.modelId === '' ? null : Number(raw.modelId);
  return {
    days: Math.max(1, Math.min(Number.isFinite(days) ? days : 30, 90)),
    endOffset: Math.max(0, Math.min(Number.isFinite(endOffset) ? endOffset : 0, 365)),
    limit: Math.max(1, Math.min(Number.isFinite(limit) ? limit : 20, 100)),
    page,
    pageSize,
    // 默认排除连通性测试，避免模型配置自检污染质量指标
    excludeConnectivity: raw.excludeConnectivity !== 'false' && raw.excludeConnectivity !== '0',
    modelId: modelIdRaw != null && Number.isFinite(modelIdRaw) ? modelIdRaw : null,
  };
}

function normalizeInteger(raw: string | undefined, fallback: number, max: number): number {
  const value = Math.trunc(Number(raw));
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, max);
}

export function registerAdminAnalyticsRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  // 旧巨型汇总：管理后台已切换 scope 接口，暂留给 mao-cli / 兼容调用方。
  app.get('/v1/admin/analytics/summary', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.summary(days, endOffset)));
  });

  app.get('/v1/admin/analytics/overview', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.overview(days, endOffset, { excludeConnectivity })));
  });

  app.get('/v1/admin/analytics/trends', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    const granularity = (req.query as { granularity?: string }).granularity === 'hour' ? 'hour' : 'day';
    sendJson(reply, 200, ok(await deps.analytics.trendsScope(days, endOffset, { excludeConnectivity, granularity })));
  });

  app.get('/v1/admin/analytics/models', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity, modelId } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(
      reply,
      200,
      ok(await deps.analytics.modelsScope(days, endOffset, { excludeConnectivity, sceneModelId: modelId })),
    );
  });

  app.get('/v1/admin/analytics/users', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit, page, pageSize, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.usersScope(days, endOffset, limit, { excludeConnectivity, page, pageSize })));
  });

  app.get('/v1/admin/analytics/agents', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit, page, pageSize, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.agentsScope(days, endOffset, limit, { excludeConnectivity, page, pageSize })));
  });

  app.get('/v1/admin/analytics/sessions', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.sessionsScope(days, endOffset, { excludeConnectivity })));
  });

  // 运行轨迹聚合：最慢轮 / 最贵轮（按 scope 维度）+ 工具失败率（按活动 type）
  app.get('/v1/admin/analytics/run-trace', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    const q = req.query as { scene?: string; scope?: string };
    const scene = typeof q.scene === 'string' && q.scene.trim() !== '' ? q.scene.trim() : 'agent';
    const scope = q.scope === 'user' ? 'user' : 'agent';
    sendJson(reply, 200, ok(await deps.analytics.runTraceScope(days, endOffset, { scene, scope, limit })));
  });
}

export function registerAdminRuntimeRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/v1/admin/runtime/sessions', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'session:read');
    const q = req.query as {
      page?: string;
      size?: string;
      userId?: string;
      agentId?: string;
      executionMode?: string;
      phase?: string;
      keyword?: string;
      status?: string;
      messageScope?: string;
      range?: string;
      dateFrom?: string;
      dateTo?: string;
    };
    const page = Number(q.page ?? 1);
    const size = Number(q.size ?? 20);
    const runtimePhase = !q.phase || q.phase.trim() === ''
      ? RUNTIME_DEFAULT_PHASES
      : q.phase;
    if (!deps.sessionLister) {
      sendJson(reply, 200, ok({ records: [], total: 0, page, size }));
      return;
    }
    const result = await deps.sessionLister.listSessionsForAdmin(
      page,
      size,
      q.userId != null ? Number(q.userId) : undefined,
      q.agentId != null ? Number(q.agentId) : undefined,
      q.executionMode,
      runtimePhase,
      q.keyword,
      q.status,
      q.messageScope,
      undefined,
      undefined,
      undefined,
      { range: q.range, dateFrom: q.dateFrom, dateTo: q.dateTo },
    );
    sendJson(reply, 200, ok(result));
  });

  // /v1/admin 前缀由全局审计拦截器记录，查询和全部写操作均留痕。
  app.get('/v1/admin/memory', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:read');
    const q = req.query as Record<string, string | string[] | undefined>;
    const pick = (key: string): string => {
      const raw = q[key];
      return (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
    };
    const rawUserId = pick('userId');
    const userId = rawUserId === '' ? null : requirePositiveMemoryUserId(rawUserId);
    const scope = parseMemoryFilter(pick('scope'), ['USER', 'PROJECT'] as const, 'scope');
    const status = parseMemoryFilter(pick('status'), ['ACTIVE', 'DISMISSED'] as const, 'status');
    const source = parseMemoryFilter(pick('source'), ['AUTO', 'MANUAL'] as const, 'source');
    const keyword = pick('keyword') || null;
    const projectKey = pick('projectKey') || null;
    // 时间范围不计入跨用户查询门槛，与上游 D5 一致。
    if (userId == null && !keyword && !scope && !status && !source && !projectKey) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '跨用户查询必须至少指定一个过滤条件（关键词/作用域/状态/来源/项目）');
    }
    const updatedFrom = parseMemoryDate(pick('updatedFrom'), '00:00:00');
    const updatedTo = parseMemoryDate(pick('updatedTo'), '23:59:59');
    if (updatedFrom && updatedTo && updatedFrom > updatedTo) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '更新时间开始日期不能晚于结束日期');
    }
    const { auditor, users } = requireMemoryDeps(deps);
    const result = await auditor.listForAdmin({
      userId, scope, status, source, keyword, projectKey, updatedFrom, updatedTo,
      page: normalizeInteger(pick('page'), 1, 1_000_000),
      pageSize: normalizeInteger(pick('pageSize'), 20, 100),
    });
    if (result.records.length > 0) {
      const ids = [...new Set(result.records.map((item) => item.userId))];
      const byId = new Map((await users.findByIds(ids)).map((user) => [user.id, user]));
      result.records = result.records.map((item) => ({
        ...item,
        username: byId.get(item.userId)?.username ?? null,
        displayName: byId.get(item.userId)?.displayName ?? null,
      }));
    }
    sendJson(reply, 200, ok(result));
  });

  // 只暴露记忆管理所需的用户基本信息，不额外要求 user:read。
  app.get('/v1/admin/memory/users', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:read');
    const q = req.query as Record<string, string | string[] | undefined>;
    const keyword = Array.isArray(q.keyword) ? q.keyword[0] : q.keyword;
    const pageSize = Array.isArray(q.pageSize) ? q.pageSize[0] : q.pageSize;
    const { users } = requireMemoryDeps(deps);
    const records = (await users.search(keyword?.trim() ?? '', normalizeInteger(pageSize, 20, 100)))
      .map(({ id, username, displayName }) => ({ id, username, displayName }));
    sendJson(reply, 200, ok({ records }));
  });

  app.patch('/v1/admin/memory/:id', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:write');
    const { auditor } = requireMemoryDeps(deps);
    const id = requireMemoryPathId((req.params as { id: string }).id);
    const body = bodyOf<{ content?: unknown; status?: unknown; userId?: unknown }>(req);
    if (body.userId !== undefined) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '记忆归属不可修改');
    }
    if (body.content != null && typeof body.content !== 'string') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'content 必须是字符串');
    }
    if (body.status != null && typeof body.status !== 'string') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'status 必须是字符串');
    }
    if (body.content == null && body.status == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '至少提供 content 或 status');
    }
    const vo = await auditor.updateForAdmin(id, {
      content: body.content ?? null,
      status: body.status ?? null,
    });
    sendJson(reply, 200, ok(vo));
  });

  app.delete('/v1/admin/memory/:id', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:write');
    const { auditor } = requireMemoryDeps(deps);
    await auditor.removeForAdmin(requireMemoryPathId((req.params as { id: string }).id));
    sendJson(reply, 200, ok());
  });

  app.post('/v1/admin/memory', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:write');
    const { auditor, users } = requireMemoryDeps(deps);
    const body = bodyOf<{ userId?: unknown; scope?: unknown; content?: unknown; projectKey?: unknown }>(req);
    const userId = requirePositiveMemoryUserId(body.userId);
    if (typeof body.scope !== 'string' || typeof body.content !== 'string'
      || (body.projectKey != null && typeof body.projectKey !== 'string')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'scope/content/projectKey 必须是字符串');
    }
    // memory_item 无外键，代建前验证用户存在，防止孤儿数据。
    if (!(await users.findByIds([userId])).some((user) => user.id === userId)) {
      throw new BusinessException(ErrorCode.USER_NOT_FOUND);
    }
    sendJson(reply, 200, ok(await auditor.createForAdmin(userId, {
      scope: body.scope, content: body.content, projectKey: body.projectKey ?? null,
    })));
  });
}

function requireMemoryDeps(deps: AdminRouteDeps): { auditor: AdminMemoryAuditor; users: AdminUserLookup } {
  if (!deps.memoryAuditor || !deps.memoryUserLookup) {
    throw new BusinessException(ErrorCode.INTERNAL_ERROR, '记忆管理依赖未装配');
  }
  return { auditor: deps.memoryAuditor, users: deps.memoryUserLookup };
}

function requirePositiveMemoryUserId(raw: unknown): number {
  const id = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'userId 必须是正整数');
  }
  return id;
}

function requireMemoryPathId(raw: string): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new BusinessException(ErrorCode.MEMORY_ITEM_NOT_FOUND);
  return id;
}

function parseMemoryFilter<T extends string>(raw: string, allowed: readonly T[], name: string): T | null {
  if (raw === '') return null;
  if (!allowed.includes(raw as T)) throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 不合法`);
  return raw as T;
}

/** 日期按 UTC round-trip 验证，拒绝不存在的日历日期，避免查询意外放宽。 */
function parseMemoryDate(raw: string, suffix: string): string | null {
  if (raw === '') return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== raw) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'updatedFrom/updatedTo 必须是 YYYY-MM-DD 格式的有效日期');
  }
  return `${raw} ${suffix}`;
}
