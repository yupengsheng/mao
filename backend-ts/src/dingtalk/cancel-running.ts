import type { Session } from '../session/types.js';

/**
 * 进度卡「取消任务」与私聊 `---` 的终态策略。
 * 内存里已有循环时只靠取消标志收尾，不提前写 CANCELLED。
 * 仅当内存里没有执行、库里仍是 RUNNING/RESUMING 时才补写终态并排空队列。
 */
export async function persistDingtalkCancelIfIdle(options: {
  sessionId: number;
  hadLoop: boolean;
  persistCancelledIfActive: (sessionId: number) => Promise<boolean>;
  drainNextIfPending: (sessionId: number) => Promise<void>;
}): Promise<boolean> {
  if (options.hadLoop) return true;
  const persisted = await options.persistCancelledIfActive(options.sessionId);
  if (persisted) {
    void options.drainNextIfPending(options.sessionId).catch((error) => {
      console.error(`钉钉取消后队列接力失败, sessionId=${options.sessionId}`, error);
    });
  }
  return persisted;
}
export async function persistDingtalkCancelIfActive(sessionId: number, deps: {
  sessionService: {
    getSession(sessionId: number): Promise<Pick<Session, 'userId' | 'phase'> | null>;
    cleanupIncompleteTail(sessionId: number): Promise<unknown>;
  };
  taskTerminal: { cancelActiveExecution(sessionId: number, userId: number): Promise<void> };
  progressRepo: { deleteBySessionId(sessionId: number): Promise<unknown> };
}): Promise<boolean> {
  const session = await deps.sessionService.getSession(sessionId).catch(() => null);
  if (session == null || (session.phase !== 'RUNNING' && session.phase !== 'RESUMING')) return false;
  await deps.sessionService.cleanupIncompleteTail(sessionId);
  await deps.taskTerminal.cancelActiveExecution(sessionId, session.userId);
  await deps.progressRepo.deleteBySessionId(sessionId).catch(() => undefined);
  return true;
}
