import { randomUUID } from 'node:crypto';
import { harnessLog } from '../log.js';
import { AtomicBoolean } from '../atomic-boolean.js';
import { boolish, wsEvent } from '../deps.js';
import type {
  ActivityService, LlmModelMapper, Session, SessionActivityHeartbeat, SessionMapper,
  SessionService, StreamingWsRegistry, TaskTerminalService,
} from '../deps.js';
import type { AgentEventListener } from './agent-event-listener.js';
import type { AgentLoop } from './agent-loop.js';
import type { HarnessService } from './harness-service.js';
import { CompositeAgentEventListener } from './composite-agent-event-listener.js';
import type { SessionTodoMapper } from '../todo/session-todo.mapper.js';
import type { SubagentRecoveryCoordinator } from '../delegate/subagent-recovery-coordinator.js';
import type { ExecutionLeaseService, LeaseHandle } from '../../task/execution-lease.service.js';
import type { ExecutionWaitRecord, ExecutionWaitRepository } from '../../task/execution-wait.repository.js';
import type { TaskService } from '../../task/task.service.js';
import {
  deployDrainSec,
  isRecentDeployLock,
  isSessionActiveDuringDeploy,
  parseSqlDateTime,
  readActiveBackendPort,
  readDeployLock,
  shouldDeferAllRecoveryDuringDeploy,
} from './deploy-lock.js';
import { stripCitationMarkers } from '../../session/util/citation-markers.js';

export interface RecoveryExtraListener extends AgentEventListener {
  /** 恢复续跑被取消时的终态通知（如飞书进度卡片 PATCH「已取消」）。 */
  cancel?(interrupted?: boolean): Promise<boolean>;
  /** 恢复续跑成功结束时的终态通知（如飞书进度卡片 PATCH「已完成」）。 */
  complete?(finalContent: string): Promise<boolean>;
  /** 恢复续跑失败时的终态通知（如飞书进度卡片 PATCH「已失败」）。 */
  fail?(message: string): Promise<boolean>;
}

/** 任务域二期恢复依赖；未装配或开关关闭时保持旧的静默阈值恢复路径。 */
export interface CrashRecoveryDeps {
  executionLeaseService?: ExecutionLeaseService | null;
  executionWaitRepository?: ExecutionWaitRepository | null;
  taskService?: TaskService | null;
  ownerInstance?: string;
  executionLeaseEnabled?: boolean;
}

/** 等待超时后的固定失败原因，供恢复收敛与前端/CLI 展示。 */
export const EXECUTION_WAIT_EXPIRED_REASON = '等待用户处理超时，执行已终止';

export class CrashRecoveryRunner {
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private missingActivePortLogged = false;
  /**
   * 初始扫描时被推迟恢复的会话快照。蓝绿部署下延迟恢复首次只重放该快照，不重新扫描
   * DB——否则会把「重启后刚创建并正在活跃执行的会话」误判为崩溃遗留的 RUNNING 会话，
   * 对同一会话再次启动一次 harness 执行，造成消息重复执行。
   * 快照重放完成后（runPass 内）会触发一次全库补扫（deferredScan），此时部署窗口
   * 已过、旧实例已停，补扫兜住「窗口内新建、随后随旧实例排空死亡」的漏网会话。
   */
  private deferredCandidates: Session[] = [];
  /** 延迟恢复是否已完成快照后的全库补扫（仅补扫一次，避免把活跃会话误判为遗留）。 */
  private deferredScan = false;
  /**
   * 本实例正在恢复中的会话。延迟恢复的「快照重放」与随后的「全库补扫」两轮可能命中同一会话：
   * 首轮恢复已把 phase 置回 RUNNING，recoverSession 的 phase 重查无法识别，会对同一会话
   * 并发跑两次 harness 执行（同一批消息重复执行、终态互相覆盖）。
   */
  private readonly recovering = new Set<number>();
  /** 快照重放与全库补扫的间隔秒数：补扫前旧实例 drain 必须已收尾。 */
  private static readonly RESCAN_DELAY_SEC = 15;
  /**
   * 孤儿会话巡检间隔。启动期的一次性扫描（run/deferred）只能覆盖"扫描那一刻已存在"的
   * 遗留会话；会话可能是扫描窗口之后才在旧实例上进入 RUNNING 的（消息落到待排空实例），
   * 此时必须靠周期巡检兜住——它不依赖"旧实例几秒后死"这一时序假设。
   */
  private static readonly ORPHAN_SWEEP_INTERVAL_SEC = 30;
  /**
   * RUNNING 会话被判定为孤儿所需的静默时长。必须显著大于心跳间隔（30s），
   * 否则会把"另一实例正在执行、只是恰好未刷新"的会话抢过来重复执行。
   * RESUMING 是显式中断标记，不受此阈值约束。
   */
  private static readonly RUNNING_ORPHAN_STALE_SEC = 120;
  /**
   * RESUMING 会话被判定为孤儿所需的静默时长。标记方（排空中的旧实例）可能刚刚写入
   * RESUMING 而进程尚未退出，其执行的心跳仍在刷新 last_activity_at（`touchLastActivity`
   * 对 RUNNING/RESUMING 都会写）。阈值取得比心跳间隔（30s）大，确保"静默"意味着
   * 那个仍在收尾的实例真的没了，避免两边同时跑同一会话。
   */
  private static readonly RESUMING_ORPHAN_STALE_SEC = 45;
  /**
   * 巡检对"部署仍在进行"的让路上限 = 排空窗口 + 本余量。超过即认为 drain 脚本已异常
   * （例如没写成 `drained`），不再无限让路，否则孤儿会话会被压住 15 分钟。
   */
  private static readonly DEPLOY_SWEEP_GRACE_SEC = 60;
  /** deferred pass 被部署窗口推迟后的重试间隔（重试本身不查库，成本很低）。 */
  private static readonly DEFERRED_RETRY_DELAY_SEC = 15;
  /** 同一等待在单实例内只重推一次恢复通知；重复巡检只做幂等投影。 */
  private readonly notifiedRecoveredWaits = new Set<string>();

