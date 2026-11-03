import type { TaskWaitKind, TaskWaitObserver } from '../harness/core/task-wait-observer.js';
import type { Session } from '../session/types.js';
import type { TaskService } from './task.service.js';

export class TaskWaitService implements TaskWaitObserver {
  private readonly pending = new Map<number, Map<string, string>>();
  private readonly updates = new Map<number, Promise<void>>();

  constructor(
    private readonly taskService: TaskService,
    private readonly sessionLookup: { getSession(sessionId: number): Promise<Session | null> },
    private readonly executionLookup: { getSessionExecution(sessionId: number): string | undefined },
  ) {}

  started(sessionId: number, kind: TaskWaitKind, requestId: string): Promise<void> {
    const executionId = this.executionLookup.getSessionExecution(sessionId);
    if (!executionId) return Promise.resolve();
    const key = `${kind}:${requestId}`;
    const requests = this.pending.get(sessionId) ?? new Map<string, string>();
    if (requests.has(key)) return this.updates.get(sessionId) ?? Promise.resolve();
    requests.set(key, executionId);
    this.pending.set(sessionId, requests);
    return this.project(sessionId, executionId);
  }

  finished(sessionId: number, kind: TaskWaitKind, requestId: string): Promise<void> {
    const key = `${kind}:${requestId}`;
    const requests = this.pending.get(sessionId);
    const executionId = requests?.get(key);
    if (executionId == null) return this.updates.get(sessionId) ?? Promise.resolve();
    requests!.delete(key);
    if (requests!.size === 0) this.pending.delete(sessionId);
    return this.project(sessionId, executionId);
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
}
