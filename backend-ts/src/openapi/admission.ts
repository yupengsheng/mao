import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { formatDateTime } from '../common/json.js';
import type { SignalWatcher } from '../signal/types.js';
import type { ApiToken, WebhookTrigger } from './types.js';
import { normalizeScopes } from './types.js';

/** 确定性准入策略版本；策略语义变化时必须升级，便于后续任务记录关联。 */
export const OPEN_RUN_ADMISSION_POLICY_VERSION = 'open-run-admission/v1';

export type OpenRunAdmissionSource = 'API' | 'WEBHOOK' | 'SIGNAL';

/**
 * 触发来源的显式身份绑定。准入只信任本次执行链传入的绑定，
 * 不从 message、Session 或请求可写字段反推来源。
 */
export type OpenRunAdmissionBinding =
  | { kind: 'API_TOKEN'; tokenId: number }
  | { kind: 'WEBHOOK_TRIGGER'; triggerId: number }
  | { kind: 'SIGNAL_WATCHER'; watcherId: number };

export interface OpenRunAdmissionInput {
  userId: number;
  agentId: number;
  sessionId?: number | null;
  source: OpenRunAdmissionSource;
  binding?: OpenRunAdmissionBinding | null;
}

export interface OpenRunAdmission {
  assertAllowed(input: OpenRunAdmissionInput): Promise<void>;
}

/** 仅暴露准入所需的最小读取能力，避免领域服务依赖完整管理服务。 */
export interface OpenRunAdmissionDeps {
  tokens: { findById(id: number): Promise<ApiToken | null> };
  triggers: { findById(id: number): Promise<WebhookTrigger | null> };
  watchers: { findById(id: number): Promise<SignalWatcher | null> };
  now?: () => Date;
}

function reject(): never {
  // 固定短语：不暴露绑定是否存在、归属、状态或内部配置细节。
  throw new BusinessException(ErrorCode.ADMISSION_REJECTED);
}

function tokenHasRunScope(scopes: string | null | undefined): boolean {
  try {
    const parsed: unknown = scopes == null ? [] : JSON.parse(scopes);
    return normalizeScopes(parsed).includes('open:run');
  } catch {
    return false;
  }
}

export class OpenRunAdmissionService implements OpenRunAdmission {
  constructor(private readonly deps: OpenRunAdmissionDeps) {}

  async assertAllowed(input: OpenRunAdmissionInput): Promise<void> {
    const binding = input.binding;
    if (binding == null) reject();

    if (input.source === 'API') {
      if (binding.kind !== 'API_TOKEN') reject();
      await this.assertApiToken(binding.tokenId, input);
      return;
    }
    if (input.source === 'WEBHOOK') {
      if (binding.kind !== 'WEBHOOK_TRIGGER') reject();
      await this.assertWebhookTrigger(binding.triggerId, input);
      return;
    }
    if (input.source === 'SIGNAL') {
      if (binding.kind !== 'SIGNAL_WATCHER') reject();
      await this.assertSignalWatcher(binding.watcherId, input);
      return;
    }
    reject();
  }

  private async assertApiToken(tokenId: number, input: OpenRunAdmissionInput): Promise<void> {
    const token = await this.deps.tokens.findById(tokenId);
    if (
      token?.id == null
      || token.userId !== input.userId
      || token.revokedAt != null
      || token.autoDisabledAt != null
      || (token.expiresAt != null && token.expiresAt <= formatDateTime(this.now()))
      || !tokenHasRunScope(token.scopes)
    ) {
      reject();
    }
  }

  private async assertWebhookTrigger(triggerId: number, input: OpenRunAdmissionInput): Promise<void> {
    const trigger = await this.deps.triggers.findById(triggerId);
    if (
      trigger?.id == null
      || trigger.userId !== input.userId
      || trigger.agentId !== input.agentId
      || Number(trigger.enabled) !== 1
      || (trigger.sessionId ?? null) !== (input.sessionId ?? null)
    ) {
      reject();
    }
  }

  private async assertSignalWatcher(watcherId: number, input: OpenRunAdmissionInput): Promise<void> {
    const watcher = await this.deps.watchers.findById(watcherId);
    if (
      watcher?.id == null
      || watcher.userId !== input.userId
      || watcher.agentId !== input.agentId
      || watcher.status !== 'ACTIVE'
    ) {
      reject();
    }
    if (input.sessionId != null) {
      if (watcher.triggerMode !== 'REUSE_SESSION' || watcher.reuseSessionId !== input.sessionId) {
        reject();
      }
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