  constructor(
    private readonly sessionMapper: SessionMapper,
    private readonly sessionService: SessionService,
    private readonly taskTerminalService: TaskTerminalService,
    private readonly harnessService: HarnessService,
    private readonly agentLoop: AgentLoop,
    private readonly registry: StreamingWsRegistry,
    private readonly activityService: ActivityService,
    private readonly activityHeartbeat: SessionActivityHeartbeat,
    private readonly sessionTodoMapper: SessionTodoMapper,
    private readonly llmModelMapper: LlmModelMapper,
    private readonly runtimeDir: string,
    private readonly agentExecutor: { submit(fn: () => Promise<void>): void } = {
      submit: (fn) => { void fn(); },
    },
    private readonly onExecutionFinished?: (sessionId: number, userId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>,
    private readonly subagentCoordinator?: SubagentRecoveryCoordinator,
    /** 恢复续跑时的额外事件监听（如飞书进度卡片续更）；返回 null 表示该会话无需额外监听。 */
    private readonly createExtraListeners?: (sessionId: number, userId: number | null, executionId: string) => Promise<RecoveryExtraListener | null>,
    /**
     * 本实例内存中是否正在执行该会话（如 AgentLoop 已挂 cancel flag）。
     * 延迟全库补扫据此排除「本实例正常执行中」的会话——它们 phase 同样是 RUNNING，
     * 仅凭 DB 无法与崩溃遗留区分，不排除会对同一会话并发跑两次执行。
     */
    private readonly isSessionLocallyActive?: (sessionId: number) => boolean,
    /** 本实例监听的后端端口；与 active-backend-port 一致时才允许执行孤儿巡检。 */
    private readonly selfPort?: number,
    private readonly recoveryDeps?: CrashRecoveryDeps,
  ) {}

  async run(): Promise<void> {
    await this.runPass(false);
  }


  /**
   * 启动孤儿会话巡检。与启动期的一次性恢复不同，它周期性复查 DB，
   * 兜住"恢复扫描窗口之后才进入 RUNNING"的漏网会话（消息落到待排空实例的典型时序）。
   */
  startPeriodicSweep(): void {
    if (this.sweepTimer != null) return;
    this.sweepTimer = setInterval(() => {
      void this.sweepOrphans().catch((e) => harnessLog('error', 'Orphan session sweep failed', e));
    }, CrashRecoveryRunner.ORPHAN_SWEEP_INTERVAL_SEC * 1000);
    this.sweepTimer.unref?.();
  }

  /** 停止巡检；同时取消尚未触发的延迟恢复 pass，避免进程关闭后仍去访问已关闭的 DB。 */
  stopPeriodicSweep(): void {
    if (this.sweepTimer != null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.deferredTimer != null) {
      clearTimeout(this.deferredTimer);
      this.deferredTimer = null;
    }
  }

  /**
   * 孤儿会话巡检（单次）。
   * 只有承接流量的实例执行，且部署进行中必须让路——排空中的旧实例仍可能在跑会话，
   * 此时抢过来会并发重复执行。RESUMING 是"执行被中断、等待恢复"的显式标记，立即可恢复；
   * RUNNING 无法与"别的实例正在跑"区分，必须等静默超过阈值。
   */
  async sweepOrphans(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      if (!this.isActiveInstance()) return;
      if (this.isDeployBlockingSweep()) return;
      const blocked = await this.listCoordinatorBlocked();
      const candidates = await this.collectOrphanCandidates(blocked);
      if (candidates.length === 0) return;
      harnessLog('warn', `Found ${candidates.length} orphan session(s) outside deploy window, initiating recovery`);
      for (const session of candidates) this.agentExecutor.submit(() => this.recoverSession(session));
    } finally {
      this.sweeping = false;
    }
  }

