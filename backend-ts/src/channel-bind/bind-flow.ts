import type { FeishuNormalizedMessage } from '../feishu/types.js';

/** 飞书 / 钉钉 pending 行的最小结构形状。绑定确认只依赖发送者身份、状态和补投回调。 */
export interface ChannelPendingRow {
  state: string;
  event: {
    senderUnionId?: string | null;
    senderId?: string | null;
    senderUserid?: string | null;
  };
}

export type ChannelBindOutcome = 'no-pending' | 'replayed' | 'identity-mismatch' | 'identity-missing' | 'replay-failed' | 'completion-failed';

export class ChannelBindIdentityConflictError extends Error {
  constructor() {
    super('该通道身份已绑定其他 Mao 账号');
    this.name = 'ChannelBindIdentityConflictError';
  }
}
/** 密码绑定链接有效期：用户需要登录并核对信息，故比 OAuth 链接更长。 */
export const PASSWORD_BIND_LINK_TTL_MS = 15 * 60_000;

export interface ChannelBindResultVO {
  status: 'success' | 'partial' | 'failed';
  message: string;
  senderName: string | null;
}

export function bindOutcomeToResult(
  outcome: ChannelBindOutcome,
  options: { channelLabel: string; senderName: string | null },
): ChannelBindResultVO {
  const { channelLabel, senderName } = options;
  switch (outcome) {
    case 'replayed':
      return { status: 'success', message: '绑定成功，已开始处理你刚才的消息', senderName };
    case 'replay-failed':
      return { status: 'partial', message: '绑定已生效，原消息未恢复，请回 IM 重新发送一条消息', senderName };
    case 'identity-mismatch':
      return { status: 'failed', message: `该${channelLabel}身份已绑定其它 Mao 账号，未改绑`, senderName };
    case 'identity-missing':
      return { status: 'failed', message: `未能识别该${channelLabel}身份，请回 IM 重新发送一条消息`, senderName };
    case 'completion-failed':
      return { status: 'partial', message: '绑定已生效，但状态未确认，请稍后重试或回 IM 重新发送一条消息', senderName };
    case 'no-pending':
      return { status: 'failed', message: '链接已失效或已使用，请回 IM 重新发送一条消息', senderName };
  }
}

export async function completePendingAfterBind<TPending extends ChannelPendingRow>(params: {
  state: string;
  bindUserId: number;
  claim: (state: string) => Promise<TPending | null>;
  unionIdOf: (pending: TPending) => string | null;
  findUserIdByUnionId: (unionId: string) => Promise<number | null>;
  bind: (userId: number, unionId: string, pending: TPending) => Promise<void>;
  replay: (pending: TPending) => Promise<void>;
  complete: (state: string) => Promise<void>;
  markReplayed?: (state: string) => Promise<void>;
  release: (state: string) => Promise<void>;
  failClaimed: (state: string) => Promise<void>;
  notifyMismatch?: (pending: TPending) => Promise<void>;
}): Promise<ChannelBindOutcome> {
  const pending = await params.claim(params.state);
  if (pending == null) return 'no-pending';
  const unionId = params.unionIdOf(pending);
  if (unionId == null || unionId.trim() === '') {
    await params.failClaimed(params.state).catch(() => undefined);
    return 'identity-missing';
  }

  try {
    const existing = await params.findUserIdByUnionId(unionId);
    if (existing != null && existing !== params.bindUserId) {
      await params.failClaimed(params.state);
      try { await params.notifyMismatch?.(pending); } catch (error) {
        console.error(`通道绑定身份不一致通知失败, state=${params.state}`, error);
      }
      return 'identity-mismatch';
    }
    await params.bind(params.bindUserId, unionId, pending);
  } catch (error) {
    if (error instanceof ChannelBindIdentityConflictError) {
      await params.failClaimed(params.state).catch(() => undefined);
      try { await params.notifyMismatch?.(pending); } catch (notifyError) {
        console.error(`通道绑定身份不一致通知失败, state=${params.state}`, notifyError);
      }
      return 'identity-mismatch';
    }
    await params.release(params.state).catch(() => undefined);
    throw error;
  }

  try {
    await params.replay(pending);
  } catch (error) {
    await params.release(params.state).catch(() => undefined);
    console.error(`恢复待绑定消息失败, state=${params.state}`, error);
    return 'replay-failed';
  }

  let replayMarked = false;
  try {
    await params.markReplayed?.(params.state);
    replayMarked = true;
    await params.complete(params.state);
    return 'replayed';
  } catch (error) {
    if (!replayMarked) {
      await params.failClaimed(params.state).catch(() => undefined);
      console.error(`恢复待绑定消息已执行但状态标记失败, state=${params.state}`, error);
      return 'completion-failed';
    }
    // 补投已经受理，不能释放回 SENT，否则重试会再次执行原消息。只重试终态写入。
    try {
      await params.complete(params.state);
      return 'replayed';
    } catch (retryError) {
      await params.failClaimed(params.state).catch(() => undefined);
      console.error(`恢复待绑定消息状态写入失败, state=${params.state}`, retryError);
      return 'completion-failed';
    }
  }
}

export function feishuUnionIdOf(pending: { event: Pick<FeishuNormalizedMessage, 'senderUnionId' | 'senderId'> }): string | null {
  return pending.event.senderUnionId ?? pending.event.senderId ?? null;
}

export function dingtalkUnionIdOf(pending: { event: { senderUnionId?: string | null } }): string | null {
  return pending.event.senderUnionId ?? null;
}

export function channelBindLink(siteBaseUrl: string, path: string, state: string): string {
  const base = siteBaseUrl.trim().replace(/\/+$/, '');
  return `${base}/${path}/${encodeURIComponent(state)}`;
}
