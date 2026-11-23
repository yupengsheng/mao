import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import { parseSqlTimeMs } from '../app-utils.js';
import type { JwtService } from '../crypto/jwt.service.js';
import { bindOutcomeToResult, completePendingAfterBind, feishuUnionIdOf, PASSWORD_BIND_LINK_TTL_MS } from '../channel-bind/bind-flow.js';
import type { FeishuBindingRepository } from './binding.repository.js';
import type { FeishuAuthService } from '../auth/feishu-auth.service.js';
import type { FeishuPendingBindingMessage, MysqlFeishuPendingBindingRepository } from './pending-binding.repository.js';

const FEISHU_PENDING_INVALID_TEXT = '链接已过期或已使用，请回 IM 重新发送一条消息';
const FEISHU_DISABLED_TEXT = '账号已禁用，无法完成绑定';

export interface FeishuBindingRouteDeps {
  jwt: JwtService;
  repository: FeishuBindingRepository;
  auth?: FeishuAuthService;
  pending?: MysqlFeishuPendingBindingRepository;
  currentUser?: (userId: number) => Promise<{ id: number; username: string | null; disabled: boolean } | null>;
  replayPending?: (pending: FeishuPendingBindingMessage) => Promise<void>;
  notifyMismatch?: (pending: FeishuPendingBindingMessage) => Promise<void>;
}

export function registerFeishuBindingRoutes(app: FastifyInstance, deps: FeishuBindingRouteDeps): void {
  app.get('/v1/feishu/binding/status', async (request, reply) => sendJson(reply, 200, ok(await deps.repository.getStatus(requireUserId(request, deps.jwt)))));
  app.post('/v1/feishu/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    if (deps.auth == null) return sendJson(reply, 200, ok({ authUrl: '' }));
    return sendJson(reply, 200, ok(await deps.auth.getQrCodeUrl(userId)));
  });
  app.delete('/v1/feishu/binding', async (request, reply) => {
    await deps.repository.unbind(requireUserId(request, deps.jwt));
    return sendJson(reply, 200, ok(null));
  });
}

/** 密码登录绑定确认页使用的 pending 预览与完成接口。 */
export function registerFeishuPendingBindingRoutes(app: FastifyInstance, deps: FeishuBindingRouteDeps): void {
  if (deps.pending == null || deps.currentUser == null || deps.replayPending == null) return;
  const pending = deps.pending;
  const currentUser = deps.currentUser;
  const replayPending = deps.replayPending;
  app.get('/v1/feishu/binding/pending', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    const state = String((request.query as { state?: string } | undefined)?.state ?? '').trim();
    if (state === '') throw new BusinessException(ErrorCode.PARAM_INVALID, FEISHU_PENDING_INVALID_TEXT);
    const row = await pending.findByState(state);
    const createdAtMs = parseSqlTimeMs(row?.createdAt ?? null);
    if (row == null || row.bindingMethod !== 'PASSWORD' || createdAtMs == null || Date.now() - createdAtMs > PASSWORD_BIND_LINK_TTL_MS) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, FEISHU_PENDING_INVALID_TEXT);
    }
    const user = await currentUser(userId);
    if (user?.disabled) throw new BusinessException(ErrorCode.PARAM_INVALID, FEISHU_DISABLED_TEXT);
    return sendJson(reply, 200, ok({
      senderName: row.event.senderName ?? null,
      chatType: row.event.chatType,
      expiresAt: new Date(createdAtMs + PASSWORD_BIND_LINK_TTL_MS).toISOString(),
      currentUser: user == null ? null : { id: userId, username: user.username },
      willRebind: (await deps.repository.getStatus(userId)).bound,
    }));
  });
  app.post('/v1/feishu/binding/complete', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    const body = request.body as { state?: unknown } | undefined;
    const state = typeof body?.state === 'string' ? body.state.trim() : '';
    if (state === '') throw new BusinessException(ErrorCode.PARAM_INVALID, FEISHU_PENDING_INVALID_TEXT);
    const row = await pending.findByState(state);
    const senderName = row?.event.senderName ?? null;
    const createdAtMs = parseSqlTimeMs(row?.createdAt ?? null);
    if (row == null || row.bindingMethod !== 'PASSWORD' || createdAtMs == null || Date.now() - createdAtMs > PASSWORD_BIND_LINK_TTL_MS) {
      return sendJson(reply, 200, ok({ status: 'failed', message: FEISHU_PENDING_INVALID_TEXT, senderName }));
    }
    const user = await currentUser(userId);
    if (user?.disabled) return sendJson(reply, 200, ok({ status: 'failed', message: FEISHU_DISABLED_TEXT, senderName }));
    try {
      const outcome = await completePendingAfterBind<FeishuPendingBindingMessage>({
        state, bindUserId: userId,
        claim: (value) => pending.claim(value), unionIdOf: feishuUnionIdOf,
        findUserIdByUnionId: (unionId) => deps.repository.findUserIdByUnionId(unionId),
        bind: (uid, unionId) => deps.repository.bind(uid, unionId), replay: replayPending,
        complete: (value) => pending.complete(value), markReplayed: (value) => pending.markReplayed(value), release: (value) => pending.release(value),
        failClaimed: (value) => pending.failClaimed(value), notifyMismatch: deps.notifyMismatch,
      });
      return sendJson(reply, 200, ok(bindOutcomeToResult(outcome, { channelLabel: '飞书', senderName })));
    } catch (error) {
      return sendJson(reply, 200, ok({ status: 'failed', message: error instanceof Error ? error.message : '绑定失败，请稍后重试', senderName }));
    }
  });
}
