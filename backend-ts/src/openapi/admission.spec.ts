import { describe, expect, it, vi } from 'vitest';
import {
  OpenRunAdmissionService,
  OPEN_RUN_ADMISSION_POLICY_VERSION,
  type OpenRunAdmissionDeps,
} from './admission.js';
import type { ApiToken, WebhookTrigger } from './types.js';
import type { SignalWatcher } from '../signal/types.js';

const NOW = new Date('2026-11-04T12:00:00+08:00');

function token(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: 3,
    userId: 7,
    name: 'token',
    scopes: JSON.stringify(['open:run']),
    expiresAt: null,
    revokedAt: null,
    autoDisabledAt: null,
    ...overrides,
  };
}

function trigger(overrides: Partial<WebhookTrigger> = {}): WebhookTrigger {
  return {
    id: 5,
    userId: 7,
    agentId: 9,
    sessionId: 11,
    name: 'hook',
    enabled: 1,
    ...overrides,
  };
}

function watcher(overrides: Partial<SignalWatcher> = {}): SignalWatcher {
  return {
    id: 13,
    userId: 7,
    agentId: 9,
    name: 'watch',
    url: 'https://example.com',
    method: 'GET',
    headersJson: null,
    body: null,
    intervalMinutes: 5,
    compareMode: 'HASH',
    jsonPath: null,
    promptTemplate: 'x',
    status: 'ACTIVE',
    lastValueHash: null,
    lastValueSnippet: null,
    lastCheckedAt: null,
    lastChangedAt: null,
    consecutiveFailures: 0,
    triggerMode: 'REUSE_SESSION',
    reuseSessionId: 11,
    ...overrides,
  };
}

function makeService(rows: {
  token?: ApiToken | null;
  trigger?: WebhookTrigger | null;
  watcher?: SignalWatcher | null;
} = {}): {
  service: OpenRunAdmissionService;
  tokens: { findById: ReturnType<typeof vi.fn> };
  triggers: { findById: ReturnType<typeof vi.fn> };
  watchers: { findById: ReturnType<typeof vi.fn> };
} {
  const tokens = { findById: vi.fn(async () => rows.token === undefined ? token() : rows.token) };
  const triggers = { findById: vi.fn(async () => rows.trigger === undefined ? trigger() : rows.trigger) };
  const watchers = { findById: vi.fn(async () => rows.watcher === undefined ? watcher() : rows.watcher) };
  const deps: OpenRunAdmissionDeps = { tokens, triggers, watchers, now: () => NOW };
  return { service: new OpenRunAdmissionService(deps), tokens, triggers, watchers };
}

async function expectRejected(promise: Promise<void>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: 3054, message: '触发来源未通过准入' });
}

