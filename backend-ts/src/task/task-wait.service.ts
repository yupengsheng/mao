import type {
  TaskWaitKind,
  TaskWaitObserver,
  TaskWaitReleaseReason,
  TaskWaitStartedInput,
} from '../harness/core/task-wait-observer.js';
import type { Session } from '../session/types.js';
import type { TaskService } from './task.service.js';
import type { ExecutionWaitStore } from './execution-wait.repository.js';
import type { LeaseHandle } from './execution-lease.service.js';

export interface TaskWaitPersistenceOptions {
  enabled: boolean;
  store?: ExecutionWaitStore;
  /** 读取当前执行租约，把真实 fencing token 写入等待行。 */
  leaseLookup?: { getActive(sessionId: number): Promise<LeaseHandle | null> } | null;
}

export class TaskWaitService implements TaskWaitObserver {
  private readonly pending = new Map<number, Map<string, string>>();
  private readonly updates = new Map<number, Promise<void>>();
  /** 同一请求的写库操作必须按开始 → 结束排序，避免 release 先于 insert 留下陈旧 PENDING。 */
  private readonly persistenceQueue = new Map<string, Promise<void>>();

  constructor(
    private readonly taskService: TaskService,
    private readonly sessionLookup: { getSession(sessionId: number): Promise<Session | null> },
    private readonly executionLookup: { getSessionExecution(sessionId: number): string | undefined },
    private readonly persistence: TaskWaitPersistenceOptions = { enabled: false },
  ) {}

  started(input: TaskWaitStartedInput): Promise<void> {
    const { sessionId, kind, requestId } = input;
    const executionId = this.executionLookup.getSessionExecution(sessionId);
    if (!executionId) return Promise.resolve();
    const key = `${kind}:${requestId}`;
    const requests = this.pending.get(sessionId) ?? new Map<string, string>();
    if (requests.has(key)) return this.updates.get(sessionId) ?? Promise.resolve();
    requests.set(key, executionId);
    this.pending.set(sessionId, requests);
    return Promise.all([
      this.project(sessionId, executionId),
      this.enqueuePersistence(sessionId, kind, requestId, () => this.persistStarted(input, executionId)),
    ]).then(() => undefined);
  }

  finished(
    sessionId: number,
    kind: TaskWaitKind,
    requestId: string,
    reason: TaskWaitReleaseReason,
  ): Promise<void> {
    const key = `${kind}:${requestId}`;
    const requests = this.pending.get(sessionId);
    const executionId = requests?.get(key);
    if (executionId == null) return this.updates.get(sessionId) ?? Promise.resolve();
    requests!.delete(key);
    if (requests!.size === 0) this.pending.delete(sessionId);
    return Promise.all([
      this.project(sessionId, executionId),
      this.enqueuePersistence(sessionId, kind, requestId, () => this.persistFinished(sessionId, kind, requestId, reason)),
    ]).then(() => undefined);
  }

  private enqueuePersistence(
    sessionId: number,
    kind: TaskWaitKind,
    requestId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const key = `${sessionId}:${kind}:${requestId}`;
    const previous = this.persistenceQueue.get(key) ?? Promise.resolve();
    const next = previous.then(operation).catch(() => undefined);
    this.persistenceQueue.set(key, next);
    void next.then(() => {
      if (this.persistenceQueue.get(key) === next) this.persistenceQueue.delete(key);
    });
    return next;
  }

  private project(sessionId: number, executionId: string): Promise<void> {
    const blocked = [...(this.pending.get(sessionId)?.values() ?? [])].includes(executionId);
    const update = (this.updates.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        const session = await this.sessionLookup.getSession(sessionId);
        if (session != null) await this.taskService.setExecutionStage(session, executionId, blocked ? 'BLOCKED' : 'WORKING');
      })
      .catch((error: unknown) => {
        console.warn(`[task] failed to project waiting state: sessionId=${sessionId}, executionId=${executionId}`, error);
      })
      .finally(() => {
        if (this.updates.get(sessionId) === update) this.updates.delete(sessionId);
      });
    this.updates.set(sessionId, update);
    return update;
  }

  private async persistStarted(input: TaskWaitStartedInput, executionId: string): Promise<void> {
    if (!this.persistence.enabled || this.persistence.store == null) return;
    try {
      let fencingToken: bigint | undefined;
      if (this.persistence.leaseLookup != null) {
        try {
          const lease = await this.persistence.leaseLookup.getActive(input.sessionId);
          if (lease != null && lease.executionId === executionId) fencingToken = lease.fencingToken;
        } catch (error) {
          console.warn(`[task] failed to read execution lease for waiting state: sessionId=${input.sessionId}`, error);
        }
      }
      await this.persistence.store.insertPending({
        sessionId: input.sessionId,
        executionId,
        requestType: input.kind,
        requestId: input.requestId,
        payloadSummary: input.payloadSummary,
        payloadDigest: input.payloadDigest,
        ...(fencingToken == null ? {} : { fencingToken }),
      });
    } catch (error) {
      console.warn(
        `[task] failed to persist waiting state: sessionId=${input.sessionId}, kind=${input.kind}, requestId=${input.requestId}`,
        error,
      );
    }
  }

  private async persistFinished(
    sessionId: number,
    kind: TaskWaitKind,
    requestId: string,
    reason: TaskWaitReleaseReason,
  ): Promise<void> {
    if (!this.persistence.enabled || this.persistence.store == null) return;
    try {
      await this.persistence.store.release(sessionId, kind, requestId, reason);
    } catch (error) {
      console.warn(
        `[task] failed to release waiting state: sessionId=${sessionId}, kind=${kind}, requestId=${requestId}`,
        error,
      );
    }
  }
}
