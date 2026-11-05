import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Message, Session } from '../domain/types.js';
import {
  ExecutionWaitPendingError,
  LeaseConflictError,
  LeaseUnavailableError,
  type TaskNotifySource,
} from '../session/task-terminal.service.js';
import type { SessionSource } from '../session/session.repository.js';
import { withSessionLock } from '../schedule/scheduled-task.service.js';
import { isActivePhase } from '../session/session-vo.js';
import type { MessageQueueSource } from '../session/types.js';
import type { OpenRunAdmission, OpenRunAdmissionBinding } from './admission.js';
import type { ExternalEventRef, ExternalEventTrace } from '../task/types.js';
import type { LeaseHandle } from '../task/execution-lease.service.js';

/** 开放触发支持的消息长度上限（技术方案 §5.3）。 */
export const OPEN_RUN_MESSAGE_MAX_LENGTH = 32000;

/** 与 ScheduledTaskService.executeTask 同构的精简执行依赖（决策 2：不重构 schedule 域）。 */
export interface OpenRunDeps {
  sessionService: {
    getSession(id: number): Promise<Session | null>;
    updatePhase(sessionId: number, phase: string): Promise<void>;
    deleteMessageById?(sessionId: number, messageId: number): Promise<void>;
    deleteSession?(sessionId: number): Promise<void>;
    saveMessage(sessionId: number, role: string, content: unknown, a: null, b: null, c: null, d: number, e: null): Promise<Message>;
    /**
     * 位置签名必须与 SessionService.createSession（session.service.ts:97-114）逐位一致：
     * 装配层是 `sessionService as unknown as OpenRunDeps['sessionService']` 强转，
     * 两边不一致编译期不报警，调用处数错位参会把 source 静默写进 workspace/gitCloneUrl。
     * source 是第 16 个位置参数，中间 11 个位置传 undefined。
     */
    createSession(
      userId: number,
      agentId: number | null | undefined,
      title: string | null | undefined,
      executionMode?: string | null,
      workspace?: string | null,
      permissionLevel?: string | null,
      isGit?: boolean | null,
      platform?: string | null,
      shellPath?: string | null,
      osVersion?: string | null,
      modelId?: number | null,
      cloudProjectKey?: string | null,
      workspaceMode?: string | null,
      gitCloneUrl?: string | null,
      gitBranch?: string | null,
      source?: SessionSource | null,
    ): Promise<Session>;
  };
  messageQueueService: {
    enqueue(sessionId: number, userId: number, content: string, images: string | null, scheduledTaskId?: number | null, source?: MessageQueueSource | null, openTriggerId?: number | null, openCallLogId?: number | null, externalEventId?: string | null, externalEventScope?: string | null): Promise<unknown>;
  };
  harnessService: {
    executeFromEvent(sessionId: number, executionId: string, listener: unknown, cancelFlag?: unknown, lease?: LeaseHandle | null): Promise<void>;
  };
  taskTerminalService: {
    beginExecution?(sessionId: number, executionId: string, source?: TaskNotifySource, externalEvent?: ExternalEventRef | null): Promise<{ duplicate: boolean; lease: LeaseHandle | null }>;
    finishExecution(
      sessionId: number,
      userId: number,
      phase: string,
      executionId: string,
      reason?: string,
      notifySource?: TaskNotifySource,
      lease?: LeaseHandle | null,
    ): Promise<{ settled: boolean }>;
    releaseExecutionLease?(lease: LeaseHandle | null | undefined): Promise<void>;
  };
  agentLookup: {
    findById(id: number): Promise<{ id?: number; name?: string | null; enabled?: number | null } | null>;
  };
  /** WS handler 在途执行判定（hasExecutionClaim），与 schedule 域同源注入。 */
  isSessionBusy: (sessionId: number) => boolean;
  /**
   * 用量预算 BLOCK 闸门（技术方案 §5.7，可选注入）：withSessionLock 之前检查，
   * 命中抛 BusinessException(BUDGET_EXCEEDED) → Result 信封 code≠0。
   */
  budgetCheck?: (target: { userId: number; agentId: number }) => Promise<{ message: string } | null>;
  /** 注入的 live WS 执行路径（createScheduledLiveExecution）；null 时走 no-op listener 兜底。 */
  liveExecution: ((session: Session, userId: number, executionId: string, savedMessage: Message, startedAt?: number, scheduledTaskId?: number | null, source?: 'SCHEDULED' | 'WEBHOOK' | 'API' | 'SIGNAL' | null, externalEvent?: ExternalEventRef | null, lease?: LeaseHandle | null) => Promise<void>) | null;
  /** 任务域外部事件查询：入口预检查，命中直接返回 deduplicated。 */
  findExternalEvent?: (scope: string, id: string) => Promise<ExternalEventTrace | null>;
  /**
   * 触发来源准入（可选注入；生产装配必须注入）。
   * 未注入时保持既有测试/装配兼容，注入后失败关闭：缺失或不匹配的绑定一律拒绝。
   */
  admission?: OpenRunAdmission;
}

