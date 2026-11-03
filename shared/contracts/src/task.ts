export type TaskStage = 'QUEUED' | 'WORKING' | 'BLOCKED' | 'FAILED' | 'COMPLETED' | 'CANCELLED';

export type TaskSource = 'MANUAL' | 'SCHEDULED' | 'WEBHOOK' | 'API' | 'SIGNAL' | 'FEISHU' | 'WEIXIN' | 'DINGTALK';

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
}