  private isActiveInstance(): boolean {
    if (this.selfPort == null) return false;
    const active = readActiveBackendPort(this.runtimeDir);
    if (active != null) return active === this.selfPort;
    // 单实例/非蓝绿安装（start-backend.sh、Docker 首次启动）不写 active-backend-port：
    // 此时没有第二个实例可抢，允许照常巡检（部署窗口仍由 isDeployBlockingSweep 挡住）。
    // 缺失即停摆会让修复在单实例环境静默失效。
    const lock = readDeployLock(this.runtimeDir);
    if (lock != null && lock.oldPort === this.selfPort) {
      // 端口文件缺失时无法用 active-backend-port 判断谁是承接方；此时若本实例正是被替换掉的
      // 旧端口，就不能巡检，否则会与新实例并发重跑同一批会话（drain 脚本被跳过时会走到这里）。
      return false;
    }
    if (!this.missingActivePortLogged) {
      this.missingActivePortLogged = true;
      harnessLog('info', `active-backend-port missing under ${this.runtimeDir}; treating port ${this.selfPort} as the only instance for orphan sweep`);
    }
    return true;
  }

  /**
   * 巡检视角的"部署仍在进行"判定：超过排空窗口后不再无限让路。
   * drain 脚本异常时不会写 `drained`，状态可能永远停在 `switched`，
   * 若只按状态判断，孤儿巡检会被压住最长 `DEPLOY_LOCK_MAX_AGE_SEC`（15 分钟），
   * 用户侧就是"消息一直是没反应"。
   */
  private isDeployBlockingSweep(): boolean {
    const lock = readDeployLock(this.runtimeDir);
    if (!shouldDeferAllRecoveryDuringDeploy(lock)) return false;
    const elapsedSec = Math.floor(Date.now() / 1000) - (lock?.startedAt ?? 0);
    return elapsedSec <= deployDrainSec(lock) + CrashRecoveryRunner.DEPLOY_SWEEP_GRACE_SEC;
  }

  /** 只读查询被在途子代理执行占用的会话；查询失败按"无阻塞"处理，避免巡检整体失效。 */
  private async listCoordinatorBlocked(): Promise<Set<number>> {
    if (this.subagentCoordinator == null) return new Set<number>();
    try {
      return await this.subagentCoordinator.listBlockedSessionIds();
    } catch (e) {
      harnessLog('warn', 'Failed to list subagent-blocked sessions for orphan sweep', e);
      return new Set<number>();
    }
  }

  private async collectOrphanCandidates(blocked: Set<number>): Promise<Session[]> {
    const candidates = await this.collectCandidates(blocked, true);
    const now = Date.now();
    return candidates.filter((session) => {
      const threshold = session.phase === 'RESUMING'
        ? CrashRecoveryRunner.RESUMING_ORPHAN_STALE_SEC
        : CrashRecoveryRunner.RUNNING_ORPHAN_STALE_SEC;
      const last = parseSqlDateTime(session.lastActivityAt);
      if (last == null) return true;
      return (now - last.getTime()) / 1000 >= threshold;
    });
  }

