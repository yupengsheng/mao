import type { TaskSource, TaskStage } from './types.js';

const STAGES: readonly TaskStage[] = ['QUEUED', 'WORKING', 'BLOCKED', 'FAILED', 'COMPLETED', 'CANCELLED'];
const SOURCES: readonly TaskSource[] = ['MANUAL', 'SCHEDULED', 'WEBHOOK', 'API', 'SIGNAL', 'FEISHU', 'WEIXIN', 'DINGTALK'];

export const isTaskStage = (value: string): value is TaskStage => (STAGES as readonly string[]).includes(value);
export const isTaskSource = (value: string): value is TaskSource => (SOURCES as readonly string[]).includes(value);
