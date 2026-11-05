import type { TaskSource, TaskStage } from '@mao/contracts';

export type { TaskSource, TaskStage };

export interface AgentTask {
  id?: number;
  userId: number;
  agentId?: number | null;
  sessionId: number;
  title: string;
  stage: TaskStage;
  source: TaskSource;
  policyVersion?: string | null;
  lastExecutionId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  deleted?: number;
}

export interface TaskExecution {
  id?: number;
  taskId: number;
  sessionId: number;
  executionId: string;
  attemptNo: number;
  status: TaskStage;
  startedAt?: string | null;
  finishedAt?: string | null;
  failureReason?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface TaskTrigger {
  id?: number;
  taskId: number;
  sessionId: number;
  source: TaskSource;
  sourceEventId: string;
  externalEventId?: string | null;
  externalEventScope?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 外部事件身份：由入口按已认证身份生成，不接受请求体可写字段。 */
export interface ExternalEventRef {
  id: string;
  scope: string;
}

export interface ExternalEventTrace {
  sessionId: number;
  executionId: string;
  status: TaskStage;
}

export interface BeginExecutionResult {
  execution: TaskExecution | null;
  duplicate: boolean;
}

export interface TaskPageFilter {
  userId: number;
  stage?: TaskStage | null;
  source?: TaskSource | null;
  agentId?: number | null;
  sessionId?: number | null;
  page: number;
  size: number;
}

export interface TaskPage {
  items: AgentTask[];
  total: number;
  page: number;
  size: number;
}

export interface TaskRepairCandidate {
  taskId: number;
  userId: number;
  sessionId: number;
}