  /**
   * 启动期一次性 pass（deferred=false）与部署后的延迟恢复 pass（deferred=true）。
   *
   * deferred pass（快照重放 + 全库补扫）必须等"旧实例确实已消失"才能执行：它的候选来自
   * 「部署窗口内仍活跃的会话」快照，而快照重放不做静默校验，若在旧实例仍存活时执行，
   * 就会与旧实例正在跑的执行并发重跑同一会话（补写 tool output + 双跑）。
   * 因此这里与孤儿巡检共用同一把闸门；被推迟时重新排期，不推进 deferredScan 阶段。
   */
  private async runPass(deferred: boolean): Promise<boolean> {
    if (deferred && (!this.isActiveInstance() || this.isDeployBlockingSweep())) {
      harnessLog(
        'info',
        `Postponing deferred crash recovery: deploy still in flight or this instance is not serving traffic (status=${readDeployLock(this.runtimeDir)?.status ?? 'none'})`,
      );
      this.scheduleDeferredRecovery(CrashRecoveryRunner.DEFERRED_RETRY_DELAY_SEC);
      return false;
    }
    const deployLock = readDeployLock(this.runtimeDir);
    const recentDeploy = isRecentDeployLock(deployLock);
    const deferAll = !deferred && shouldDeferAllRecoveryDuringDeploy(deployLock);
    const skipDeployActive = !deferred && recentDeploy;
    // 蓝绿部署窗口内不得执行子代理协调器恢复：协调器会直接 claim RUNNING 中的
    // 子代理 execution 并重跑父会话，绕过 deploy defer 守卫导致新旧实例对同一会话
    // 双实例并发执行。统一推迟到 deferred pass（此时 deployLock 已过窗口）。
    const deferCoordinator = !deferred && (deferAll || skipDeployActive);
    const blocked = !deferCoordinator && this.subagentCoordinator
      ? await this.subagentCoordinator.schedule((session) => this.recoverSession(session))
      : new Set<number>();
    // 延迟恢复分两步：首次 pass 只重放初始扫描快照（deferredScan=false），避免把
    // 重启后新建的活跃会话误判为崩溃遗留；第二次 pass（deferredScan=true，旧实例
    // drain 收尾后触发）做全库补扫，兜住「部署窗口内新建、随旧实例排空死亡」的会话。
    const candidates = deferred && !this.deferredScan
      ? this.deferredCandidates
      : await this.collectCandidates(blocked, deferred && this.deferredScan);
    const { recover, skipped } = deferAll
      ? { recover: [], skipped: candidates }
      : this.partitionForDeploy(candidates, skipDeployActive, deployLock);

    if (deferAll && candidates.length > 0) {
      // 快照被推迟的会话，供延迟恢复复用，避免重新扫描 DB 误抓重启后新建的活跃会话。
      this.deferredCandidates = candidates;
      harnessLog(
        'info',
        `Deferring crash recovery for ${candidates.length} session(s) during blue-green deploy (status=${deployLock?.status})`,
      );
    } else if (skipped.length > 0) {
      // 蓝绿部署中仍在排空实例上活跃的会话：记录快照，延迟恢复只重试这批，不重新全库扫描。
      this.deferredCandidates = skipped;
      harnessLog(
        'info',
        `Skipping crash recovery for ${skipped.length} session(s) still active on draining instance during blue-green deploy`,
      );
    }
    // 部署窗口内必须调度一次延迟恢复，哪怕初始扫描候选为空：会话可能在旧实例上创建、
    // 恰在 drain 时才随旧实例被 kill，新实例启动时刻扫描根本看不到它（phase 尚未写入），
    // 只有延迟恢复的全库补扫能兜住这类漏网会话。
    if (!deferred && recentDeploy) {
      this.scheduleDeferredRecovery(deployDrainSec(deployLock));
    }

    if (recover.length === 0) return true;
    const label = deferred ? 'deferred' : 'initial';
    harnessLog('warn', `Found ${recover.length} sessions stuck in RUNNING after restart, initiating ${label} recovery`);
    for (const session of recover) this.agentExecutor.submit(() => this.recoverSession(session));
    return true;
  }

  /**
   * 从 DB 收集崩溃遗留的 RUNNING/RESUMING/WAITING_APPROVAL 会话候选
   * （排除子代理、被协调器阻塞的会话），并按 session.id 去重。
   */
  private async collectCandidates(blocked: Set<number>, excludeLocallyActive = false): Promise<Session[]> {
    const running = this.sessionMapper.selectByPhase ? await this.sessionMapper.selectByPhase('RUNNING') : [];
    const resuming = this.sessionMapper.selectByPhase ? await this.sessionMapper.selectByPhase('RESUMING') : [];
    const waiting = this.sessionMapper.selectByPhase ? await this.sessionMapper.selectByPhase('WAITING_APPROVAL') : [];
    return [...running, ...resuming, ...waiting].filter((session, index, all) =>
      session.sessionType !== 'SUBAGENT'
      && session.id != null
      && !blocked.has(session.id)
      // 本实例已在恢复中的会话：其 phase 被恢复流程置为 RUNNING，重查无法与「崩溃遗留」区分
      && !this.recovering.has(session.id)
      // 全库补扫时排除本实例正常执行中的会话：它们 phase 同样为 RUNNING，但并非崩溃遗留，
      // 纳入会对同一会话并发跑两次 harness 执行。
      && !(excludeLocallyActive && this.isSessionLocallyActive?.(session.id) === true)
      && all.findIndex((item) => item.id === session.id) === index);
  }

  private partitionForDeploy(
    candidates: Session[],
    skipDeployActive: boolean,
    deployLock: ReturnType<typeof readDeployLock>,
  ): { recover: Session[]; skipped: Session[] } {
    if (!skipDeployActive || deployLock == null) {
      return { recover: candidates, skipped: [] };
    }
    const recover: Session[] = [];
    const skipped: Session[] = [];
    for (const session of candidates) {
      if (isSessionActiveDuringDeploy(session, deployLock)) skipped.push(session);
      else recover.push(session);
    }
    return { recover, skipped };
  }

