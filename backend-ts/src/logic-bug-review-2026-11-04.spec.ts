/**
 * 2026-11-04 逻辑 BUG 审查的回归用例（移植自参考仓库 435b533）。
 *
 * 覆盖六项修复：进程时区、审批 denylist 绝对路径/512 截断绕过、价格失败缓存、
 * 环境变量失败缓存、grep_search 负参数。任何修复回退都会在此显红。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// 与 main.ts 入口同款：先把进程时区对齐到 Asia/Shanghai（生产修复机制本身）
import './config/process-timezone.js';
import {
  APPROVAL_RULE_DENY_TOKENS_SEED,
  buildApprovalHint,
  containsDenyToken,
} from './approval-rule/approval-rule-normalize.js';
import { currentPeriodLabel, monthStartLocal } from './budget/budget.service.js';
import { EnvVariableService } from './env/env-variable.service.js';
import type { EnvVariableRepository } from './env/types.js';
import { GrepSearchTool } from './harness/tool/impl/grep-search-tool.js';
import { PathSandbox } from './harness/safety/path-sandbox.js';
import { LlmCallService } from './usage/llm-call.service.js';

describe('预算月度窗口时区', () => {
  // 北京时间 2026-11-01 02:00 = UTC 2026-10-31 18:00：未对齐时 getMonth 取 UTC 的 10 月
  it('月初边界时刻 since 应为上海 11 月初，而非宿主本地月的 10 月初', () => {
    const boundary = new Date('2026-11-01T02:00:00+08:00');
    expect(monthStartLocal(boundary)).toBe('2026-11-01 00:00:00');
  });

  it('同一时刻的 period 标签也应为上海 11 月', () => {
    const boundary = new Date('2026-11-01T02:00:00+08:00');
    expect(currentPeriodLabel(boundary)).toBe('2026-11');
  });
});

describe('denylist 绝对路径绕过', () => {
  // seed 中的 '-rf' 会命中 '/bin/rm -rf' 的第二 token，掩盖 basename 缺失；
  // 需用无 '-rf' 的命令隔离：'/bin/rm x' 或 '/usr/bin/sudo'。
  it('containsDenyToken 应识别 /bin/rm（无 -rf 时）', () => {
    expect(containsDenyToken('/bin/rm /tmp/victim', APPROVAL_RULE_DENY_TOKENS_SEED)).toBe(true);
  });

  it('containsDenyToken 应识别 /usr/bin/sudo', () => {
    expect(containsDenyToken('/usr/bin/sudo apt update', APPROVAL_RULE_DENY_TOKENS_SEED)).toBe(true);
  });

  it('buildApprovalHint 对 /bin/rm 应返回 null（不可放行）', () => {
    expect(buildApprovalHint('shell', '{"command":"/bin/rm /tmp/victim"}', APPROVAL_RULE_DENY_TOKENS_SEED)).toBeNull();
  });
});

describe('denylist 512 截断绕过', () => {
  it('长命令中 rm 在 512 之后时 buildApprovalHint 必须为 null', () => {
    const cmd = `echo ${'a'.repeat(600)} ; rm -rf /tmp/x`;
    expect(cmd.indexOf('rm')).toBeGreaterThan(512);
    expect(buildApprovalHint('shell', JSON.stringify({ command: cmd }), APPROVAL_RULE_DENY_TOKENS_SEED)).toBeNull();
  });
});

describe('价格兜底异常负缓存', () => {
  it('lookup 抛异常时不应把 null 写进价格缓存（60s 内后续调用仍应重试）', async () => {
    let calls = 0;
    const svc = new LlmCallService(
      { insert: vi.fn(async () => 1) } as never,
      undefined,
      undefined,
      async () => {
        calls++;
        if (calls === 1) throw new Error('DB connection jitter');
        return { priceInput: 1, priceCacheRead: 1, priceCacheWrite: 1, priceOutput: 1 };
      },
    );
    const base = {
      modelConfig: { id: 42, modelId: 'm-42' },
      stream: false,
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } as never,
      success: true,
      errorMessage: null,
      firstTokenMs: null,
      durationMs: 10,
      retryCount: 0,
      systemPrompt: null,
      toolsJson: null,
    };
    // 第一次：lookup 抛异常 → costMicros 应为 null，且不可缓存
    await svc.record(base);
    // 第二次（同一进程、60s 窗口内）：lookup 恢复，costMicros 应非 null
    await svc.record(base);
    const inserted = (svc as unknown as { repo: { insert: ReturnType<typeof vi.fn> } }).repo.insert.mock.calls;
    const secondCost = inserted[1]?.[0]?.costMicros;
    expect(secondCost).not.toBeNull();
    expect(calls).toBe(2);
  });
});

describe('环境变量失败缓存', () => {
  it('listUser 失败时不应把空数组写进缓存（5s 内后续 resolve 仍应拿到变量）', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mao-env-bug-'));
    try {
      let userCalls = 0;
      const { encryptAesCbc } = await import('./crypto/aes-cbc.js');
      const secret = 'test-secret-1234567890123456';
      const goodRow = {
        id: 1,
        userId: 7,
        envKey: 'MY_API_KEY',
        envValue: encryptAesCbc('sk-test', secret),
        note: null,
      };
      const repo = {
        listSystem: vi.fn(async () => []),
        listUser: vi.fn(async () => {
          userCalls++;
          if (userCalls === 1) throw new Error('db jitter');
          return [goodRow];
        }),
        listWorkspace: vi.fn(async () => []),
      } as unknown as EnvVariableRepository;
      const svc = new EnvVariableService(
        repo,
        secret,
        tmp,
        { shellEnvVarsEnabled: async () => true },
        undefined,
      );
      const first = await svc.resolveForSession(7, tmp);
      // 第一次失败 → {} 可接受；关键是第二次必须重试查库并注入变量，
      // 不能因缓存了 [] 而直接返回 {}
      const second = await svc.resolveForSession(7, tmp);
      expect(first).toEqual({});
      expect(second.MY_API_KEY).toBe('sk-test');
      expect(userCalls).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('grep_search 负数参数', () => {
  it('max_output_chars=-10 应报错，而非返回干净的「0 命中」', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mao-grep-neg-'));
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'a.txt'), 'hello');
      const tool = new GrepSearchTool(new PathSandbox(root));
      const out = JSON.parse(await tool.execute(
        JSON.stringify({ pattern: 'hello', path: root, max_output_chars: -10 }), root,
      )) as { error?: string; matches?: unknown[]; total_matches?: number };
      expect(out.error).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
