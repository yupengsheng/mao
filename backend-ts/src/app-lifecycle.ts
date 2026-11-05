/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Db } from './db/db.js';
import type { AppConfig } from './config/app-config.js';
import type { AppContext } from './create-app.js';
import type { FastifyInstance } from 'fastify';

import { ScheduledTaskScheduler } from './schedule/scheduled-task.service.js';
import { readActiveBackendPort, readDeployLock } from './harness/core/deploy-lock.js';
import { WebhookDeliveryScheduler, DeliverySchedulerDbStore } from './notification/task/delivery.scheduler.js';
import { userMessagePreviewOf } from './notification/task/user-message-preview.js';
import { createSessionDetailUrlResolver } from './feishu/progress-card.js';
import { OutboundDeliveryScheduler } from './openapi/outbound-delivery.scheduler.js';
import { OutboundDeliveryCleanup } from './openapi/outbound-delivery.cleanup.js';
import { GenericHttpWebhookSender } from './openapi/generic-webhook-sender.js';
import { InboxCleanupScheduler } from './inbox/inbox.cleanup.js';
import { ScheduledTaskRunCleanupScheduler } from './schedule/run-cleanup.js';
import { EcpRenewScheduler } from './auth/ecp-renew.scheduler.js';
import { replayFeishuPendingMessage } from './feishu/pending-replay.js';
import { RuntimeCleanupScheduler } from './harness/runtime/runtime-cleanup-scheduler.js';
import { SubagentExecutionRecoveryService } from './harness/delegate/subagent-execution-recovery.service.js';
import { SubagentRecoveryCoordinator } from './harness/delegate/subagent-recovery-coordinator.js';
import { CrashRecoveryRunner } from './harness/core/crash-recovery-runner.js';
import { FeishuCardProgressListener } from './feishu/card-progress-listener.js';
import { DeployDrainWatcher } from './harness/core/deploy-drain-watcher.js';
import { createShutdownHandler } from './app-shutdown.js';
import { TaskRepository } from './task/task.repository.js';
import { TaskRecordRepairService } from './task/task-record-repair.service.js';
import { TaskExecutionRetentionService } from './task/task-execution-retention.service.js';
import { MysqlAuditLogRepository } from './audit/audit.repository.js';
import { AuditLogCleanup } from './audit/audit-log-cleanup.js';
import { InboundEventCleanup } from './channel/inbound-event-cleanup.js';
import {
  GROUP_MESSAGE_LOG_PENDING_RETENTION_DAYS,
  GROUP_MESSAGE_LOG_RETENTION_DAYS,
  GroupMessageLogCleanup,
} from './channel/group-message-log-cleanup.js';
import { FeishuP2pMessageCleanup } from './channel/feishu-p2p-message-cleanup.js';
import { LlmCallCleanup } from './usage/llm-call-cleanup.js';
import { SessionActivityCleanup } from './session/session-activity-cleanup.js';
import { SessionActivityRepository, SubagentExecutionRepository } from './session/activity.repository.js';
import { SessionCompactionEventCleanup } from './session/session-compaction-event-cleanup.js';
import { SessionCompactionEventRepository } from './session/session-compaction.repository.js';
import { SubagentExecutionCleanup } from './session/subagent-execution-cleanup.js';
import { MessageQueueCleanup } from './session/message-queue-cleanup.js';
import { SessionChannelMappingCleanup } from './session/session-channel-mapping-cleanup.js';
import { SessionChannelMappingRepository } from './session/session-channel-mapping.repository.js';
import { MessageQueueRepository } from './session/message-queue.repository.js';
import { AuthStateCleanup } from './auth/auth-state-cleanup.js';
import { MysqlFeishuOauthStateRepository } from './auth/feishu-oauth.repository.js';
import { MysqlEcpOauthStateRepository } from './auth/ecp-oauth.repository.js';
import { MysqlDingtalkOauthStateRepository } from './dingtalk/oauth.repository.js';
import { MysqlFeishuPendingBindingRepository } from './feishu/pending-binding.repository.js';
import { MysqlDingtalkPendingBindingRepository } from './dingtalk/pending-binding.repository.js';
import { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import { MysqlDingtalkMessageRepository } from './dingtalk/message.repository.js';
import { WeixinInboundMessageRepository } from './weixin/inbound-message.repository.js';
import { FeishuCardSnapshotCleanup } from './feishu/card-snapshot-cleanup.js';
import { MysqlFeishuCardSnapshotRepository } from './feishu/card-snapshot.repository.js';
import { DingtalkProgressCardCleanup } from './dingtalk/progress-card-cleanup.js';
import { MysqlDingtalkProgressCardRepository } from './dingtalk/progress-card.repository.js';
import { FeishuProgressCardCleanup } from './feishu/progress-card-cleanup.js';
import { MysqlFeishuProgressCardRepository } from './feishu/progress-card.repository.js';

export interface LifecycleDeps {
  app: FastifyInstance;
  db: Db;
  cfg: AppConfig;
  ctx: AppContext;
  [key: string]: any;
}

export interface LifecycleResult {
  closeApp: () => Promise<void>;
}

export function assembleLifecycle(deps: LifecycleDeps): LifecycleResult {
  const d = deps as any;
  const { app, db, cfg, ctx } = d;

  const scheduler = new ScheduledTaskScheduler(d.scheduledStore, d.scheduledService, () => {
    const active = readActiveBackendPort(cfg.app.harness.runtimeDir);
    if (active != null) return active === cfg.server.port;
    const lock = readDeployLock(cfg.app.harness.runtimeDir);
    if (lock != null && lock.oldPort === cfg.server.port) return false;
    return true;
  });
  scheduler.start();
  const deliveryScheduler = new WebhookDeliveryScheduler(
    new DeliverySchedulerDbStore(db),
    () => d.settingService.getNotificationTuningConfig(),
    d.notifCipher,
    d.senderRegistry,
  );
  const sessionDetailUrl = createSessionDetailUrlResolver({
    getSiteBaseUrl: () => d.settingService.getSiteBaseUrl(),
  });
  deliveryScheduler.setContextProvider({
    latestUserMessage: async (sessionId: number) => {
      const message = await d.sessionService.getLastUserMessage(sessionId);
      return userMessagePreviewOf(message?.content ?? null) || null;
    },
    sessionDetailUrl: async (sessionId: number) => (await sessionDetailUrl(sessionId)) ?? null,
  });
  deliveryScheduler.start();
  const outboundDeliveryScheduler = new OutboundDeliveryScheduler({
    deliveryRepo: d.outboundDeliveryRepo,
    subscriptionRepo: d.outboundSubscriptionRepo,
    cipher: d.notifCipher,
    sender: new GenericHttpWebhookSender(),
    auditRecorder: {
      recordDeliveryFailed: async (input: any) => {
        let userId: number | null = null;
        if (input.subscriptionId != null) {
          const subscription = await d.outboundSubscriptionRepo.findById(input.subscriptionId).catch(() => null);
          userId = subscription?.userId ?? null;
        }
        await d.auditService.record({
          action: 'EXECUTE',
          objectType: 'outbound.subscription',
          objectId: input.subscriptionId == null ? null : String(input.subscriptionId),
          userId,
          username: null,
          method: 'POST',
          path: `/v1/open/subscriptions/${input.subscriptionId}/deliveries`,
          ip: null,
          status: 502,
          success: 0,
          errorMessage: `出站投递终态失败 event=${input.event} url=${input.targetUrl} error=${input.error ?? ''}`,
        }).catch(() => undefined);
      },
    },
    execute: (fn: any) => d.agentExecutor.submit(fn),
  });
  outboundDeliveryScheduler.start();
  const outboundDeliveryCleanup = new OutboundDeliveryCleanup(d.outboundDeliveryRepo);
  outboundDeliveryCleanup.start();
  const inboxCleanupScheduler = new InboxCleanupScheduler(d.inboxCleanupStore);
  inboxCleanupScheduler.start();
  const scheduledRunCleanup = new ScheduledTaskRunCleanupScheduler(d.scheduledStore);
  scheduledRunCleanup.start();
  const taskRecordRepair = new TaskRecordRepairService(new TaskRepository(db));
  taskRecordRepair.start();
  const taskExecutionRetention = new TaskExecutionRetentionService(new TaskRepository(db));
  taskExecutionRetention.start();
  const auditLogCleanup = new AuditLogCleanup(
    new MysqlAuditLogRepository(db),
    () => d.settingService.getAuditRetentionDays(),
  );
  auditLogCleanup.start();
  const llmCallCleanup = new LlmCallCleanup(
    d.llmCallRepo,
    () => d.settingService.getLlmCallRetentionDays(),
  );
  llmCallCleanup.start();
  const sessionActivityCleanup = new SessionActivityCleanup(
    new SessionActivityRepository(db),
    () => d.settingService.getSessionActivityRetentionDays(),
  );
  sessionActivityCleanup.start();
  const sessionCompactionEventCleanup = new SessionCompactionEventCleanup(
    new SessionCompactionEventRepository(db),
  );
  sessionCompactionEventCleanup.start();
  const subagentExecutionCleanup = new SubagentExecutionCleanup(
    new SubagentExecutionRepository(db),
  );
  subagentExecutionCleanup.start();
  const messageQueueCleanup = new MessageQueueCleanup(
    new MessageQueueRepository(db),
  );
  messageQueueCleanup.start();
  const dingtalkProgressCardCleanup = new DingtalkProgressCardCleanup(
    new MysqlDingtalkProgressCardRepository(db),
  );
  dingtalkProgressCardCleanup.start();
  const feishuProgressCardCleanup = new FeishuProgressCardCleanup(
    new MysqlFeishuProgressCardRepository(db),
  );
  feishuProgressCardCleanup.start();
  const sessionChannelMappingCleanup = new SessionChannelMappingCleanup(
    new SessionChannelMappingRepository(db),
  );
  sessionChannelMappingCleanup.start();
  const feishuMessageRepo = new MysqlFeishuMessageRepository(db);
  const dingtalkMessageRepo = new MysqlDingtalkMessageRepository(db);
  const weixinMessageRepo = new WeixinInboundMessageRepository(db);
  const inboundEventCleanup = new InboundEventCleanup([
    { name: 'feishu', deleteBatch: (cutoff, limit) => feishuMessageRepo.deleteInboundBatch(cutoff, limit) },
    { name: 'dingtalk', deleteBatch: (cutoff, limit) => dingtalkMessageRepo.deleteInboundBatch(cutoff, limit) },
    { name: 'weixin', deleteBatch: (cutoff, limit) => weixinMessageRepo.deleteTerminalBatch(cutoff, limit) },
  ]);
  inboundEventCleanup.start();
  const groupMessageLogCleanup = new GroupMessageLogCleanup([
    {
      name: 'feishu_enriched',
      retentionDays: GROUP_MESSAGE_LOG_RETENTION_DAYS,
      deleteBatch: (cutoff, limit) => feishuMessageRepo.deleteEnrichedGroupMessageBatch(cutoff, limit),
    },
    {
      name: 'feishu_pending',
      retentionDays: GROUP_MESSAGE_LOG_PENDING_RETENTION_DAYS,
      deleteBatch: (cutoff, limit) => feishuMessageRepo.deleteStalePendingGroupMessageBatch(cutoff, limit),
    },
    {
      name: 'dingtalk',
      retentionDays: GROUP_MESSAGE_LOG_RETENTION_DAYS,
      deleteBatch: (cutoff, limit) => dingtalkMessageRepo.deleteGroupMessageBatch(cutoff, limit),
    },
  ]);
  groupMessageLogCleanup.start();
  const feishuP2pMessageCleanup = new FeishuP2pMessageCleanup({
    deleteBatch: (cutoff, limit) => feishuMessageRepo.deleteP2pMessageBatch(cutoff, limit),
  });
  feishuP2pMessageCleanup.start();
  const feishuCardSnapshotCleanup = new FeishuCardSnapshotCleanup(
    new MysqlFeishuCardSnapshotRepository(db),
  );
  feishuCardSnapshotCleanup.start();
  const feishuOauthStateRepo = new MysqlFeishuOauthStateRepository(db);
  const ecpOauthStateRepo = new MysqlEcpOauthStateRepository(db);
  const dingtalkOauthStateRepo = new MysqlDingtalkOauthStateRepository(db);
  const feishuPendingBindingRepo = new MysqlFeishuPendingBindingRepository(db);
  const dingtalkPendingBindingRepo = new MysqlDingtalkPendingBindingRepository(db);
  const authStateCleanup = new AuthStateCleanup([
    { name: 'feishu_oauth_state', deleteBatch: (cutoff, limit) => feishuOauthStateRepo.deleteBatch(cutoff, limit) },
    { name: 'ecp_oauth_state', deleteBatch: (cutoff, limit) => ecpOauthStateRepo.deleteBatch(cutoff, limit) },
    { name: 'dingtalk_oauth_state', deleteBatch: (cutoff, limit) => dingtalkOauthStateRepo.deleteBatch(cutoff, limit) },
    { name: 'feishu_pending_binding_message', deleteBatch: (cutoff, limit) => feishuPendingBindingRepo.deleteBatch(cutoff, limit) },
    { name: 'dingtalk_pending_binding_message', deleteBatch: (cutoff, limit) => dingtalkPendingBindingRepo.deleteBatch(cutoff, limit) },
  ]);
  authStateCleanup.start();
  d.callLogService.start();
  d.callLogCleanup.start();
  d.callLogRepair.start();
  const ecpRenewScheduler = new EcpRenewScheduler(
    d.ecpSessionRepo,
    () => d.settingService.getEcpConfig(),
    undefined,
    (token: string) => d.ecpSessionRepo.encryptToken(token),
  );
  ecpRenewScheduler.start();
  d.weixinMonitor.start();
  d.feishuMonitor.start();
  d.dingtalk.start();
  void d.pendingBindingMessages.listRecoverable().then(async (pending: any[]) => {
    for (const message of pending) {
      if (ctx.pendingBindingProcessor == null) return;
      const claimed = await d.pendingBindingMessages.claim(message.state);
      if (claimed == null) continue;
      try {
        await replayFeishuPendingMessage(ctx.pendingBindingProcessor, claimed);
        await d.pendingBindingMessages.complete(claimed.state);
      } catch (error) {
        await d.pendingBindingMessages.release(claimed.state);
        console.error(`恢复飞书待绑定消息失败, state=${claimed.state}`, error);
      }
    }
  }).catch((error: unknown) => console.error('恢复飞书待绑定消息列表失败', error));
  d.shellManager.startCleanup();
  d.terminalManager.startCleanup();
  const runtimeCleanup = new RuntimeCleanupScheduler(
    cfg.app.harness.runtimeDir,
    cfg.app.harness.cleanup,
    (_userId: number, sessionId: number) => d.wsHandler.hasExecutionClaim(sessionId),
  );
  runtimeCleanup.start();
  const subagentExecutionRecovery = new SubagentExecutionRecoveryService(
    d.subagentMapper, d.sessionMap, d.sessionSvc, d.compactionSvc, d.definitionRegistry,
    (childSession: any, definition: any) => d.backgroundSubagentManager.buildSubContext(childSession, definition),
    d.agentLoop, d.visibility, d.localToolSessions,
  );
  const subagentCoordinator = new SubagentRecoveryCoordinator(
    d.subagentMapper, subagentExecutionRecovery, d.subagentResultDelivery,
    d.sessionMap, d.sessionSvc, d.compactionSvc, d.agentExecutor,
  );
  const crash = new CrashRecoveryRunner(
    d.sessionMap, d.sessionSvc, d.taskTerminal, d.harness, d.agentLoop, d.wsRegistry,
    d.activityService as never, d.activityHeartbeat, d.todoMapper, d.modelRepo as never,
    cfg.app.harness.runtimeDir,
    d.agentExecutor,
    async (sessionId: number, userId: number, phase: string) => {
      await d.scheduledService.reconcileRunsForSession(sessionId, phase).catch((error: unknown) => {
        console.warn(`定时任务运行记录在崩溃恢复后收敛失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (phase !== 'FAILED') {
        void d.wsHandler.autoConsumeQueue(sessionId, userId);
        await d.feishuProgressCardRepo.deleteBySessionId(sessionId).catch((error: unknown) => {
          console.warn(`清理飞书进度卡片映射失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        });
        await d.feishuInboundHandler.drainNextIfPending(sessionId).catch((error: unknown) => {
          console.error(`飞书崩溃恢复后队列接力消费失败, sessionId=${sessionId}`, error);
        });
        await d.dingtalk.onCrashFinished(sessionId, phase).catch((error: unknown) => {
          console.error(`钉钉崩溃恢复后队列接力消费失败, sessionId=${sessionId}`, error);
        });
      }
    },
    subagentCoordinator,
    async (sessionId: number) => {
      const dingtalkRecovered = await d.dingtalk.recoverProgress(sessionId);
      if (dingtalkRecovered != null) return new FeishuCardProgressListener(dingtalkRecovered.progress, dingtalkRecovered.roundOffset);
      const recovered = await d.createFeishuRecoveryProgress(sessionId);
      return recovered == null ? null : new FeishuCardProgressListener(recovered.progress, recovered.roundOffset);
    },
    (sessionId: number) => d.agentLoop.getCancelFlag(sessionId) != null,
    cfg.server.port,
  );
  void crash.run().catch((e: unknown) => console.error('Crash recovery failed', e)).then(async () => {
    await d.dingtalk.hydrate().catch((error: unknown) => console.error('钉钉入站队列启动恢复失败', error));
    const sessionIds = await d.feishuTaskQueue.hydrate();
    for (const sessionId of sessionIds) {
      await d.feishuInboundHandler.drainNextIfPending(sessionId).catch((error: unknown) => {
        console.error(`飞书队列启动恢复消费失败, sessionId=${sessionId}`, error);
      });
    }
  }).catch((error: unknown) => console.error('飞书入站队列启动恢复失败', error));

  crash.startPeriodicSweep();

  const drainWatcher = new DeployDrainWatcher({
    runtimeDir: cfg.app.harness.runtimeDir,
    selfPort: cfg.server.port,
    startedAtSec: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
    shutdown: () => closeApp(),
  });

  const closeApp = createShutdownHandler({
    app, db, cfg, ctx,
    crash, drainWatcher,
    weixinMonitor: d.weixinMonitor, feishuMonitor: d.feishuMonitor, dingtalk: d.dingtalk,
    weixinInboundHandler: d.weixinInboundHandler, feishuInboundProcessor: d.feishuInboundProcessor,
    scheduler, deliveryScheduler, callLogService: d.callLogService, callLogCleanup: d.callLogCleanup, callLogRepair: d.callLogRepair,
    outboundDeliveryCleanup,
    watcherScheduler: d.watcherScheduler, signalCheckCleanup: d.signalCheckCleanup, ecpRenewScheduler,
    shellManager: d.shellManager, terminalManager: d.terminalManager,
    ptyChannelHubs: d.ptyChannelHubs, ptyHubGeneration: d.ptyHubGeneration,
    containerRegistry: d.containerRegistry, channelServer: d.channelServer, runtimeCleanup,
    activityHeartbeat: d.activityHeartbeat, wsRegistry: d.wsRegistry,
    agentLoop: d.agentLoop, wsHandler: d.wsHandler, sessionService: d.sessionService,
    taskRecordRepair, taskExecutionRetention, auditLogCleanup, llmCallCleanup, sessionActivityCleanup,
    sessionCompactionEventCleanup, subagentExecutionCleanup, messageQueueCleanup, dingtalkProgressCardCleanup, feishuProgressCardCleanup,
    sessionChannelMappingCleanup, inboundEventCleanup,
    authStateCleanup, groupMessageLogCleanup, feishuP2pMessageCleanup, feishuCardSnapshotCleanup,
  });
  drainWatcher.start();

  return { closeApp };
}