  private scheduleDeferredRecovery(delaySec: number): void {
    if (this.deferredTimer != null) return;
    harnessLog('info', `Scheduling deferred crash recovery in ${delaySec}s after blue-green drain`);
    this.deferredTimer = setTimeout(() => {
      this.deferredTimer = null;
      // 第一步：重放初始扫描快照（此时 deferredScan 仍为 false，runPass 用快照作候选）。
      void this.runPass(true).then((ran) => {
        // 被推迟（部署仍在进行/本实例未承接流量）时不推进阶段：由 runPass 自行重新排期。
        if (!ran) return;
        // 第二步：快照重放完成后置位并延迟一轮全库补扫——此时旧实例 drain 已收尾，
        // 补扫才能安全捕获窗口内新建、随旧实例排空死亡但不在快照里的会话。
        if (!this.deferredScan) {
          this.deferredScan = true;
          this.deferredTimer = setTimeout(() => {
            this.deferredTimer = null;
            void this.runPass(true).catch((e) => harnessLog('error', 'Post-drain crash rescan failed', e));
          }, CrashRecoveryRunner.RESCAN_DELAY_SEC * 1000);
        }
      }).catch((e) => {
        harnessLog('error', 'Deferred crash recovery failed', e);
        // 异常也要重新排期：否则这次部署的补扫从此丢失（会话只能等下一轮重启）。
        this.scheduleDeferredRecovery(CrashRecoveryRunner.DEFERRED_RETRY_DELAY_SEC);
      });
    }, delaySec * 1000);
  }

  private async recoverSession(snapshot: Session): Promise<void> {
    const sessionId = snapshot.id!;
    // 同一实例内的恢复去重：延迟恢复的快照重放与全库补扫两轮可能命中同一会话，
    // 首轮已把 phase 置回 RUNNING，靠下面的 phase 重查无法拦住并发第二次执行。
    if (this.recovering.has(sessionId)) {
      harnessLog('info', `Skip recovery for session ${sessionId}: recovery already in flight`);
      return;
    }
    this.recovering.add(sessionId);
    try {
      await this.runRecovery(snapshot, sessionId);
    } finally {
      this.recovering.delete(sessionId);
    }
  }

  private async runRecovery(snapshot: Session, sessionId: number): Promise<void> {
    // 恢复前重查当前状态：候选来自启动时（或延迟恢复的初始）快照，蓝绿排空期间
    // 会话可能已被旧实例正常收尾进入终态，直接重放会把已完成会话误判为 FAILED。
    const current = await this.sessionMapper.selectById(sessionId);
    if (current == null || !['RUNNING', 'RESUMING', 'WAITING_APPROVAL'].includes(current.phase ?? '')) {
      harnessLog('info', `Skip recovery for session ${sessionId}: current phase=${current?.phase ?? 'deleted'}`);
      return;
    }
    if (this.isLeaseRecoveryEnabled()) {
      await this.runLeaseAwareRecovery(current, sessionId);
      return;
    }
    await this.runRecoveryExecution(current, sessionId, randomUUID(), null);
  }

  private isLeaseRecoveryEnabled(): boolean {
    return this.recoveryDeps?.executionLeaseEnabled === true
      && this.recoveryDeps.executionLeaseService != null;
  }

  /**
   * 租约感知恢复：先排除仍被其他实例持有的租约，再区分等待 / 过期 / 无等待三条路径。
   * 所有任务终态与阶段写入都复用同一次 claim 得到的 handle。
   */
  private async runLeaseAwareRecovery(session: Session, sessionId: number): Promise<void> {
    const deps = this.recoveryDeps!;
    const leases = deps.executionLeaseService!;
    const owner = deps.ownerInstance?.trim() ?? '';
    if (owner === '') {
      harnessLog('error', `Skip recovery for session ${sessionId}: execution lease owner is not configured`);
      return;
    }
    try {
      const active = await leases.getActive(sessionId);
      if (active != null) {
        harnessLog('info', `Skip recovery for session ${sessionId}: execution lease still active (executionId=${active.executionId})`);
        return;
      }
    } catch (e) {
      harnessLog('warn', `Skip recovery for session ${sessionId}: failed to read execution lease`, e);
      return;
    }

    const priorExecutionId = await this.resolvePriorExecutionId(session, sessionId);
    let waits: ExecutionWaitRecord[];
    try {
      waits = deps.executionWaitRepository == null
        ? []
        : await deps.executionWaitRepository.listPending(sessionId, priorExecutionId ?? undefined);
      if (waits.length === 0 && priorExecutionId != null && deps.executionWaitRepository != null) {
        // Task 主档可能已收敛而等待行仍挂在旧 attempt 上，按 session 再扫一次兜底。
        waits = await deps.executionWaitRepository.listPending(sessionId);
      }
    } catch (e) {
      // 读不到等待时不得无等待续跑，否则会绕过 PENDING 的权威门禁。
      harnessLog('warn', `Skip recovery for session ${sessionId}: failed to read pending waits`, e);
      return;
    }
    if (waits.length > 0) {
      await this.recoverWaitingExecution(session, sessionId, waits, priorExecutionId, owner);
      return;
    }
    await this.recoverWithoutWait(session, sessionId, owner);
  }

