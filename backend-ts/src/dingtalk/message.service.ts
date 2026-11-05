import type { DingtalkConversation, DingtalkGroupLog, MysqlDingtalkMessageRepository } from './message.repository.js';
import type { DingtalkInboundContext, DingtalkNormalizedMessage } from './types.js';

export interface DingtalkSessionFactory {
  create(accountId: string, context: DingtalkInboundContext): Promise<{ sessionId: number; ownerUserId: number; workspace?: string | null }>;
}

const GROUP_CONTEXT_TITLE = '【群内 @ 机器人的最近往来】（不是完整群聊）';

export class DingtalkMessageService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: MysqlDingtalkMessageRepository,
    private readonly sessionFactory: DingtalkSessionFactory,
    private readonly contextWindow = 10,
    private readonly maxMinutes = 120,
  ) {}

  findActive(accountId: string, conversationId: string): Promise<DingtalkConversation | null> {
    return this.repository.findConversation(Number(accountId), conversationId);
  }

  async getOrCreate(accountId: string, context: DingtalkInboundContext, ownerUserId: number): Promise<DingtalkConversation> {
    const botId = Number(accountId);
    return this.withConversationLock(accountId, context.conversationId, async () => {
      const existing = await this.repository.findConversation(botId, context.conversationId);
      if (existing != null) return existing;
      const created = await this.sessionFactory.create(accountId, context);
      return this.repository.saveConversation({
        botId,
        conversationId: context.conversationId,
        chatType: context.chatType,
        sessionId: created.sessionId,
        ownerUserId,
        workspace: created.workspace ?? null,
        title: null,
      });
    });
  }

  /** `---` 新建：新 session 行，指针切过去。工作区仍由 factory 按用户固定。 */
  async createP2pSession(accountId: string, context: DingtalkInboundContext, ownerUserId: number): Promise<DingtalkConversation> {
    return this.withConversationLock(accountId, context.conversationId, async () => {
      const created = await this.sessionFactory.create(accountId, context);
      return this.repository.saveConversation({
        botId: Number(accountId),
        conversationId: context.conversationId,
        chatType: 'p2p',
        sessionId: created.sessionId,
        ownerUserId,
        workspace: created.workspace ?? null,
        title: null,
      });
    });
  }

  claimInbound(accountId: string, message: DingtalkNormalizedMessage): Promise<boolean> {
    return this.repository.claimInboundMessage(Number(accountId), message.messageId, message.conversationId);
  }

  releaseInbound(accountId: string, messageId: string): Promise<void> {
    return this.repository.releaseInboundMessage(Number(accountId), messageId);
  }

  completeInbound(accountId: string, messageId: string): Promise<void> {
    return this.repository.completeInboundMessage(Number(accountId), messageId);
  }

  recordGroupInbound(accountId: string, message: DingtalkNormalizedMessage): Promise<number> {
    return this.repository.appendGroupMessage({
      botId: Number(accountId),
      conversationId: message.conversationId,
      senderUserid: message.senderUserid ?? '',
      senderName: message.senderName || '未知用户',
      direction: 'IN',
      content: message.text,
      messageId: message.messageId,
    });
  }

  recordGroupOutbound(botId: number, conversationId: string, content: string, messageId?: string | null): Promise<number> {
    const summary = content.length > 200 ? `${content.slice(0, 200)}…` : content;
    return this.repository.appendGroupMessage({
      botId,
      conversationId,
      senderUserid: 'bot',
      senderName: '机器人',
      direction: 'OUT',
      content: summary,
      messageId: messageId ?? null,
    });
  }

  async addMember(accountId: string, conversationId: string, userId: number, userid: string, displayName: string | null): Promise<void> {
    await this.repository.addMember(Number(accountId), conversationId, userId, userid, displayName);
  }

  /**
   * 只格式化已落库的 @ 往来。调用方应在写入本条之前取上下文，避免本条重复出现。
   * excludeMessageIds 支持一次排除多条：合并窗口把连续多条 @ 合并为一次触发时，
   * 批内全部消息都已落库，只排除末条会让批内其余消息作为「历史」重复注入。
   */
  async buildGroupContext(accountId: string, conversationId: string, excludeMessageIds: readonly string[] = []): Promise<string> {
    const rows = await this.repository.listGroupMessages(Number(accountId), conversationId, this.contextWindow + 1, this.maxMinutes);
    const kept = rows
      .filter((row) => excludeMessageIds.length === 0 || row.messageId == null || !excludeMessageIds.includes(row.messageId))
      .slice(0, this.contextWindow)
      .reverse();
    if (kept.length === 0) return '';
    return `${GROUP_CONTEXT_TITLE}\n${kept.map(formatLogLine).join('\n')}`;
  }

  private async withConversationLock<T>(accountId: string, conversationId: string, fn: () => Promise<T>): Promise<T> {
    const key = `${accountId}:${conversationId}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

function formatLogLine(row: DingtalkGroupLog): string {
  const clock = row.createdAt != null && row.createdAt.length >= 16 ? row.createdAt.slice(11, 16) : '--:--';
  const name = row.direction === 'OUT' ? '机器人' : (row.senderName || '未知用户');
  return `[${clock}] ${name}：${row.content ?? ''}`;
}

export { GROUP_CONTEXT_TITLE };
