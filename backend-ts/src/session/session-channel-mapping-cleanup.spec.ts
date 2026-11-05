import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE,
  SESSION_CHANNEL_MAPPING_CLEANUP_MAX_BATCHES,
  SessionChannelMappingCleanup,
} from './session-channel-mapping-cleanup.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function store(overrides: Partial<{
  deleteOrphanWeixinPeerBatch: ReturnType<typeof vi.fn>;
  deleteOrphanFeishuThreadBatch: ReturnType<typeof vi.fn>;
  deleteOrphanFeishuSessionChannelBatch: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    deleteOrphanWeixinPeerBatch: overrides.deleteOrphanWeixinPeerBatch ?? vi.fn(async () => 0),
    deleteOrphanFeishuThreadBatch: overrides.deleteOrphanFeishuThreadBatch ?? vi.fn(async () => 0),
    deleteOrphanFeishuSessionChannelBatch: overrides.deleteOrphanFeishuSessionChannelBatch ?? vi.fn(async () => 0),
  };
}

describe('SessionChannelMappingCleanup', () => {
  it('逐表分批清理并累加删除数量', async () => {
    const s = store({
      deleteOrphanWeixinPeerBatch: vi.fn()
        .mockResolvedValueOnce(SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE)
        .mockResolvedValueOnce(7),
      deleteOrphanFeishuThreadBatch: vi.fn(async () => 3),
      deleteOrphanFeishuSessionChannelBatch: vi.fn(async () => 2),
    });
    const cleanup = new SessionChannelMappingCleanup(s);

    await expect(cleanup.cleanupOnce()).resolves.toBe(SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE + 7 + 3 + 2);

    expect(s.deleteOrphanWeixinPeerBatch).toHaveBeenCalledTimes(2);
    expect(s.deleteOrphanWeixinPeerBatch).toHaveBeenNthCalledWith(1, SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE);
    expect(s.deleteOrphanWeixinPeerBatch).toHaveBeenNthCalledWith(2, SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE);
  });

  it('单表单轮最多 20 批', async () => {
    const s = store({
      deleteOrphanFeishuThreadBatch: vi.fn(async () => SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE),
    });
    const cleanup = new SessionChannelMappingCleanup(s);

    await expect(cleanup.cleanupOnce()).resolves.toBe(
      SESSION_CHANNEL_MAPPING_CLEANUP_BATCH_SIZE * SESSION_CHANNEL_MAPPING_CLEANUP_MAX_BATCHES,
    );

    expect(s.deleteOrphanFeishuThreadBatch).toHaveBeenCalledTimes(SESSION_CHANNEL_MAPPING_CLEANUP_MAX_BATCHES);
  });

  it('单表异常不阻断其它表', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = store({
      deleteOrphanWeixinPeerBatch: vi.fn(async () => { throw new Error('boom'); }),
      deleteOrphanFeishuThreadBatch: vi.fn(async () => 4),
      deleteOrphanFeishuSessionChannelBatch: vi.fn(async () => 5),
    });
    const cleanup = new SessionChannelMappingCleanup(s);

    await expect(cleanup.cleanupOnce()).resolves.toBe(9);

    expect(error).toHaveBeenCalledWith(expect.stringContaining('weixin_session_peer'));
    expect(s.deleteOrphanFeishuThreadBatch).toHaveBeenCalledTimes(1);
    expect(s.deleteOrphanFeishuSessionChannelBatch).toHaveBeenCalledTimes(1);
  });

  it('start 幂等、按小时触发，stop 后不再执行', async () => {
    vi.useFakeTimers();
    const s = store();
    const cleanup = new SessionChannelMappingCleanup(s);
    cleanup.start();
    cleanup.start();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(s.deleteOrphanWeixinPeerBatch).toHaveBeenCalledTimes(1);

    cleanup.stop();
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(s.deleteOrphanWeixinPeerBatch).toHaveBeenCalledTimes(1);
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(s.deleteOrphanWeixinPeerBatch).toHaveBeenCalledTimes(1);
  });

  it('同一轮未结束时跳过后续触发', async () => {
    let release!: (count: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const s = store({ deleteOrphanWeixinPeerBatch: vi.fn().mockReturnValueOnce(first).mockResolvedValue(0) });
    const cleanup = new SessionChannelMappingCleanup(s);

    const running = cleanup.cleanupOnce();
    await expect(cleanup.cleanupOnce()).resolves.toBe(0);
    expect(s.deleteOrphanWeixinPeerBatch).toHaveBeenCalledTimes(1);
    release(0);
    await expect(running).resolves.toBe(0);
  });
});