  private async resolvePriorExecutionId(session: Session, sessionId: number): Promise<string | null> {
    const deps = this.recoveryDeps;
    if (deps?.taskService != null && session.id != null) {
      try {
        // CrashRecoveryRunner 使用 harness 的宽松 Session 形状；任务域要求 userId 必填，
        // 进入恢复前 session 已从数据库重新读取，这里仅做类型收口。
        const executionId = await deps.taskService.getActiveExecutionId(session as never);
        if (executionId != null) return executionId;
      } catch (e) {
        harnessLog('warn', `Recovery: failed to resolve task execution for session ${sessionId}`, e);
      }
    }
    try {
      const record = await deps?.executionLeaseService?.getRecord(sessionId);
      return record?.executionId ?? null;
    } catch (e) {
      harnessLog('warn', `Recovery: failed to resolve lease execution for session ${sessionId}`, e);
      return null;
    }
  }

  private async recoverWaitingExecution(
    session: Session,
    sessionId: number,
    scanned: ExecutionWaitRecord[],
    priorExecutionId: string | null,
    owner: string,
  ): Promise<void> {
    const deps = this.recoveryDeps!;
    const leases = deps.executionLeaseService!;
    const store = deps.executionWaitRepository;
    if (store == null) {
      harnessLog('warn', `Skip waiting recovery for session ${sessionId}: wait repository is not configured`);
      return;
    }
    const executionId = priorExecutionId ?? scanned[0]?.executionId;
    if (executionId == null || executionId.trim() === '') return;

    let lease: LeaseHandle | null;
    try {
      lease = await leases.acquire(sessionId, executionId, owner);
    } catch (e) {
      harnessLog('warn', `Failed to claim lease for waiting session ${sessionId}`, e);
      return;
    }
    if (lease == null) {
      harnessLog('info', `Skip waiting recovery for session ${sessionId}: lease is held by another execution`);
      return;
    }

    try {
      const waits = await store.listPending(sessionId, executionId, lease.fencingToken);
      if (waits.length === 0) {
        // 扫描后等待已被用户处理：释放本次 claim，回到无等待续跑。
        await this.releaseLeaseQuietly(lease);
        await this.recoverWithoutWait(session, sessionId, owner);
        return;
      }
      const expired = waits.filter((wait) => wait.expired);
      const live = waits.filter((wait) => !wait.expired);
      for (const wait of expired) {
        try {
          await store.expire(wait.id, lease.fencingToken);
        } catch (e) {
          harnessLog('warn', `Failed to expire wait for session ${sessionId}: requestId=${wait.requestId}`, e);
        }
      }
      if (live.length === 0) {
        await this.failExpiredWait(session, sessionId, executionId, lease);
        return;
      }
      await this.projectRecoveredWait(session, sessionId, executionId, lease, live, store);
    } catch (e) {
      harnessLog('warn', `Waiting recovery failed for session ${sessionId}`, e);
    } finally {
      await this.releaseLeaseQuietly(lease);
    }
  }

  private async failExpiredWait(
    session: Session,
    sessionId: number,
    executionId: string,
    lease: LeaseHandle,
  ): Promise<void> {
    const userId = session.userId ?? null;
    try {
      await this.taskTerminalService.finishExecution(
        sessionId, userId, 'FAILED', executionId, EXECUTION_WAIT_EXPIRED_REASON, 'MANUAL', lease);
      harnessLog('info', `Session ${sessionId}: expired execution wait settled as FAILED`);
    } catch (e) {
      harnessLog('warn', `Failed to settle expired execution wait for session ${sessionId}`, e);
    }
    if (userId != null) {
      try {
        await this.onExecutionFinished?.(sessionId, userId, 'FAILED');
      } catch (e) {
        harnessLog('warn', `Auto-consume after expired wait failed for session ${sessionId}`, e);
      }
    }
  }

