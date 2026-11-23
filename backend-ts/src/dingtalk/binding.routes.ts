import type { FastifyInstance, FastifyReply } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { pathParam } from '../common/request.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import {
  bindOutcomeToResult,
  completePendingAfterBind,
  dingtalkUnionIdOf,
} from '../channel-bind/bind-flow.js';
import type { MysqlDingtalkBindingRepository } from './binding.repository.js';
import { dingtalkAuthorizeUrl, oauthConfigured, webOriginOf, type DingtalkOauthConfig } from './oauth-client.js';
import type { MysqlDingtalkOauthStateRepository } from './oauth.repository.js';
import type { DingtalkPendingBindingMessage, MysqlDingtalkPendingBindingRepository } from './pending-binding.repository.js';

const SETTINGS_TTL_MS = 10 * 60 * 1000;
const DINGTALK_PENDING_INVALID_TEXT = '链接已过期或已使用，请回 IM 重新发送一条消息';
const DINGTALK_DISABLED_TEXT = '账号已禁用，无法完成绑定';

export interface DingtalkBindingRouteDeps {
  jwt: JwtService;
  repository: MysqlDingtalkBindingRepository;
  oauthStates: MysqlDingtalkOauthStateRepository;
  oauth: () => Promise<DingtalkOauthConfig>;
  onCallback: (state: string, userId: number, code: string) => Promise<void>;
  pending?: MysqlDingtalkPendingBindingRepository;
  currentUser?: (userId: number) => Promise<{ id: number; username: string | null; disabled: boolean } | null>;
  replayPending?: (pending: DingtalkPendingBindingMessage) => Promise<void>;
}

export function registerDingtalkBindingRoutes(app: FastifyInstance, deps: DingtalkBindingRouteDeps): void {
  app.get('/v1/dingtalk/binding/status', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    return sendJson(reply, 200, ok(await deps.repository.getStatus(userId)));
  });

  app.post('/v1/dingtalk/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    const oauth = await deps.oauth();
    if (!oauthConfigured(oauth)) throw new BusinessException(ErrorCode.PARAM_INVALID, '管理员尚未配置钉钉登录，暂时无法绑定');
    const state = await deps.oauthStates.create(userId, SETTINGS_TTL_MS);
    return sendJson(reply, 200, ok({ authUrl: dingtalkAuthorizeUrl(oauth, state), state }));
  });

  app.delete('/v1/dingtalk/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    await deps.repository.unbind(userId);
    return sendJson(reply, 200, ok(null));
  });

  // 保留现有钉钉 OAuth 绑定入口。
  app.get('/v1/dingtalk/bind/:state', async (request, reply) => {
    const state = pathParam(request, 'state');
    const oauth = await deps.oauth();
    const origin = webOriginOf(oauth.redirectUri);
    const userId = request.userId;
    if (userId == null) {
      if (origin == null) return reply.code(503).type('text/plain').send('管理员尚未配置钉钉登录，暂时无法绑定');
      return reply.redirect(`${origin}/login?redirect=${encodeURIComponent(`/dingtalk/bind/${state}`)}`);
    }
    const attached = await deps.oauthStates.attachUser(state, userId);
    if (attached !== 'OK' || !oauthConfigured(oauth)) return redirectSettings(reply, origin, 'bindError=expired');
    return reply.redirect(dingtalkAuthorizeUrl(oauth, state));
  });

  if (deps.pending != null && deps.currentUser != null && deps.replayPending != null) {
    const pending = deps.pending;
    const currentUser = deps.currentUser;
    const replayPending = deps.replayPending;
    app.get('/v1/dingtalk/binding/pending', async (request, reply) => {
      const userId = requireUserId(request, deps.jwt);
      const state = String((request.query as { state?: string } | undefined)?.state ?? '').trim();
      if (state === '') throw new BusinessException(ErrorCode.PARAM_INVALID, DINGTALK_PENDING_INVALID_TEXT);
      const row = await pending.findByState(state);
      if (row == null || row.bindingMethod !== 'PASSWORD') throw new BusinessException(ErrorCode.PARAM_INVALID, DINGTALK_PENDING_INVALID_TEXT);
      const user = await currentUser(userId);
      if (user?.disabled) throw new BusinessException(ErrorCode.PARAM_INVALID, DINGTALK_DISABLED_TEXT);
      return sendJson(reply, 200, ok({
        senderName: row.event.senderName ?? null,
        chatType: row.event.chatType,
        expiresAt: row.expiresAt == null ? null : new Date(row.expiresAt).toISOString(),
        currentUser: user == null ? null : { id: userId, username: user.username },
        // 当前仓储明确拒绝替换已有其它身份，UI 不展示“确认后替换”文案。
        willRebind: false,
      }));
    });

    app.post('/v1/dingtalk/binding/complete', async (request, reply) => {
      const userId = requireUserId(request, deps.jwt);
      const state = typeof (request.body as { state?: unknown } | undefined)?.state === 'string'
        ? String((request.body as { state: string }).state).trim() : '';
      if (state === '') throw new BusinessException(ErrorCode.PARAM_INVALID, DINGTALK_PENDING_INVALID_TEXT);
      const row = await pending.findByState(state);
      const senderName = row?.event.senderName ?? null;
      if (row == null || row.bindingMethod !== 'PASSWORD') return sendJson(reply, 200, ok({ status: 'failed', message: DINGTALK_PENDING_INVALID_TEXT, senderName }));
      const user = await currentUser(userId);
      if (user?.disabled) return sendJson(reply, 200, ok({ status: 'failed', message: DINGTALK_DISABLED_TEXT, senderName }));
      try {
        const outcome = await completePendingAfterBind<DingtalkPendingBindingMessage>({
          state,
          bindUserId: userId,
          claim: (value) => pending.claim(value),
          unionIdOf: dingtalkUnionIdOf,
          findUserIdByUnionId: (unionId) => deps.repository.findUserIdByUnionId(unionId),
          bind: (uid, unionId, pendingRow) => deps.repository.bind(uid, unionId, pendingRow.event.senderUserid ?? ''),
          replay: replayPending,
          complete: (value) => pending.complete(value),
          release: (value) => pending.release(value),
          failClaimed: (value) => pending.fail(value),
        });
        return sendJson(reply, 200, ok(bindOutcomeToResult(outcome, { channelLabel: '钉钉', senderName })));
      } catch (error) {
        const message = error instanceof Error ? error.message : '绑定失败，请稍后重试';
        return sendJson(reply, 200, ok({ status: 'failed', message, senderName }));
      }
    });
  }

  app.get('/v1/dingtalk/oauth/callback', async (request, reply) => {
    const query = request.query as { code?: string; state?: string };
    const oauth = await deps.oauth();
    const origin = webOriginOf(oauth.redirectUri);
    const state = query.state ?? '';
    const code = query.code ?? '';
    const consumed = state === '' ? null : await deps.oauthStates.consume(state);
    if (consumed?.userId == null || code === '') return redirectSettings(reply, origin, 'bindError=expired');
    try {
      await deps.onCallback(state, consumed.userId, code);
      return redirectSettings(reply, origin, 'bound=1');
    } catch (error) {
      await deps.oauthStates.fail(state).catch(() => undefined);
      const message = error instanceof Error ? error.message : '绑定失败';
      return redirectSettings(reply, origin, `bindError=${encodeURIComponent(message)}`);
    }
  });
}

function redirectSettings(reply: FastifyReply, origin: string | null, query: string): FastifyReply {
  if (origin == null) return reply.code(400).type('text/plain').send(query);
  return reply.redirect(`${origin}/settings/channel-bindings?tab=dingtalk&${query}`);
}