export interface OpenRunInput {
  userId: number;
  agentId: number;
  message: string;
  /** 给定则复用该会话（归属/主会话/云端校验），否则每次新建会话。 */
  sessionId?: number | null;
  source: Extract<TaskNotifySource, 'API' | 'WEBHOOK' | 'SIGNAL'>;
  /** WEBHOOK 来源时的触发器绑定（busy 入队后由消费侧回写失败计数）。 */
  triggerId?: number | null;
  /** 入站调用流水 id，busy 入队后由消费侧回写终态。 */
  callLogId?: number | null;
  /** 本次触发链的显式身份绑定；由各来源入口传入，不读取请求可写字段。 */
  admissionBinding?: OpenRunAdmissionBinding | null;
  /** 外部事件身份（API Idempotency-Key / Webhook X-Mao-Event-Id）。 */
  externalEvent?: ExternalEventRef | null;
}

export interface OpenRunResult {
  sessionId: number;
  messageId: number | null;
  queued: boolean;
  /**
   * 直跑路径的真实终态（回读会话 phase；FAILED/CANCELLED 不得标 COMPLETED）。
   * queued=true 时为占位值——该执行尚未发生，真实终态由队列消费侧回写，此处无人消费。
   */
  terminalPhase: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  /** 同一外部事件已由任务域认领：未新建 Trigger/Execution，也未调用 Harness。 */
  deduplicated?: boolean;
}

function terminalPhaseOf(status: ExternalEventTrace['status']): 'COMPLETED' | 'FAILED' | 'CANCELLED' {
  return status === 'FAILED' || status === 'CANCELLED' ? status : 'COMPLETED';
}

function noopListener(): Record<string, () => void> {
  return { onContentDelta() {}, onToolCallStart() {}, onToolCallResult() {}, onMessageEnd() {}, onError() {} };
}

/**
 * 开放接口统一触发执行流：API Token（P1）与入站 Webhook 触发器（P2）共用。
 * 与 ScheduledTaskService.executeTask 精简同构——无 cron 档期推进/在飞守卫/IM 回流，
 * 会话锁复用 schedule 域导出的 withSessionLock（决策 16）。
 */
export class OpenRunService {
  constructor(private readonly deps: OpenRunDeps) {}

