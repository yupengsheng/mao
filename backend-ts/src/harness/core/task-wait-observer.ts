export type TaskWaitKind = 'QUESTION' | 'APPROVAL';

export interface TaskWaitObserver {
  started(sessionId: number, kind: TaskWaitKind, requestId: string): void;
  finished(sessionId: number, kind: TaskWaitKind, requestId: string): void;
}