  private async projectRecoveredWait(
    session: Session,
    sessionId: number,
    executionId: string,
    lease: LeaseHandle,
    waits: ExecutionWaitRecord[],
    store: ExecutionWaitRepository,
  ): Promise<void> {
    const userId = session.userId ?? null;
    const phase = waits.some((wait) => wait.requestType === 'APPROVAL') ? 'WAITING_APPROVAL' : 'RUNNING';
    const taskService = this.recoveryDeps?.taskService;
    if (taskService != null) {
      try {
        await taskService.setExecutionStage(session as never, executionId, 'BLOCKED', lease);
      } catch (e) {
        harnessLog('warn', `Failed to project recovered wait as BLOCKED for session ${sessionId}`, e);
      }
    }
    try {
      await this.sessionService.updatePhase(sessionId, phase);
    } catch (e) {
      harnessLog('warn', `Failed to project recovered wait phase for session ${sessionId}`, e);
    }
    this.notifyClient(userId, sessionId, phase, executionId);

    // 只有本轮真正从“未恢复”标记成功的等待才推送；重复扫描沿用内存幂等，
    // 数据库标记失败则宁可不推，避免把可操作假象发给客户端。
    let newlyMarked = new Set<number>();
    try {
      const marked = await store.markRecovered(waits.map((wait) => wait.id), lease.fencingToken);
      newlyMarked = new Set(marked);
    } catch (e) {
      harnessLog('warn', `Failed to mark recovered waits for session ${sessionId}`, e);
    }

    let pushed = 0;
    for (const wait of waits) {
      if (userId == null) continue;
      if (!newlyMarked.has(wait.id)) continue;
      const key = `${sessionId}:${wait.requestId}`;
      if (this.notifiedRecoveredWaits.has(key)) continue;
      try {
        this.registry.send(userId, wsEvent('execution_wait_recovered', sessionId, {
          sessionId,
          executionId,
          requestId: wait.requestId,
          requestType: wait.requestType,
          summary: wait.payloadSummary,
          expiresAt: wait.expiresAt,
          recovered: true,
          actionable: false,
        }));
        this.notifiedRecoveredWaits.add(key);
        pushed += 1;
      } catch (e) {
        harnessLog('warn', `Failed to push recovered wait for session ${sessionId}: requestId=${wait.requestId}`, e);
      }
    }
    harnessLog(
      'info',
      `Session ${sessionId}: recovered ${waits.length} pending wait(s), marked=${newlyMarked.size}, phase=${phase}, pushed=${pushed}`,
    );
  }

  private async recoverWithoutWait(session: Session, sessionId: number, owner: string): Promise<void> {
    const leases = this.recoveryDeps?.executionLeaseService;
    if (leases == null) return;
    const executionId = randomUUID();
    let lease: LeaseHandle | null;
    try {
      lease = await leases.acquire(sessionId, executionId, owner);
    } catch (e) {
      harnessLog('warn', `Failed to claim recovery lease for session ${sessionId}`, e);
      return;
    }
    if (lease == null) {
      harnessLog('info', `Skip recovery for session ${sessionId}: lease is held by another execution`);
      return;
    }
    await this.runRecoveryExecution(session, sessionId, executionId, lease);
  }

