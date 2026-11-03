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
  createdAt?: string | null;
  updatedAt?: string | null;
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