describe('OpenRunAdmissionService', () => {
  it('策略版本固定为 v1', () => {
    expect(OPEN_RUN_ADMISSION_POLICY_VERSION).toBe('open-run-admission/v1');
  });

  describe('API Token', () => {
    const input = {
      userId: 7,
      agentId: 9,
      source: 'API' as const,
      binding: { kind: 'API_TOKEN' as const, tokenId: 3 },
    };

    it('归属正确、未吊销、未过期、未自动停用且含 open:run 时放行', async () => {
      const h = makeService();
      await expect(h.service.assertAllowed(input)).resolves.toBeUndefined();
      expect(h.tokens.findById).toHaveBeenCalledWith(3);
      expect(h.triggers.findById).not.toHaveBeenCalled();
      expect(h.watchers.findById).not.toHaveBeenCalled();
    });

    it('缺失绑定、Token 不存在、归属错误均拒绝', async () => {
      await expectRejected(makeService().service.assertAllowed({ ...input, binding: null }));
      await expectRejected(makeService({ token: null }).service.assertAllowed(input));
      await expectRejected(makeService({ token: token({ userId: 8 }) }).service.assertAllowed(input));
    });

    it('scope 缺失或 JSON 非法拒绝', async () => {
      for (const scopes of [null, '[]', JSON.stringify(['open:read']), 'not-json', '{"open:run":true}']) {
        await expectRejected(makeService({ token: token({ scopes }) }).service.assertAllowed(input));
      }
    });

    it('吊销、自动停用、已过期拒绝', async () => {
      await expectRejected(makeService({ token: token({ revokedAt: '2026-11-01 00:00:00' }) }).service.assertAllowed(input));
      await expectRejected(makeService({ token: token({ autoDisabledAt: '2026-11-01 00:00:00' }) }).service.assertAllowed(input));
      await expectRejected(makeService({ token: token({ expiresAt: '2026-11-04 11:59:00' }) }).service.assertAllowed(input));
    });

    it('未到期放行；过期边界按字符串字典序比较', async () => {
      await expect(makeService({ token: token({ expiresAt: '2026-11-04 12:00:01' }) }).service.assertAllowed(input)).resolves.toBeUndefined();
      await expectRejected(makeService({ token: token({ expiresAt: '2026-11-04 12:00:00' }) }).service.assertAllowed(input));
    });
  });

  describe('Webhook Trigger', () => {
    const input = {
      userId: 7,
      agentId: 9,
      sessionId: 11,
      source: 'WEBHOOK' as const,
      binding: { kind: 'WEBHOOK_TRIGGER' as const, triggerId: 5 },
    };

    it('归属/Agent/Session 一致且启用时放行', async () => {
      const h = makeService();
      await expect(h.service.assertAllowed(input)).resolves.toBeUndefined();
      expect(h.triggers.findById).toHaveBeenCalledWith(5);
    });

    it('不存在、归属错误、Agent 不一致、Session 不一致、停用均拒绝', async () => {
      await expectRejected(makeService({ trigger: null }).service.assertAllowed(input));
      await expectRejected(makeService({ trigger: trigger({ userId: 8 }) }).service.assertAllowed(input));
      await expectRejected(makeService({ trigger: trigger({ agentId: 10 }) }).service.assertAllowed(input));
      await expectRejected(makeService({ trigger: trigger({ sessionId: 12 }) }).service.assertAllowed(input));
      await expectRejected(makeService({ trigger: trigger({ enabled: 0 }) }).service.assertAllowed(input));
    });

    it('触发器绑定新建会话（NULL）时，请求不得指定 sessionId', async () => {
      await expect(
        makeService({ trigger: trigger({ sessionId: null }) }).service.assertAllowed({ ...input, sessionId: null }),
      ).resolves.toBeUndefined();
      await expectRejected(
        makeService({ trigger: trigger({ sessionId: null }) }).service.assertAllowed({ ...input, sessionId: 11 }),
      );
    });
  });

  describe('Signal Watcher', () => {
    const input = {
      userId: 7,
      agentId: 9,
      sessionId: 11,
      source: 'SIGNAL' as const,
      binding: { kind: 'SIGNAL_WATCHER' as const, watcherId: 13 },
    };

    it('归属/Agent 一致、ACTIVE、复用指针匹配时放行', async () => {
      const h = makeService();
      await expect(h.service.assertAllowed(input)).resolves.toBeUndefined();
      expect(h.watchers.findById).toHaveBeenCalledWith(13);
    });

    it('不存在、归属错误、Agent 不一致、非 ACTIVE 拒绝', async () => {
      await expectRejected(makeService({ watcher: null }).service.assertAllowed(input));
      await expectRejected(makeService({ watcher: watcher({ userId: 8 }) }).service.assertAllowed(input));
      await expectRejected(makeService({ watcher: watcher({ agentId: 10 }) }).service.assertAllowed(input));
      await expectRejected(makeService({ watcher: watcher({ status: 'PAUSED' }) }).service.assertAllowed(input));
      await expectRejected(makeService({ watcher: watcher({ status: 'DISABLED' }) }).service.assertAllowed(input));
    });

    it('请求带 sessionId 时必须为 REUSE_SESSION 且等于复用指针', async () => {
      await expectRejected(makeService({ watcher: watcher({ triggerMode: 'NEW_SESSION' }) }).service.assertAllowed(input));
      await expectRejected(makeService({ watcher: watcher({ reuseSessionId: 12 }) }).service.assertAllowed(input));
      await expectRejected(makeService({ watcher: watcher({ reuseSessionId: null }) }).service.assertAllowed(input));
    });

    it('请求不带 sessionId（首触/新建）时不校验复用指针', async () => {
      await expect(
        makeService({ watcher: watcher({ triggerMode: 'NEW_SESSION', reuseSessionId: null }) })
          .service.assertAllowed({ ...input, sessionId: null }),
      ).resolves.toBeUndefined();
    });
  });

  it('来源与绑定类型不匹配时拒绝，且不读取任何仓储', async () => {
    const h = makeService();
    await expectRejected(h.service.assertAllowed({
      userId: 7, agentId: 9, source: 'API', binding: { kind: 'WEBHOOK_TRIGGER', triggerId: 5 },
    }));
    await expectRejected(h.service.assertAllowed({
      userId: 7, agentId: 9, source: 'WEBHOOK', binding: { kind: 'SIGNAL_WATCHER', watcherId: 13 },
    }));
    await expectRejected(h.service.assertAllowed({
      userId: 7, agentId: 9, source: 'SIGNAL', binding: { kind: 'API_TOKEN', tokenId: 3 },
    }));
    expect(h.tokens.findById).not.toHaveBeenCalled();
    expect(h.triggers.findById).not.toHaveBeenCalled();
    expect(h.watchers.findById).not.toHaveBeenCalled();
  });
});
