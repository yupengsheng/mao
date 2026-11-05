export type TaskStage = 'QUEUED' | 'WORKING' | 'BLOCKED' | 'FAILED' | 'COMPLETED' | 'CANCELLED';

export type TaskSource = 'MANUAL' | 'SCHEDULED' | 'WEBHOOK' | 'API' | 'SIGNAL' | 'FEISHU' | 'WEIXIN' | 'DINGTALK';

export type TaskWaitKind = 'QUESTION' | 'APPROVAL';

export type TaskWaitStatus = 'PENDING' | 'RELEASED' | 'EXPIRED';

export type TaskWaitReleaseReason = 'ANSWERED' | 'APPROVED' | 'DENIED' | 'CANCELLED' | 'TIMEOUT';

export interface TaskWaitVO {
  kind: TaskWaitKind;
  requestId: string;
  summary: string;
  expiresAt: string;
  /** 该等待是否来自崩溃恢复后的只读投影。 */
  recovered: boolean;
  /** 重启后旧 Promise 已丢失，固定为 false。 */
  actionable: boolean;
}

export interface AgentTaskVO {
  id: number;
  agentId: number | null;
  sessionId: number;
  title: string;
  stage: TaskStage;
  source: TaskSource;
  lastExecutionId: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TaskExecutionVO {
  id: number;
  taskId: number;
  sessionId: number;
  executionId: string;
  attemptNo: number;
  status: TaskStage;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: string | null;
  createdAt: string | null;
}

export interface TaskTriggerVO {
  id: number;
  taskId: number;
  sessionId: number;
  source: TaskSource;
  sourceEventId: string;
  /** 外部事件 ID（API Idempotency-Key / Webhook X-Mao-Event-Id）；非外部触发为 null。 */
  externalEventId: string | null;
  /** 外部事件作用域：token:<id> 或 trigger:<id>。 */
  externalEventScope: string | null;
  createdAt: string | null;
}

export interface TaskListQuery {
  stage?: TaskStage;
  source?: TaskSource;
  agentId?: number;
  sessionId?: number;
  page?: number;
  size?: number;
}

export interface TaskPageVO {
  items: AgentTaskVO[];
  total: number;
  page: number;
  size: number;
}

export interface TaskDetailVO {
  task: AgentTaskVO;
  latestExecution: TaskExecutionVO | null;
  executions: TaskExecutionVO[];
  triggers: TaskTriggerVO[];
  /** 仅当前执行的 PENDING 等待；历史执行不逐条携带。 */
  pendingWait: TaskWaitVO | null;
}