  async run(input: OpenRunInput): Promise<OpenRunResult> {
    const message = input.message ?? '';
    const trimmed = message.trim();
    if (trimmed.length === 0 || message.length > OPEN_RUN_MESSAGE_MAX_LENGTH) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `message 需为 1~${OPEN_RUN_MESSAGE_MAX_LENGTH} 字`);
    }
    const agent = await this.deps.agentLookup.findById(input.agentId);
    if (agent == null || agent.id == null) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    if (agent.enabled === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该 Agent 已停用，无法触发');
    }
    // 准入必须在预算与会话创建/复用之前：拒绝时不得留下空会话、消息或排队项。
    await this.assertAdmission(input);
    // 任务域去重先于预算检查：重复事件既不该重复扣费，也不该因预算变化被拒。
    const duplicate = await this.externalEventTrace(input);
    if (duplicate != null) {
      return {
        sessionId: duplicate.sessionId,
        messageId: null,
        queued: false,
        terminalPhase: terminalPhaseOf(duplicate.status),
        deduplicated: true,
      };
    }
    // 预算 BLOCK 在会话创建/复用与 withSessionLock 之前：拒绝时不留下孤儿空会话（技术方案 §5.7）
    if (this.deps.budgetCheck != null) {
      const blocked = await this.deps.budgetCheck({ userId: input.userId, agentId: input.agentId });
      if (blocked != null) {
        throw new BusinessException(ErrorCode.BUDGET_EXCEEDED, blocked.message);
      }
    }

    let session: Session;
    if (input.sessionId != null) {
      const loaded = await this.deps.sessionService.getSession(input.sessionId);
      // 归属不匹配与不存在统一按不存在处理：不向机器身份泄露会话存在性
      if (loaded == null || loaded.userId !== input.userId) {
        throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      }
      if (loaded.sessionType === 'SUBAGENT' || loaded.sessionType === 'SIDE_TASK') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '开放触发仅支持主会话');
      }
      if (loaded.executionMode === 'LOCAL') {
        // 决策 13：LOCAL 依赖桌面在线，机器触发场景失败只会累积触发器自动停用计数
        throw new BusinessException(ErrorCode.PARAM_INVALID, '开放触发仅支持云端执行会话');
      }
      if (loaded.agentId !== input.agentId) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '只能触发该会话所属的 Agent');
      }
      session = loaded;
    } else {
      // 显式 CLOUD（不依赖 createSession 默认值）；权限档位/工作区留空走默认。
      // source 是 createSession 的第 16 个位置参数，中间 11 个位置全部显式传 undefined
      // （装配层 as unknown as 强转，接口与真实签名不一致编译期不报警，错位=静默丢 source）。
      // 映射：SIGNAL → 'signal'（独立分组，技术方案 2026-10-27 §3.3.1）；
      // API/WEBHOOK 共用此调用点，统一落 'openapi'（技术方案 2026-10-29 §2.1-2），不再回落 'web'。
      session = await this.deps.sessionService.createSession(
        input.userId,
        agent.id,
        null,
        'CLOUD',
        undefined, // workspace
        undefined, // permissionLevel
        undefined, // isGit
        undefined, // platform
        undefined, // shellPath
        undefined, // osVersion
        undefined, // modelId
        undefined, // cloudProjectKey
        undefined, // workspaceMode
        undefined, // gitCloneUrl
        undefined, // gitBranch
        input.source === 'SIGNAL' ? 'signal' : 'openapi',
      );
    }
    const sessionId = session.id;
    if (sessionId == null) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '会话创建失败');
    }

    return withSessionLock(sessionId, async () => {
      // 锁内重读：排队期间会话可能被并发改相位/删除
      const latest = await this.deps.sessionService.getSession(sessionId);
      if (latest == null) {
        throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      }
      if (latest.agentId !== input.agentId) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '只能触发该会话所属的 Agent');
      }
      const busy = this.deps.isSessionBusy(sessionId) || isActivePhase(latest.phase);
      if (busy) {
        // 忙则排队：落 source_type + open_trigger_id 两列（类比 scheduledTaskId 回写绑定）
        await this.deps.messageQueueService.enqueue(
          sessionId, input.userId, message, null, null, input.source, input.triggerId ?? null, input.callLogId ?? null,
          input.externalEvent?.id ?? null, input.externalEvent?.scope ?? null,
        );
        return { sessionId, messageId: null, queued: true, terminalPhase: 'COMPLETED' as const };
      }

      const executionId = randomUUID();
      const startedAt = Date.now();
      const previousPhase = latest.phase ?? 'IDLE';
      const begun = await this.beginExecution(sessionId, executionId, input);
      if (begun.duplicate) {
        await this.deps.sessionService.updatePhase(sessionId, previousPhase).catch(() => undefined);
        await this.rollbackDuplicateAttempt(input, sessionId, null);
        const duplicate = await this.externalEventTrace(input);
        return {
          sessionId: duplicate?.sessionId ?? sessionId,
          messageId: null,
          queued: false,
          terminalPhase: duplicate == null ? 'CANCELLED' as const : terminalPhaseOf(duplicate.status),
          deduplicated: true,
        };
      }
      await this.deps.sessionService.updatePhase(sessionId, 'RUNNING');
      let savedMessage: Message;
      try {
        savedMessage = await this.deps.sessionService.saveMessage(sessionId, 'USER', message, null, null, null, 0, null);
      } catch (e) {
        await this.deps.sessionService.updatePhase(sessionId, previousPhase).catch(() => undefined);
        await this.deps.taskTerminalService.releaseExecutionLease?.(begun.lease).catch(() => undefined);
        throw e;
      }

      let terminalPhase: 'COMPLETED' | 'FAILED' | 'CANCELLED';
      if (this.deps.liveExecution != null) {
        // liveExecution（runExecution）内部吞掉失败/取消并落终态后正常返回，
        // 必须回读会话真实终态（照抄 executeTask 的回读逻辑）
        await this.deps.liveExecution(
          session, input.userId, executionId, savedMessage, startedAt, null,
          input.source, input.externalEvent ?? null, begun.lease,
        );
        const after = await this.deps.sessionService.getSession(sessionId);
        const actual = after?.phase;
        terminalPhase = actual === 'FAILED' || actual === 'CANCELLED' ? actual : 'COMPLETED';
        const racedDuplicate = await this.externalEventTrace(input);
        if (racedDuplicate != null && racedDuplicate.executionId !== executionId) {
          await this.rollbackDuplicateAttempt(input, sessionId, savedMessage.id ?? null);
          return {
            sessionId: racedDuplicate.sessionId, messageId: null, queued: false,
            terminalPhase: terminalPhaseOf(racedDuplicate.status), deduplicated: true,
          };
        }
      } else {
        // 兜底路径（测试/装配缺失）：显式落 COMPLETED 终态并带来源
        await this.deps.harnessService.executeFromEvent(sessionId, executionId, noopListener(), null, begun.lease);
        await this.deps.taskTerminalService.finishExecution(
          sessionId, input.userId, 'COMPLETED', executionId, undefined, input.source, begun.lease,
        );
        terminalPhase = 'COMPLETED';
      }
      return { sessionId, messageId: savedMessage.id ?? null, queued: false, terminalPhase };
    });
  }

  private async externalEventTrace(input: OpenRunInput): Promise<ExternalEventTrace | null> {
    if (input.externalEvent == null || this.deps.findExternalEvent == null) return null;
    return this.deps.findExternalEvent(input.externalEvent.scope, input.externalEvent.id);
  }

  /**
   * 租约门禁必须先于阶段写入与消息落库。等待态/租约冲突都属于“当前不可执行”，
   * 统一收敛为业务错误，避免开放接口把 500 暴露给调用方。
   */
  private async beginExecution(sessionId: number, executionId: string, input: OpenRunInput) {
    if (this.deps.taskTerminalService.beginExecution == null) {
      return { duplicate: false, lease: null };
    }
    try {
      return await this.deps.taskTerminalService.beginExecution(
        sessionId, executionId, input.source, input.externalEvent ?? null,
      );
    } catch (error) {
      if (error instanceof ExecutionWaitPendingError || error instanceof LeaseConflictError) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '会话当前不可执行，请稍后重试');
      }
      if (error instanceof LeaseUnavailableError) {
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, '执行租约不可用，请稍后重试');
      }
      throw error;
    }
  }

  private async rollbackDuplicateAttempt(input: OpenRunInput, sessionId: number, messageId: number | null): Promise<void> {
    if (messageId != null) {
      await this.deps.sessionService.deleteMessageById?.(sessionId, messageId).catch((e) => {
        console.warn(`[openapi] failed to delete duplicate event message ${messageId}: ${(e as Error).message}`);
      });
    }
    if (input.sessionId == null) {
      await this.deps.sessionService.deleteSession?.(sessionId).catch((e) => {
        console.warn(`[openapi] failed to delete duplicate event session ${sessionId}: ${(e as Error).message}`);
      });
    }
  }

  private async assertAdmission(input: OpenRunInput): Promise<void> {
    const admission = this.deps.admission;
    if (admission == null) return;
    try {
      await admission.assertAllowed({
        userId: input.userId,
        agentId: input.agentId,
        sessionId: input.sessionId ?? null,
        source: input.source,
        binding: input.admissionBinding ?? null,
      });
    } catch (e) {
      // 已知拒绝/不可用原样透传；依赖抛出的未知异常统一失败关闭为 503。
      if (
        e instanceof BusinessException
        && (e.code === ErrorCode.ADMISSION_REJECTED.code || e.code === ErrorCode.ADMISSION_UNAVAILABLE.code)
      ) {
        throw e;
      }
      throw new BusinessException(ErrorCode.ADMISSION_UNAVAILABLE);
    }
  }
}
