import { formatDateTime } from '../common/json.js';
import type { OpenApiCallLogRepository } from './open-api-call-log.repository.js';
import type { OpenApiCallLogService } from './open-api-call-log.service.js';

export const OPEN_CALL_LOG_REPAIR_INTERVAL_MS = 60_000;
/** 与后台统计的 unknown 口径一致：超过 2 小时仍未收口才进入修复。 */
export const OPEN_CALL_LOG_REPAIR_STALE_MS = 2 * 60 * 60 * 1000;
export const OPEN_CALL_LOG_REPAIR_BATCH_SIZE = 100;

export interface OpenCallLogRepairOptions {
  intervalMs?: number;
  staleMs?: number;
  batchSize?: number;
  now?: () => Date;
}

/** 定期收敛长期滞留的开放接口调用流水，只处理能确定终态的记录。 */
export class OpenApiCallLogRepairService {
  private readonly intervalMs: number;
  private readonly staleMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private repairing = false;

  constructor(
    private readonly repo: OpenApiCallLogRepository,
    private readonly callLog: Pick<OpenApiCallLogService, 'settleStale'>,
    options: OpenCallLogRepairOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? OPEN_CALL_LOG_REPAIR_INTERVAL_MS;
    this.staleMs = options.staleMs ?? OPEN_CALL_LOG_REPAIR_STALE_MS;
    this.batchSize = options.batchSize ?? OPEN_CALL_LOG_REPAIR_BATCH_SIZE;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 修复一轮，返回实际收敛的流水数；扫描或单条修复异常只记录日志。 */
  async repairOnce(): Promise<number> {
    if (this.repairing) return 0;
    this.repairing = true;
    try {
      const cutoff = formatDateTime(new Date(this.now().getTime() - this.staleMs));
      const candidates = await this.repo.listRepairCandidates(cutoff, this.batchSize);
      let repaired = 0;
      for (const candidate of candidates) {
        try {
          if (await this.callLog.settleStale(candidate.id, cutoff)) repaired += 1;
        } catch (error) {
          console.warn(`[openapi] call log repair failed, id=${candidate.id}`, error);
        }
      }
      if (repaired > 0) {
        console.info(`[openapi] repaired ${repaired} stale call log(s)`);
      }
      return repaired;
    } catch (error) {
      console.warn('[openapi] call log repair scan failed', error);
      return 0;
    } finally {
      this.repairing = false;
    }
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.repairOnce().finally(() => this.scheduleNext(this.intervalMs));
    }, delayMs);
  }
}
