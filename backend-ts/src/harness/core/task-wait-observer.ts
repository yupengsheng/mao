import type { TaskWaitKind, TaskWaitReleaseReason } from '@mao/contracts';

export type { TaskWaitKind, TaskWaitReleaseReason } from '@mao/contracts';

export interface TaskWaitStartedInput {
  sessionId: number;
  kind: TaskWaitKind;
  requestId: string;
  /** 已脱敏的 JSON 摘要，规则见二期设计 §4.2。 */
  payloadSummary: string;
  /** 规范化原始请求的 SHA-256，只用于幂等与诊断。 */
  payloadDigest: string;
}

export interface TaskWaitObserver {
  started(input: TaskWaitStartedInput): void;
  finished(sessionId: number, kind: TaskWaitKind, requestId: string, reason: TaskWaitReleaseReason): void;
}