  private async runRecoveryExecution(
    session: Session,
    sessionId: number,
    executionId: string,
    lease: LeaseHandle | null,
  ): Promise<void> {
    const userId = session.userId ?? null;
    let extra: RecoveryExtraListener | null = null;
    // 恢复续跑的实际终态：默认 FAILED，供收尾回调（onExecutionFinished）按终态决定队列是否接力消费。
    let terminalPhase: 'COMPLETED' | 'FAILED' | 'CANCELLED' = 'FAILED';
    try {
      const deleted = await this.sessionService.cleanupIncompleteTail(sessionId);
      if (deleted > 0) {
        harnessLog('info', `Session ${sessionId}: filled ${deleted} missing tool output(s)`);
      }
      await this.sessionService.updatePhase(sessionId, 'RESUMING');
      this.notifyClient(userId, sessionId, 'RUNNING', executionId);
      const cancelFlag = this.agentLoop.registerCancelFlag(sessionId);
      const { WsStreamingEventListener } = await import('../../session/ws/ws-streaming-event-listener.js');
      const listener = new WsStreamingEventListener({
        registry: this.registry as never,
        activityService: this.activityService as never,
        activityHeartbeat: this.activityHeartbeat,
        sessionTodoMapper: this.sessionTodoMapper,
        sessionService: this.sessionService as never,
      }, sessionId, userId ?? 0, executionId, await this.resolveSupportsVision(session));
      // 挂载额外监听（如飞书进度卡片）：失败不阻断恢复，仅丢失该次续跑的卡片续更。
      try {
        extra = await this.createExtraListeners?.(sessionId, userId, executionId) ?? null;
      } catch (e) {
        harnessLog('warn', `Recovery extra listener failed for session ${sessionId}`, e);
      }
      try {
        await this.taskTerminalService.beginRecoveryExecution(sessionId, executionId, lease);
      } catch (e) {
        // 任务记录不能阻断续跑；桥接层通常已吞掉存储异常，这里再兜住接口/装配异常。
        harnessLog('warn', `Recovery execution registration failed for session ${sessionId}`, e);
      }
      harnessLog('info', `Session ${sessionId}: starting recovery execution`);
      await this.sessionService.updatePhase(sessionId, 'RUNNING');
      this.notifyClient(userId, sessionId, 'RUNNING', executionId);
      const executionListener = extra == null ? listener as never : CompositeAgentEventListener.of(listener, extra);
      await this.harnessService.execute(sessionId, null, executionListener as never, cancelFlag, null, lease);
      if (cancelFlag.get()) {
        try { await extra?.cancel?.(); } catch (e) {
          harnessLog('warn', `Recovery extra cancel failed for session ${sessionId}`, e);
        }
        await this.taskTerminalService.finishExecution(sessionId, userId, 'CANCELLED', executionId, undefined, 'MANUAL', lease);
        terminalPhase = 'CANCELLED';
      } else {
        await this.taskTerminalService.finishExecution(sessionId, userId, 'COMPLETED', executionId, undefined, 'MANUAL', lease);
        terminalPhase = 'COMPLETED';
        // 成功终态必须 PATCH 飞书进度卡片：执行中的 round/tool 事件不会把卡片收成「已完成」，
        // 漏掉 complete 会让蓝绿/重启后续跑成功后卡片永久停在「正在处理」。
        try { await extra?.complete?.(await this.latestAssistantReply(sessionId)); } catch (e) {
          harnessLog('warn', `Recovery extra complete failed for session ${sessionId}`, e);
        }
      }
      harnessLog('info', `Session ${sessionId}: recovery completed`);
    } catch (e) {
      // 恢复续跑异常：额外监听（如飞书卡片）同步收到 FAILED 终态，避免停留在「正在处理」。
      const failMessage = (e as Error).message ?? 'Recovery failed';
      try {
        if (extra?.fail != null) await extra.fail(failMessage);
        else extra?.onError(e);
      } catch { /* extra 已尽力 */ }
      harnessLog('error', `Recovery failed for session ${sessionId}`, e);
      terminalPhase = 'FAILED';
      try {
        await this.taskTerminalService.finishExecution(
          sessionId, userId, 'FAILED', executionId, failMessage, 'MANUAL', lease);
      } catch { /* ignore */ }
    } finally {
      this.agentLoop.removeCancelFlag(sessionId);
      this.activityHeartbeat.clear(sessionId);
      await this.releaseLeaseQuietly(lease);
      if (userId != null) {
        try {
          await this.onExecutionFinished?.(sessionId, userId, terminalPhase);
        } catch (e) {
          harnessLog('warn', `Auto-consume after recovery failed for session ${sessionId}`, e);
        }
      }
    }
  }

  private async releaseLeaseQuietly(lease: LeaseHandle | null): Promise<void> {
    if (lease == null) return;
    try {
      await this.recoveryDeps?.executionLeaseService?.release(lease);
    } catch (e) {
      harnessLog('warn', `Failed to release recovery lease for session ${lease.sessionId}`, e);
    }
  }

  private notifyClient(userId: number | null, sessionId: number, phase: string, executionId?: string): void {
    if (userId == null) return;
    try {
      const isTerminal = phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
      const statusData: Record<string, unknown> = isTerminal ? { phase, unread: true } : { phase };
      // RUNNING 必须带上本次恢复执行的新 executionId：前端据此把陈旧的 activeExecutionId
      // 换掉，否则恢复执行的流式帧会被 isStaleExecution 当陈旧帧全部丢弃（进度卡住）。
      if (!isTerminal && executionId != null && executionId !== '') statusData.executionId = executionId;
      this.registry.send(userId, wsEvent('session_status', sessionId, statusData));
      this.registry.send(userId, wsEvent('session_list_update', sessionId, { phase }));
    } catch { /* client may not be connected */ }
  }

  private async latestAssistantReply(sessionId: number): Promise<string> {
    const messages = await this.sessionService.getMessages?.(sessionId) ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== 'ASSISTANT') continue;
      const text = this.sessionService.extractVisibleText?.(message.content ?? null) ?? message.content;
      if (text != null && text.trim() !== '') {
        // 渠道卡片不渲染来源区，[^n^] 标记原样露出会像没渲染干净的模板变量（与正常终态的
        // getLatestAssistantReply 同口径）
        return stripCitationMarkers(text);
      }
    }
    return '任务已完成。';
  }

  private async resolveSupportsVision(session: Session): Promise<boolean> {
    let model = session.modelId != null ? await this.llmModelMapper.selectById(session.modelId) : null;
    if (model == null && this.llmModelMapper.selectDefault) {
      model = await this.llmModelMapper.selectDefault();
    }
    return boolish(model?.supportsVision) === true;
  }
}
